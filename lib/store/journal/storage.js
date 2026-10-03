// File-level journal operations (F8). Layout, durability and retention are documented in policy.js.
// Reads never take the lock and tolerate a torn last line; every write helper here must be called under the
// repository lock (runJournaledMutation, rebuildJournalIndex and pruneJournal take care of that).
import { join } from 'node:path';
import { isUlid } from '../../schemas/common.js';
import { SNAPSHOT_PATTERN } from '../../schemas/common.js';
import { canonicalizeJson, decodeJsonl, encodeJsonlRecord, parseStrictJson } from '../canonical/index.js';
import {
  appendFileDurable,
  ensureOpsDirectory,
  inspectOpsDirectory,
  listDirectory,
  locateOps,
  readTextIfExists,
  removeFile,
  repairTornTail,
  writeFileAtomic,
  writeFileDurable,
} from '../ops-files.js';
import { JournalCorruptError } from './errors.js';
import {
  JOURNAL_DIRECTORY,
  JOURNAL_DISPLAY_PATH,
  JOURNAL_INDEX_SCHEMA,
  JOURNAL_PENDING_SCHEMA,
} from './policy.js';
import { OP_SPEC, validateOpRecord } from './record.js';

const INDEX_SPEC = Object.freeze({ keys: ['schema', 'replay_key', 'request_id'], arrays: {}, objects: {} });
const PENDING_SPEC = Object.freeze({ keys: ['schema', 'request_id', 'transaction'], arrays: {}, objects: {} });
const SCAN_BATCH = 32;

export const journalSegments = [JOURNAL_DIRECTORY];
export const opsSegments = [JOURNAL_DIRECTORY, 'ops'];
export const indexSegments = [JOURNAL_DIRECTORY, 'by-key'];
export const pendingSegments = [JOURNAL_DIRECTORY, 'pending'];

export const locateJournal = locateOps;

export function checkRequestId(value) {
  if (!isUlid(value)) throw new TypeError('requestId must be a ULID');
  return value;
}

const displayOp = (requestId) => `${JOURNAL_DISPLAY_PATH}/ops/${requestId}.jsonl`;
const hex = (hash) => hash.slice('sha256:'.length);

// ---- reading ---------------------------------------------------------------------------------------------
const TRANSITIONS = {
  start: ['prepared'],
  prepared: ['prepared', 'committed', 'failed'],
  failed: ['prepared'],
  committed: [],
};

// Parses and verifies one op file. Returns null when there is no complete record. Corruption throws.
export function parseOpText(text, requestId) {
  const display = displayOp(requestId);
  const corrupt = (reason) => new JournalCorruptError(display, reason);
  // A last line without its newline is a torn append: it never happened.
  const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
  if (complete === '') return null;
  const decoded = decodeJsonl(complete, () => OP_SPEC);
  if (!decoded.ok) {
    const [first] = decoded.issues;
    throw corrupt(`line ${first.line ?? '?'}: ${first.code}`);
  }
  const records = [];
  let position = 'start';
  for (const { value, state, line } of decoded.records) {
    if (state !== 'declared') throw corrupt(`line ${line}: record hash does not match its content`);
    const verdict = validateOpRecord(value);
    if (!verdict.ok) throw corrupt(`line ${line}: ${verdict.issues[0].path} ${verdict.issues[0].code}`);
    if (value.request_id !== requestId) throw corrupt(`line ${line}: record belongs to another request`);
    if (!TRANSITIONS[position].includes(value.state)) throw corrupt(`line ${line}: ${value.state} cannot follow ${position}`);
    if (records.length > 0 && value.request_hash !== records[0].request_hash) {
      throw corrupt(`line ${line}: request hash changed between attempts`);
    }
    position = value.state;
    records.push(value);
  }
  const last = records.at(-1);
  return {
    status: last.state,
    request_id: requestId,
    request_hash: records[0].request_hash,
    records,
    last,
    committed: last.state === 'committed' ? last : null,
  };
}

// null = no op file (or only torn bytes).
export async function readOpFile(location, requestId) {
  checkRequestId(requestId);
  const directory = await inspectOpsDirectory(location, opsSegments);
  if (directory === null) return null;
  const text = await readTextIfExists(join(directory, `${requestId}.jsonl`));
  return text === null ? null : parseOpText(text, requestId);
}

async function opNames(location) {
  const directory = await inspectOpsDirectory(location, opsSegments);
  const names = (await listDirectory(directory)).filter((name) => name.endsWith('.jsonl'));
  return names.map((name) => name.slice(0, -'.jsonl'.length)).filter((name) => isUlid(name));
}

