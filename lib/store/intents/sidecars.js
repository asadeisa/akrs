// The two files `work` keeps beside a Road lease (.ops/leases/<road>.guard.json and .done.json). CLI-owned scratch under .ops: no snapshot
// projection reads it, and releasing the lease removes both (the lease store does that).
import { join } from 'node:path';
import { canonicalizeJson, parseStrictJson } from '../canonical/index.js';
import { DONE_STATE_SUFFIX, GUARD_FILE_SUFFIX, LEASE_DIRECTORY } from '../leases/policy.js';
import { ensureOpsDirectory, inspectOpsDirectory, locateOps, readTextIfExists, withLockOrHeld, writeFileAtomic } from '../ops-files.js';
import { GUARD_FILE_SPEC } from './guard-core.js';

const DONE_SPEC = Object.freeze({ keys: ['road', 'holder', 'failures'], arrays: {}, objects: {} });
export const guardFileName = (road) => `${road}${GUARD_FILE_SUFFIX}`;
export const guardFilePath = (road) => `.ops/${LEASE_DIRECTORY}/${guardFileName(road)}`;

// The caller holds the repository lock (work's claim step).
export async function writeGuardFile({ repositoryRoot, workflowRoot, guard }) {
  const location = await locateOps({ repositoryRoot, workflowRoot });
  const directory = await ensureOpsDirectory(location, [LEASE_DIRECTORY]);
  await writeFileAtomic(join(directory, guardFileName(guard.road)), canonicalizeJson(guard, GUARD_FILE_SPEC));
}

function parseDone(text, road) {
  if (text === null) return null;
  const parsed = parseStrictJson(text);
  const value = parsed.ok ? parsed.value : null;
  const valid = value !== null && typeof value === 'object' && value.road === road && typeof value.holder === 'string' && Number.isSafeInteger(value.failures) && value.failures >= 0;
  return valid ? value : null;
}

// the state of the failed-done count, creating the directory only when `create` (a write follows)
async function readDoneFile(location, road, create) {
  const directory = create ? await ensureOpsDirectory(location, [LEASE_DIRECTORY]) : await inspectOpsDirectory(location, [LEASE_DIRECTORY]);
  if (directory === null) return { directory, state: null };
  return { directory, state: parseDone(await readTextIfExists(join(directory, `${road}${DONE_STATE_SUFFIX}`)), road) };
}

// -> the failures recorded for this holder on this Road (0 for a new holder or no file); never writes.
export async function readDoneFailures({ repositoryRoot, workflowRoot, road, holder }) {
  const { state } = await readDoneFile(await locateOps({ repositoryRoot, workflowRoot }), road, false);
  return state !== null && state.holder === holder ? state.failures : 0;
}

// Starts the count again (a claim by a new holder). The caller holds the lock.
export async function resetDoneFailures({ repositoryRoot, workflowRoot, road, holder }) {
  const location = await locateOps({ repositoryRoot, workflowRoot });
  const { directory } = await readDoneFile(location, road, true);
  await writeFileAtomic(join(directory, `${road}${DONE_STATE_SUFFIX}`), canonicalizeJson({ road, holder, failures: 0 }, DONE_SPEC));
}

// One more refused done: takes the repository lock itself. -> { failures } | { lock_blocked: finding }
export async function recordDoneFailure({ repositoryRoot, workflowRoot, road, holder, lockOptions }) {
  const result = await withLockOrHeld({ repositoryRoot, workflowRoot, lockOptions, command: 'done' }, async () => {
    const location = await locateOps({ repositoryRoot, workflowRoot });
    const { directory, state } = await readDoneFile(location, road, true);
    const failures = (state !== null && state.holder === holder ? state.failures : 0) + 1;
    await writeFileAtomic(join(directory, `${road}${DONE_STATE_SUFFIX}`), canonicalizeJson({ road, holder, failures }, DONE_SPEC));
    return failures;
  });
  return result.status === 'ok' ? { failures: result.value } : { lock_blocked: result.finding };
}
