// Read helpers and maintenance entry points around the journal (F8/F17). The helpers read without the lock (they
// only read, and tolerate a torn last line); the authoritative decision is always re-made under the lock by
// runJournaledMutation. rebuildJournalIndex and pruneJournal write, so they run under the lock.
import { createDefaultProviders } from '../../core/providers.js';
import { SNAPSHOT_PATTERN, validateWorkflowPath } from '../../schemas/common.js';
import { withLockOrHeld } from '../ops-files.js';
import { computeReplayKey, checkCommand, normalizeTarget } from './hashes.js';
import { resolveRetention } from './mutation.js';
import {
  checkRequestId,
  latestCommitted,
  locateJournal,
  lookupByReplayKey,
  pruneOps,
  readAllOps,
  readOpFile,
  rebuildIndexFiles,
} from './storage.js';

export async function readOp({ repositoryRoot, workflowRoot, requestId } = {}) {
  checkRequestId(requestId);
  const op = await readOpFile(await locateJournal({ repositoryRoot, workflowRoot }), requestId);
  if (op === null) return { status: 'none' };
  return { status: op.status, request_id: op.request_id, records: op.records, committed: op.committed };
}

const summary = (op) => ({ request_id: op.request_id, committed_at: op.committed.ts, record: op.committed });

// The committed op an append command answers with a noop (and an --again offer). No snapshot is involved: an exact
// duplicate append is a duplicate even after the projection moved on.
export async function findCommittedAppend({ repositoryRoot, workflowRoot, command, target, input } = {}) {
  const key = computeReplayKey({ command, target, input });
  const op = await lookupByReplayKey(await locateJournal({ repositoryRoot, workflowRoot }), key);
  return op === null ? null : summary(op);
}

// A retry whose draft file is gone cannot recompute its input, so it is resolved by the draft path recorded on the
// committed op. `replayKey` narrows the match when the caller can still compute it; `currentSnapshot` (a snapshot
// string or null) makes the result say whether the A1 projection condition holds.
export async function resolveFromJournal({
  repositoryRoot, workflowRoot, command, target, draftPath, currentSnapshot, replayKey,
} = {}) {
  checkCommand(command);
  const normalized = normalizeTarget(target);
  if (!validateWorkflowPath(draftPath).ok) throw new TypeError('draftPath must be a normalized repository-relative path string');
  if (replayKey !== undefined && !SNAPSHOT_PATTERN.test(replayKey)) throw new TypeError('replayKey must be a sha256 hash');
  const location = await locateJournal({ repositoryRoot, workflowRoot });
  const ops = await readAllOps(location);
  const op = latestCommitted(ops, (record) => record.command === command && record.draft === draftPath
    && record.target.road === normalized.road && record.target.plan === normalized.plan
    && (replayKey === undefined || record.replay_key === replayKey));
  if (op === null) return { status: 'none' };
  return {
    status: 'committed',
    ...summary(op),
    projection_matches: currentSnapshot === undefined
      ? null
      : op.committed.after !== null && op.committed.after === currentSnapshot,
  };
}

function lockBlocked(locked) {
  return { status: 'lock_blocked', finding: locked.finding, lock: locked };
}

export async function rebuildJournalIndex({ repositoryRoot, workflowRoot, heldLock, lockOptions } = {}) {
  const locked = await withLockOrHeld({ repositoryRoot, workflowRoot, heldLock, lockOptions, command: 'journal-rebuild' },
    async () => rebuildIndexFiles(await locateJournal({ repositoryRoot, workflowRoot })));
  return locked.status === 'ok' ? { status: 'rebuilt', keys: locked.value } : lockBlocked(locked);
}

export async function pruneJournal({
  repositoryRoot, workflowRoot, heldLock, lockOptions, providers = createDefaultProviders(), retention,
} = {}) {
  const limits = resolveRetention(retention) ?? resolveRetention(undefined);
  const locked = await withLockOrHeld({ repositoryRoot, workflowRoot, heldLock, lockOptions, command: 'journal-prune' },
    async () => pruneOps(await locateJournal({ repositoryRoot, workflowRoot }), {
      ...limits, nowMs: Date.parse(providers.now()), protect: null,
    }));
  return locked.status === 'ok' ? { status: 'pruned', ...locked.value } : lockBlocked(locked);
}