// Reads every op (bounded concurrency). A file removed between listing and reading is skipped.
export async function readAllOps(location) {
  const names = await opNames(location);
  const ops = [];
  for (let start = 0; start < names.length; start += SCAN_BATCH) {
    const batch = await Promise.all(names.slice(start, start + SCAN_BATCH).map((name) => readOpFile(location, name)));
    for (const op of batch) if (op !== null) ops.push(op);
  }
  return ops;
}

export const countOps = async (location) => (await opNames(location)).length;

const newest = (left, right) => {
  const a = left.committed;
  const b = right.committed;
  if (a.ts !== b.ts) return a.ts < b.ts ? right : left;
  return a.id < b.id ? right : left;
};

export function latestCommitted(ops, predicate) {
  let best = null;
  for (const op of ops) {
    if (op.committed === null || !predicate(op.committed)) continue;
    best = best === null ? op : newest(best, op);
  }
  return best;
}

// ---- the replay-key index --------------------------------------------------------------------------------
const DIRTY_FILE = 'index.dirty';

// { state: 'valid', request_id } | { state: 'missing' } | { state: 'unusable' }
async function probeIndexEntry(location, replayKey) {
  const directory = await inspectOpsDirectory(location, indexSegments);
  if (directory === null) return { state: 'missing' };
  const text = await readTextIfExists(join(directory, `${hex(replayKey)}.json`));
  if (text === null) return { state: 'missing' };
  const parsed = parseStrictJson(text);
  const value = parsed.ok ? parsed.value : null;
  const valid = value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join() === 'replay_key,request_id,schema'
    && value.schema === JOURNAL_INDEX_SCHEMA && value.replay_key === replayKey && isUlid(value.request_id);
  return valid ? { state: 'valid', request_id: value.request_id } : { state: 'unusable' };
}

export async function writeIndexEntry(location, replayKey, requestId) {
  const directory = await ensureOpsDirectory(location, indexSegments);
  await writeFileAtomic(
    join(directory, `${hex(replayKey)}.json`),
    canonicalizeJson({ schema: JOURNAL_INDEX_SCHEMA, replay_key: replayKey, request_id: requestId }, INDEX_SPEC),
  );
}

// The dirty flag brackets "committed record appended, index not written yet" (JOURNAL_POLICY.layout.dirty).
export async function markIndexDirty(location, requestId) {
  const directory = await ensureOpsDirectory(location, journalSegments);
  await writeFileDurable(join(directory, DIRTY_FILE), `${requestId}\n`);
}

export async function clearIndexDirty(location) {
  const directory = await inspectOpsDirectory(location, journalSegments);
  if (directory !== null) await removeFile(join(directory, DIRTY_FILE));
}

async function isIndexDirty(location) {
  const directory = await inspectOpsDirectory(location, journalSegments);
  return directory !== null && (await listDirectory(directory)).includes(DIRTY_FILE);
}

// A missing entry is trusted ("no committed op for this key") only while the index is known to be complete:
// no dirty flag, and the by-key directory exists whenever ops exist. Anything else means the index may have lost
// an entry (crash between the committed record and the index write, or a removed directory), so ops/* is scanned.
async function indexMayBeIncomplete(location) {
  if (await isIndexDirty(location)) return true;
  if ((await inspectOpsDirectory(location, indexSegments)) !== null) return false;
  return (await countOps(location)) > 0;
}

// Newest committed op for a replay key: the index entry when it checks out, otherwise (damaged or possibly
// incomplete index) a scan of ops/*. `repair` (only under the lock) rewrites the entry the scan found.
export async function lookupByReplayKey(location, replayKey, { repair = false } = {}) {
  if (!SNAPSHOT_PATTERN.test(replayKey)) throw new TypeError('replayKey must be a sha256 hash');
  const probe = await probeIndexEntry(location, replayKey);
  if (probe.state === 'valid') {
    const op = await readOpFile(location, probe.request_id);
    if (op?.committed?.replay_key === replayKey) return op;
  }
  if (probe.state === 'missing' && !(await indexMayBeIncomplete(location))) return null;
  if ((await inspectOpsDirectory(location, opsSegments)) === null) return null;
  const found = latestCommitted(await readAllOps(location), (record) => record.replay_key === replayKey);
  if (found !== null && repair) await writeIndexEntry(location, replayKey, found.request_id);
  return found;
}

// Repairs a missing or unusable entry for an op that was found by request ID; never overrides a usable one.
export async function ensureIndexEntry(location, record) {
  const probe = await probeIndexEntry(location, record.replay_key);
  if (probe.state === 'valid') {
    const op = await readOpFile(location, probe.request_id);
    if (op?.committed?.replay_key === record.replay_key) return false;
  }
  await writeIndexEntry(location, record.replay_key, record.request_id);
  return true;
}

