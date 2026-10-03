// runJournaledMutation (F8/F17): the one place where lock, recovery check, replay, validation, prepared/committed
// records, the replay-key index and retention come together. The frozen order is JOURNAL_POLICY.order:
//   lock -> recovery check -> authorize -> caller-ID conflict check -> replay check -> validate
//   -> prepared -> apply -> committed -> index -> (retention) -> release.
// Domain outcomes are returned, never thrown; programming errors (TypeError) and a corrupt journal
// (JournalCorruptError) throw, and a thrown apply is re-thrown unchanged after a `failed` record.
import { createPacket } from '../../core/packet.js';
import { createDefaultProviders } from '../../core/providers.js';
import { SNAPSHOT_PATTERN, isUlid, validateWorkflowPath } from '../../schemas/common.js';
import { validatePacket } from '../../schemas/packet.js';
import { ContractValidationError } from '../../schemas/validation.js';
import { encodeJsonlRecord } from '../canonical/index.js';
import { withLockOrHeld } from '../ops-files.js';
import {
  checkCommand,
  checkExpectedSnapshot,
  computePacketHash,
  computeReplayKey,
  computeRequestHash,
  normalizeTarget,
  saltReplayKey,
} from './hashes.js';
import {
  DAY_MS,
  DEDUPE_MODES,
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_MAX_OPS,
  JOURNAL_FAULT_POINTS,
  JOURNAL_FINDING_CODES,
} from './policy.js';
import { OP_SPEC } from './record.js';
import { buildReplayPacket } from './replay.js';
import {
  appendOpRecord,
  clearIndexDirty,
  ensureIndexEntry,
  listUnresolved,
  locateJournal,
  lookupByReplayKey,
  markIndexDirty,
  pruneOps,
  readOpFile,
  removePendingMarker,
  settleIndex,
  writeIndexEntry,
  writePendingMarker,
} from './storage.js';

export function resolveRetention(retention) {
  if (retention === null) return null;
  const value = retention ?? {};
  const maxOps = value.maxOps ?? DEFAULT_MAX_OPS;
  const maxAgeMs = value.maxAgeMs ?? DEFAULT_MAX_AGE_DAYS * DAY_MS;
  for (const [name, number] of [['maxOps', maxOps], ['maxAgeMs', maxAgeMs]]) {
    if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`retention.${name} must be a non-negative integer`);
  }
  return { maxOps, maxAgeMs };
}

