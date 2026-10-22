// The change stream engine (P2-W17): journal tailing plus workflow file changes, debounced and resumable. It reads and never writes. Every
// source of nondeterminism is an input: the abort signal, the timers, the file-watcher factory and the scan hook, so a test drives it with
// no real waiting and leaves no watcher or timer behind. See WATCH_POLICY.
import { watch as fsWatch } from 'node:fs';
import { CliUsageError } from '../core/errors.js';
import { compareStrings } from '../schemas/common.js';
import { EMPTY_SNAPSHOT, WORKFLOW_PROJECTION, computeSnapshot } from '../store/snapshots/index.js';
import { createOpTracker } from './journal.js';
import { WATCH_DEFAULTS, WATCH_EVENT_KINDS, WATCH_NOISE_PREFIXES } from './policy.js';

const realTimers = Object.freeze({
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  now: () => Date.now(),
});

// A file event the engine ignores: drafts, the cache, evidence and CLI scratch other than the journal's operation files.
export function isNoise(filename) {
  const name = String(filename ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (name === '') return false;
  if (WATCH_NOISE_PREFIXES.some((prefix) => name.startsWith(prefix) || `${name}/` === prefix)) return true;
  if (/(^|\/)evidence(\/|$)/.test(name)) return true;
  if (name === '.ops' || name.startsWith('.ops/')) return !name.startsWith('.ops/journal/ops');
  return false;
}

function defaultWatchFactory(path, onEvent) {
  let watcher = null;
  try {
    watcher = fsWatch(path, { recursive: true }, (_kind, filename) => onEvent(filename === null || filename === undefined ? '' : String(filename)));
    watcher.on('error', () => {});
  } catch {
    return { close() {} };
  }
  return {
    close() {
      try {
        watcher.close();
      } catch {
        // already closed
      }
    },
  };
}

// the keys whose content differs between two inventories (added, removed or changed), sorted by code point
export function changedPaths(previous, next) {
  const index = (inventory) => new Map(inventory.map(({ projection, key, value }) => [`${projection}\u0000${key}`, { key, value }]));
  const before = index(previous);
  const after = index(next);
  const paths = new Set();
  for (const [id, entry] of after) if (!before.has(id) || before.get(id).value !== entry.value) paths.add(entry.key);
  for (const [id, entry] of before) if (!after.has(id)) paths.add(entry.key);
  return [...paths].sort(compareStrings);
}

// emit(type, data) writes one event; it is never called after the stream ended.
// -> { ended, since, cursor, ops, changes, snapshot }
export async function runWatch({
  repositoryRoot, workflowRoot, since = null, debounceMs = WATCH_DEFAULTS.debounce_ms, pollMs = WATCH_DEFAULTS.poll_ms, maxEvents = null, durationMs = null,
  signal = null, emit, deps = {},
}) {
  const timers = deps.timers ?? realTimers;
  const watchFactory = deps.watchFactory ?? defaultWatchFactory;
  const base = { repositoryRoot, workflowRoot };
  const tracker = await createOpTracker(base);
  const seen = new Set();
  const state = { ops: 0, changes: 0, emitted: 0, cursor: null, snapshot: null, inventory: [] };
  let ended = null;
  let scans = 0;

  const measure = async () => {
    const read = await computeSnapshot({ ...base, projections: WORKFLOW_PROJECTION, target: {} });
    return read.status === 'ok' ? { snapshot: read.snapshot, inventory: read.inventory } : null;
  };

  // ---- start: the resume cursor and the baseline --------------------------------------------------------------
  const known = await tracker.refresh();
  let backlog = [];
  if (since === null) {
    for (const op of known) seen.add(op.request_id);
    state.cursor = known.at(-1)?.request_id ?? null;
  } else {
    const position = known.findIndex(({ request_id: id }) => id === since);
    if (position < 0) throw new CliUsageError(`watch: no committed operation ${since} in the journal (it never existed or was pruned); run watch without --since`);
    for (const op of known.slice(0, position + 1)) seen.add(op.request_id);
    state.cursor = since;
    backlog = known.slice(position + 1);
  }
  let baseline = await measure();
  for (let attempt = 0; baseline === null && attempt < 5; attempt += 1) baseline = await measure();
  state.snapshot = baseline?.snapshot ?? EMPTY_SNAPSHOT;
  state.inventory = baseline?.inventory ?? [];
  emit('started', { kind: WATCH_EVENT_KINDS.started, since, cursor: state.cursor, snapshot: state.snapshot, debounce_ms: debounceMs, poll_ms: pollMs });

  let finish = () => {};
  const done = new Promise((resolve) => { finish = resolve; });
  let pollHandle = null;
  let burstHandle = null;
  let burstStart = null;
  let durationHandle = null;
  let scanning = null;
  let again = false;
  let watcher = null;
  let failure = null;

  const stop = (reason) => {
    if (ended !== null) return;
    ended = reason;
    finish();
  };
  const fail = (error) => {
    failure = error;
    stop('error');
  };
  const room = () => ended === null;
  const counted = () => {
    state.emitted += 1;
    if (maxEvents !== null && state.emitted >= maxEvents) stop('max_events');
  };
  const emitOp = (op) => {
    emit('progress', {
      kind: WATCH_EVENT_KINDS.op, op: op.request_id, command: op.command, road: op.road, plan: op.plan, ts: op.ts, changed: op.changed, before: op.before, after: op.after,
    });
    seen.add(op.request_id);
    state.cursor = op.request_id;
    state.ops += 1;
    counted();
  };

  // one scan: new operations first, then at most one workflow change
  const scanOnce = async () => {
    for (const op of (await tracker.refresh()).filter(({ request_id: id }) => !seen.has(id))) {
      if (!room()) return;
      emitOp(op);
    }
    if (!room()) return;
    const next = await measure();
    if (next === null || next.snapshot === state.snapshot) return;
    emit('progress', { kind: WATCH_EVENT_KINDS.change, before: state.snapshot, after: next.snapshot, paths: changedPaths(state.inventory, next.inventory) });
    state.snapshot = next.snapshot;
    state.inventory = next.inventory;
    state.changes += 1;
    counted();
  };
  const runScans = async () => {
    do {
      again = false;
      await scanOnce();
      scans += 1;
      await deps.onScan?.({ scans, emitted: state.emitted, ended });
    } while (again && room());
  };
  const requestScan = () => {
    if (scanning !== null) {
      again = true;
      return scanning;
    }
    scanning = runScans().finally(() => { scanning = null; });
    return scanning;
  };

  // ---- sources -------------------------------------------------------------------------------------------------
  const armPoll = () => {
    if (!room()) return;
    pollHandle = timers.setTimeout(() => {
      pollHandle = null;
      requestScan().catch(fail).finally(armPoll);
    }, pollMs);
  };
  const wake = () => {
    if (!room()) return;
    const now = timers.now();
    if (burstStart === null) burstStart = now;
    if (burstHandle !== null) timers.clearTimeout(burstHandle);
    const wait = Math.min(debounceMs, Math.max(0, burstStart + debounceMs * 5 - now));
    burstHandle = timers.setTimeout(() => {
      burstHandle = null;
      burstStart = null;
      requestScan().catch(fail);
    }, wait);
  };
  const onAbort = () => stop('signal');

  try {
    watcher = watchFactory(workflowRoot, (filename) => {
      if (!isNoise(filename)) wake();
    });
    if (signal !== null) {
      if (signal.aborted) stop('signal');
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (durationMs !== null) durationHandle = timers.setTimeout(() => stop('duration'), durationMs);
    for (const op of backlog) {
      if (!room()) break;
      emitOp(op);
    }
    armPoll();
    await done;
  } finally {
    if (pollHandle !== null) timers.clearTimeout(pollHandle);
    if (burstHandle !== null) timers.clearTimeout(burstHandle);
    if (durationHandle !== null) timers.clearTimeout(durationHandle);
    signal?.removeEventListener('abort', onAbort);
    watcher?.close();
  }
  if (scanning !== null) await scanning.catch(() => {});
  if (failure !== null) throw failure;
  if (ended === 'signal') {
    // one last look, so nothing committed just before the signal is lost
    ended = null;
    await scanOnce();
    ended = 'signal';
  }
  return { ended, since, cursor: state.cursor, ops: state.ops, changes: state.changes, snapshot: state.snapshot };
}