export async function rebuildIndexFiles(location) {
  const directory = await inspectOpsDirectory(location, indexSegments);
  for (const name of await listDirectory(directory)) await removeFile(join(directory, name));
  const latest = new Map();
  for (const op of await readAllOps(location)) {
    if (op.committed === null) continue;
    const key = op.committed.replay_key;
    const current = latest.get(key);
    latest.set(key, current === undefined ? op : newest(current, op));
  }
  if ((await inspectOpsDirectory(location, opsSegments)) !== null) await ensureOpsDirectory(location, indexSegments);
  for (const [key, op] of [...latest].sort(([a], [b]) => (a < b ? -1 : 1))) await writeIndexEntry(location, key, op.request_id);
  await clearIndexDirty(location);
  return latest.size;
}

// Under the lock, before anything reads the index: a crash left the flag, so the index is rebuilt once.
export async function settleIndex(location) {
  if (await isIndexDirty(location)) await rebuildIndexFiles(location);
}

// ---- writing state records -------------------------------------------------------------------------------
export async function appendOpRecord(location, record) {
  const directory = await ensureOpsDirectory(location, opsSegments);
  const path = join(directory, `${record.request_id}.jsonl`);
  await repairTornTail(path);
  const line = encodeJsonlRecord(record, OP_SPEC);
  await appendFileDurable(path, line);
  return JSON.parse(line);
}

// ---- pending transaction markers -------------------------------------------------------------------------
export async function writePendingMarker(location, requestId, transaction) {
  const directory = await ensureOpsDirectory(location, pendingSegments);
  await writeFileAtomic(
    join(directory, `${requestId}.json`),
    canonicalizeJson({ schema: JOURNAL_PENDING_SCHEMA, request_id: requestId, transaction }, PENDING_SPEC),
  );
}

export async function removePendingMarker(location, requestId) {
  const directory = await inspectOpsDirectory(location, pendingSegments);
  if (directory !== null) await removeFile(join(directory, `${requestId}.json`));
}

function parsePending(name, text) {
  const display = `${JOURNAL_DISPLAY_PATH}/pending/${name}`;
  const parsed = parseStrictJson(text);
  const value = parsed.ok ? parsed.value : null;
  const valid = value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join() === 'request_id,schema,transaction'
    && value.schema === JOURNAL_PENDING_SCHEMA && isUlid(value.request_id) && isUlid(value.transaction)
    && `${value.request_id}.json` === name;
  if (!valid) throw new JournalCorruptError(display, 'pending marker is not a valid akrs.op-pending/v1 record');
  return value;
}

// Markers are a superset of the unresolved transactions; each one is verified against its op file and a stale
// one (the op finished, or never got its prepared record) is deleted.
export async function listUnresolved(location) {
  const directory = await inspectOpsDirectory(location, pendingSegments);
  const unresolved = [];
  for (const name of (await listDirectory(directory)).filter((entry) => entry.endsWith('.json'))) {
    const text = await readTextIfExists(join(directory, name));
    if (text === null) continue;
    const marker = parsePending(name, text);
    const op = await readOpFile(location, marker.request_id);
    if (op !== null && op.status === 'prepared' && op.last.transaction === marker.transaction) {
      unresolved.push({ request_id: marker.request_id, transaction: marker.transaction, record: op.last });
    } else {
      await removeFile(join(directory, name));
    }
  }
  return unresolved;
}

// ---- retention -------------------------------------------------------------------------------------------
// Returns { removed: [request ids], kept: number }. See JOURNAL_POLICY.retention_rule.
export async function pruneOps(location, {
  maxOps, maxAgeMs, nowMs, protect = null, stride = 1,
}) {
  const total = await countOps(location);
  if (total <= maxOps || total % stride !== 0) return { removed: [], kept: total };
  const finished = (await readAllOps(location)).filter((op) => op.status !== 'prepared');
  finished.sort((left, right) => (left.last.ts === right.last.ts
    ? (left.last.id < right.last.id ? 1 : -1)
    : (left.last.ts < right.last.ts ? 1 : -1)));
  const removed = [];
  finished.forEach((op, rank) => {
    if (op.request_id === protect || rank < maxOps) return;
    if (nowMs - Date.parse(op.last.ts) < maxAgeMs) return;
    removed.push(op.request_id);
  });
  if (removed.length > 0) {
    const directory = await inspectOpsDirectory(location, opsSegments);
    for (const id of removed) await removeFile(join(directory, `${id}.jsonl`));
    const gone = new Set(removed);
    const indexDirectory = await inspectOpsDirectory(location, indexSegments);
    for (const name of (await listDirectory(indexDirectory)).filter((entry) => entry.endsWith('.json'))) {
      const text = await readTextIfExists(join(indexDirectory, name));
      const parsed = text === null ? null : parseStrictJson(text);
      if (parsed?.ok && gone.has(parsed.value?.request_id)) await removeFile(join(indexDirectory, name));
    }
  }
  return { removed: removed.sort(), kept: total - removed.length };
}