function functionOption(value, name) {
  if (value !== undefined && typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return value;
}

function resolveOptions(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('options are required');
  const { workflowRoot } = options;
  if (typeof workflowRoot !== 'string' || workflowRoot.length === 0) throw new TypeError('workflowRoot is required');
  const dedupe = options.dedupe ?? 'projection';
  if (!DEDUPE_MODES.includes(dedupe)) throw new TypeError(`dedupe must be one of: ${DEDUPE_MODES.join(', ')}`);
  if (typeof options.currentSnapshot !== 'function') throw new TypeError('currentSnapshot must be a function');
  if (typeof options.apply !== 'function') throw new TypeError('apply must be a function');
  const faults = options.faults ?? {};
  for (const [point, hook] of Object.entries(faults)) {
    if (!JOURNAL_FAULT_POINTS.includes(point)) throw new TypeError(`unknown fault point: ${point}`);
    if (typeof hook !== 'function') throw new TypeError(`fault ${point} must be a function`);
  }
  const target = normalizeTarget(options.target);
  const input = options.input === undefined ? null : options.input;
  const draft = options.draft ?? null;
  if (draft !== null) {
    const verdict = validateWorkflowPath(draft);
    if (!verdict.ok) throw new TypeError('draft must be a normalized repository-relative path string');
  }
  if (options.again !== undefined && typeof options.again !== 'boolean') throw new TypeError('again must be a boolean');
  if (options.dryRun !== undefined && typeof options.dryRun !== 'boolean') throw new TypeError('dryRun must be a boolean');
  const replayNextCommands = options.replayNextCommands ?? [];
  if (!Array.isArray(replayNextCommands)) throw new TypeError('replayNextCommands must be an array');
  return {
    paths: { repositoryRoot: options.repositoryRoot, workflowRoot },
    root: options.root ?? options.repositoryRoot ?? workflowRoot,
    command: checkCommand(options.command),
    target,
    input,
    expectedSnapshot: checkExpectedSnapshot(options.expectedSnapshot),
    requestId: options.requestId ?? undefined,
    dedupe,
    again: options.again === true,
    draft,
    dryRun: options.dryRun === true,
    providers: options.providers ?? createDefaultProviders(),
    knownCommands: options.knownCommands,
    currentSnapshot: options.currentSnapshot,
    authorize: functionOption(options.authorize, 'authorize'),
    validate: functionOption(options.validate, 'validate'),
    apply: options.apply,
    beginTransaction: functionOption(options.beginTransaction, 'beginTransaction'),
    recover: functionOption(options.recover, 'recover'),
    onRequestId: functionOption(options.onRequestId, 'onRequestId'),
    faults,
    retention: resolveRetention(options.retention),
    lockOptions: options.lockOptions,
    replayNextCommands,
  };
}

const finding = (code, message, detail) => ({ code, severity: 'error', message, file: null, line: null, detail });

function journalPacket(config, { requestId, status, data, findings, snapshot = null }) {
  return createPacket({
    command: config.command,
    requestId,
    status,
    root: config.root,
    snapshot: { before: snapshot, after: snapshot },
    data,
    findings,
    changed: [],
    nextCommands: [],
    providers: config.providers,
    knownCommands: config.knownCommands,
  });
}

const outcome = (fields) => Object.freeze({
  request_id: null, generated: false, packet: null, replayed: null, record: null, prune: null, rejection: null, exit_code: null,
  ...fields,
});

async function measure(config) {
  const value = await config.currentSnapshot();
  if (value !== null && !(typeof value === 'string' && SNAPSHOT_PATTERN.test(value))) {
    throw new TypeError('currentSnapshot must resolve to a sha256 snapshot or null');
  }
  return value;
}

async function gate(hook, context, label) {
  if (hook === undefined) return null;
  const rejection = await hook(context);
  if (rejection === null || rejection === undefined) return null;
  const packet = rejection.packet;
  if (packet === null || typeof packet !== 'object' || !['error', 'blocked'].includes(packet.status)) {
    throw new TypeError(`${label} must return null or { packet } with an error or blocked packet`);
  }
  return outcome({
    outcome: 'rejected', request_id: context.request_id, generated: context.generated, packet,
  });
}

function stale(config, context, current) {
  const packet = journalPacket(config, {
    requestId: context.request_id,
    status: 'blocked',
    data: { kind: 'blocked', reason: 'stale_snapshot' },
    findings: [finding(
      JOURNAL_FINDING_CODES.stale_snapshot,
      'The expected snapshot no longer matches the workflow; re-read it and retry.',
      { source: 'explicit', expected: config.expectedSnapshot, current, delta: null },
    )],
    snapshot: current,
  });
  return outcome({
    outcome: 'stale', request_id: context.request_id, generated: context.generated, packet, exit_code: 1,
  });
}

// What an apply (or a rolled-back transaction) must hand back: the final packet of this very request.
function checkApplied(packet, config, requestId) {
  if (packet === null || typeof packet !== 'object') throw new TypeError('apply must return the final packet');
  if (packet.command !== config.command) throw new TypeError('apply returned a packet for another command');
  if (packet.request_id !== requestId) throw new TypeError('apply returned a packet for another request ID');
  const verdict = validatePacket(packet, { knownCommands: config.knownCommands });
  if (!verdict.ok) throw new ContractValidationError('packet', verdict.issues);
}

async function fire(config, point, requestId) {
  await config.faults[point]?.({ point, request_id: requestId, command: config.command });
}

function recordFor(config, context, hashes, state, fields) {
  return {
    id: config.providers.runId(),
    ts: config.providers.now(),
    request_id: context.request_id,
    command: config.command,
    target: config.target,
    request_hash: hashes.request_hash,
    replay_key: hashes.replay_key,
    state,
    expected_snapshot: config.expectedSnapshot,
    before: null,
    after: null,
    changed: [],
    packet_hash: null,
    packet: null,
    transaction: null,
    draft: config.draft,
    ...fields,
  };
}

async function recoveryGate(config, context, location) {
  const unresolved = await listUnresolved(location);
  let blocking = null;
  for (const entry of unresolved) {
    const answer = config.recover === undefined ? undefined : await config.recover({
      request_id: entry.request_id, transaction: entry.transaction, record: entry.record,
    });
    if (answer?.status === 'rolled_back') {
      const { hash: _hash, ...record } = entry.record;
      await appendOpRecord(location, {
        ...record,
        id: config.providers.runId(),
        ts: config.providers.now(),
        state: 'failed',
        after: null,
        changed: [],
        packet_hash: null,
        packet: null,
      });
      await removePendingMarker(location, entry.request_id);
    } else if (blocking === null) {
      blocking = entry;
    }
  }
  if (blocking === null) return null;
  const packet = journalPacket(config, {
    requestId: context.request_id,
    status: 'blocked',
    data: { kind: 'blocked', reason: 'recovery_required' },
    findings: [finding(
      JOURNAL_FINDING_CODES.recovery_required,
      'An earlier mutation stopped before it finished; recovery must complete before any other mutation begins.',
      { request_id: blocking.request_id, transaction: blocking.transaction },
    )],
  });
  return outcome({
    outcome: 'recovery_required', request_id: context.request_id, generated: context.generated, packet, exit_code: 1,
  });
}

async function replayOutcome(config, context, location, record) {
  await ensureIndexEntry(location, record);
  const packet = buildReplayPacket({
    record,
    root: config.root,
    currentSnapshot: await measure(config),
    providers: config.providers,
    replayNextCommands: config.replayNextCommands,
    knownCommands: config.knownCommands,
  });
  return outcome({
    outcome: 'replayed',
    request_id: record.request_id,
    generated: context.generated,
    packet,
    record,
    replayed: { request_id: record.request_id, committed_at: record.ts },
  });
}

function conflictOutcome(config, context, existing, requestHash) {
  const packet = journalPacket(config, {
    requestId: context.request_id,
    status: 'error',
    data: { kind: 'usage', reason: 'request_id_conflict' },
    findings: [finding(
      JOURNAL_FINDING_CODES.request_conflict,
      'This request ID was already used for a different request.',
      { request_id: context.request_id, recorded_request_hash: existing.request_hash, supplied_request_hash: requestHash },
    )],
  });
  return outcome({ outcome: 'conflict', request_id: context.request_id, packet, exit_code: 2 });
}

async function applyUnrecorded(config, context, current) {
  const rejection = await prepareValidation(config, context, current);
  if (rejection !== null) return rejection;
  await config.onRequestId?.(context.request_id);
  const packet = await config.apply({ ...context, current_snapshot: current, transaction: null });
  checkApplied(packet, config, context.request_id);
  return outcome({ outcome: 'executed', request_id: context.request_id, generated: context.generated, packet });
}

// Builtin expected-snapshot check, then the caller's validate. Returns an outcome to stop with, or null.
async function prepareValidation(config, context, current) {
  if (config.expectedSnapshot !== null && current !== config.expectedSnapshot) return stale(config, context, current);
  return gate(config.validate, { ...context, current_snapshot: current, transaction: null }, 'validate');
}

async function execute(config, context, hashes, handle) {
  const location = await locateJournal(config.paths);
  const running = { ...context, lock: handle };

  const blocked = await recoveryGate(config, running, location);
  if (blocked !== null) return blocked;

  const denied = await gate(config.authorize, { ...running, current_snapshot: null, transaction: null }, 'authorize');
  if (denied !== null) return denied;

  if (config.dedupe !== 'none') await settleIndex(location);
  if (config.dedupe === 'none') return applyUnrecorded(config, running, await measure(config));

  // caller-supplied ID: strict conflict semantics, then replay of its own committed op
  if (!context.generated) {
    const existing = await readOpFile(location, context.request_id);
    if (existing !== null && existing.request_hash !== hashes.request_hash) {
      return conflictOutcome(config, running, existing, hashes.request_hash);
    }
    if (existing?.committed) return replayOutcome(config, running, location, existing.committed);
  } else if (!config.again) {
    // generated ID: the A1 replay rule
    const found = await lookupByReplayKey(location, hashes.replay_key, { repair: true });
    if (found !== null) {
      const replayable = config.dedupe === 'append'
        || (found.committed.after !== null && found.committed.after === await measure(config));
      if (replayable) return replayOutcome(config, running, location, found.committed);
    }
  }

  const current = await measure(config);
  const rejection = await prepareValidation(config, running, current);
  if (rejection !== null) return rejection;

  const transaction = config.beginTransaction === undefined
    ? null
    : await config.beginTransaction({ ...running, current_snapshot: current, transaction: null });
  if (transaction !== null && !isUlid(transaction)) throw new TypeError('beginTransaction must return null or a ULID');

  await config.onRequestId?.(context.request_id);
  if (transaction !== null) await writePendingMarker(location, context.request_id, transaction);
  await appendOpRecord(location, recordFor(config, running, hashes, 'prepared', { before: current, transaction }));
  await fire(config, 'after_prepared', context.request_id);

  const recordFailure = async () => {
    try {
      await appendOpRecord(location, recordFor(config, running, hashes, 'failed', { before: current, transaction }));
      await removePendingMarker(location, context.request_id);
    } catch {
      // The original failure wins; the op stays prepared, which is retryable (or recovery-blocked with a transaction).
    }
  };

  let packet;
  let committedLine;
  let packetHash;
  try {
    packet = await config.apply({ ...running, current_snapshot: current, transaction });
    checkApplied(packet, config, context.request_id);
    if (packet.status === 'error' || packet.status === 'blocked') {
      await recordFailure();
      return outcome({ outcome: 'failed', request_id: context.request_id, generated: context.generated, packet });
    }
    // Encode before writing so that an unencodable packet is a failure, not a half-written commit.
    packetHash = computePacketHash(packet);
    committedLine = recordFor(config, running, hashes, 'committed', {
      before: packet.snapshot.before,
      after: packet.snapshot.after,
      changed: packet.changed,
      packet_hash: packetHash,
      packet,
      transaction,
    });
    encodeJsonlRecord(committedLine, OP_SPEC);
  } catch (error) {
    await recordFailure();
    throw error;
  }

  await fire(config, 'after_apply', context.request_id);
  await markIndexDirty(location, context.request_id);
  const record = await appendOpRecord(location, committedLine);
  await removePendingMarker(location, context.request_id);
  await fire(config, 'after_committed', context.request_id);
  await writeIndexEntry(location, hashes.replay_key, context.request_id);
  await clearIndexDirty(location);
  await fire(config, 'after_index', context.request_id);

  let prune = { removed: [], kept: null };
  if (config.retention !== null) {
    try {
      prune = await pruneOps(location, {
        ...config.retention,
        nowMs: Date.parse(config.providers.now()),
        protect: context.request_id,
        stride: Math.max(1, Math.floor(config.retention.maxOps / 20)),
      });
    } catch (error) {
      prune = { removed: [], kept: null, error: error instanceof Error ? error.message : 'prune failed' };
    }
  }
  return outcome({
    outcome: 'committed', request_id: context.request_id, generated: context.generated, packet, record, prune,
  });
}

async function dryRun(config) {
  const context = Object.freeze({
    request_id: null, generated: false, command: config.command, target: config.target, input: config.input,
    expected_snapshot: config.expectedSnapshot, draft: config.draft, current_snapshot: null, transaction: null, lock: null,
  });
  const denied = await gate(config.authorize, context, 'authorize');
  if (denied !== null) return denied;
  const current = await measure(config);
  const rejection = await prepareValidation(config, context, current);
  if (rejection !== null) return rejection;
  return outcome({ outcome: 'dry_run' });
}

export async function runJournaledMutation(options) {
  const config = resolveOptions(options);
  if (config.dryRun) return dryRun(config);

  let requestId = config.requestId;
  const generated = requestId === undefined;
  if (generated) {
    requestId = config.providers.runId();
    if (!isUlid(requestId)) throw new TypeError('providers.runId must return a ULID');
  } else if (!isUlid(requestId)) {
    const packet = journalPacket(config, {
      requestId: null,
      status: 'error',
      data: { kind: 'usage', reason: 'invalid_request_id' },
      findings: [{
        code: 'AKRS-C001', severity: 'error', message: 'request_id must be a 26-character ULID', file: null, line: null,
        detail: { reason: 'request_id must be a 26-character ULID' },
      }],
    });
    return outcome({ outcome: 'invalid_request', packet, exit_code: 2 });
  }

  const context = Object.freeze({
    request_id: requestId, generated, command: config.command, target: config.target, input: config.input,
    expected_snapshot: config.expectedSnapshot, draft: config.draft,
  });
  // Hashing validates the input and target before the lock is taken; executions are never hashed.
  let hashes = null;
  if (config.dedupe !== 'none') {
    const baseKey = computeReplayKey({ command: config.command, target: config.target, input: config.input });
    hashes = {
      request_hash: computeRequestHash({
        command: config.command, target: config.target, input: config.input, expectedSnapshot: config.expectedSnapshot,
      }),
      replay_key: config.again ? saltReplayKey(baseKey, requestId) : baseKey,
    };
  }
  const locked = await withLockOrHeld({ ...config.paths, lockOptions: config.lockOptions, command: config.command },
    (handle) => execute(config, context, hashes, handle));
  if (locked.status === 'ok') return locked.value;
  const packet = journalPacket(config, {
    requestId,
    status: 'blocked',
    data: { kind: 'blocked', reason: 'repository_lock' },
    findings: [locked.finding],
  });
  return outcome({
    outcome: 'lock_blocked', request_id: requestId, generated, packet, exit_code: 1,
  });
}
