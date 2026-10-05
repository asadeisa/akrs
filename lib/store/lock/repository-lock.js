// F7 (P1-W03): the repository-scoped lock. The decisions are documented in policy.js and pinned by test/lock.
// Plain store functions: no printing, no process exit, time/run IDs/process probes/sleeping are injectable.
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRunId } from '../../core/providers.js';
import { isUlid } from '../../schemas/common.js';
import { PathSafetyError, createPathService } from '../path-service.js';
import {
  holderOf,
  parseLockOwner,
  renderLockOwner,
  sameOwner,
  validateLockOwner,
} from './owner.js';
import {
  LOCK_DEFAULT_RETRY_MS,
  LOCK_DEFAULT_TIMEOUT_MS,
  LOCK_DIRECTORY,
  LOCK_DISPLAY_PATH,
  LOCK_FINDING_CODE,
  LOCK_OPS_DIRECTORY,
  LOCK_OWNER_FILE,
  LOCK_OWNER_SCHEMA,
} from './policy.js';

const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const LOST_CODES = new Set(['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR']);
const RENAME_RETRIES = 4;
const RENAME_BACKOFF_MS = 10;
const OWNER_WRITE_RETRIES = 3;
const OWNER_READ_RETRIES = 5;
const OWNER_READ_BACKOFF_MS = 10;
const MAX_IMMEDIATE_RETRIES = 25;
const DEFAULT_SETTLE_MS = 100;

const realSleep = (ms) => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); });

// process.kill(pid, 0) delivers no signal. Only ESRCH proves the process is gone; EPERM means it exists but
// belongs to someone else; anything unexpected is treated as alive, because wrongly evicting a live owner is
// the failure this lock must never have.
export function isProcessAlive(pid, kill = (target, signal) => process.kill(target, signal)) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function toMilliseconds(value) {
  const milliseconds = value instanceof Date ? value.valueOf() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError('clock must return a Date, epoch milliseconds or an ISO string');
  return milliseconds;
}

function integerOption(value, fallback, name, minimum) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return resolved;
}

function functionOption(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return value;
}

function resolveEnvironment(options) {
  const clock = functionOption(options.clock, () => new Date(), 'clock');
  const runId = functionOption(options.runId, () => createRunId(clock(), randomBytes(10)), 'runId');
  return {
    clock,
    nowMs: () => toMilliseconds(clock()),
    sleep: functionOption(options.sleep, realSleep, 'sleep'),
    random: functionOption(options.random, Math.random, 'random'),
    runId,
    hostname: functionOption(options.hostname, () => osHostname() || 'unknown-host', 'hostname'),
    isProcessAlive: functionOption(options.isProcessAlive, (pid) => isProcessAlive(pid), 'isProcessAlive'),
    hooks: options.testHooks ?? {},
  };
}

function newRunId(environment) {
  const value = environment.runId();
  if (!isUlid(value)) throw new TypeError('runId must return a ULID');
  return value;
}

function unsafe(message) {
  return new PathSafetyError(`unsafe lock path: ${message}`);
}

function isWithin(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`));
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

// Resolves where the lock lives. Throws PathSafetyError for roots that are not safe containers.
async function locate(options) {
  let root;
  if (options.lockRoot !== undefined) {
    if (typeof options.lockRoot !== 'string' || options.lockRoot.length === 0) {
      throw new TypeError('lockRoot must be a non-empty path');
    }
    root = await realpath(resolve(options.lockRoot));
    if (!(await lstat(root)).isDirectory()) throw unsafe('lock root is not a directory');
  } else {
    const { workflowRoot } = options;
    if (typeof workflowRoot !== 'string' || workflowRoot.length === 0) {
      throw new TypeError('workflowRoot (or lockRoot) is required');
    }
    const repositoryRoot = options.repositoryRoot ?? workflowRoot;
    const service = await createPathService({ repositoryRoot, workflowRoot });
    // The path service proves .ops cannot leave the repository; assertContained keeps it inside the workflow and
    // checks .ops/lock itself. The lock directory is deliberately not resolved here: it is created, renamed and
    // removed by competing processes, and the service's lstat-then-realpath would race with that.
    await service.resolveWorkflowPath(LOCK_OPS_DIRECTORY);
    root = await realpath(resolve(service.workflow_root));
  }
  const opsPath = join(root, LOCK_OPS_DIRECTORY);
  return Object.freeze({
    root,
    opsPath,
    lockPath: join(opsPath, LOCK_DIRECTORY),
    ownerPath: join(opsPath, LOCK_DIRECTORY, LOCK_OWNER_FILE),
  });
}

// Refuses links and escapes. With `create` the .ops directory is created (recursively) first and re-checked.
async function assertContained(location, { create = false } = {}) {
  let ops = await lstatOrNull(location.opsPath);
  if (ops === null) {
    if (!create) return;
    await mkdir(location.opsPath, { recursive: true });
    ops = await lstatOrNull(location.opsPath);
    if (ops === null) throw unsafe('.ops disappeared while it was created');
  }
  if (ops.isSymbolicLink()) throw unsafe('.ops is a symbolic link or junction');
  if (!ops.isDirectory()) throw unsafe('.ops is not a directory');
  const physical = await realpath(location.opsPath);
  if (!isWithin(location.root, physical)) throw unsafe('.ops resolves outside the workflow root');
  const lock = await lstatOrNull(location.lockPath);
  if (lock?.isSymbolicLink()) throw unsafe('.ops/lock is a symbolic link or junction');
}

// Looks at a lock directory (the live one or a moved-aside copy) and never throws on untrusted content.
async function inspectDirectory(directory, read = readFile) {
  const metadata = await lstatOrNull(directory);
  if (metadata === null) return { status: 'absent' };
  if (metadata.isSymbolicLink()) throw unsafe('lock directory is a symbolic link or junction');
  if (!metadata.isDirectory()) return { status: 'corrupt', reason: 'not_a_directory' };

  const ownerPath = join(directory, LOCK_OWNER_FILE);
  const ownerMetadata = await lstatOrNull(ownerPath);
  if (ownerMetadata === null) {
    return (await lstatOrNull(directory)) === null
      ? { status: 'absent' }
      : { status: 'corrupt', reason: 'missing_owner' };
  }
  if (!ownerMetadata.isFile()) return { status: 'corrupt', reason: 'owner_not_a_file' };
  let text;
  try {
    text = await read(ownerPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'corrupt', reason: 'missing_owner' };
    if (BUSY_CODES.has(error?.code)) return { status: 'corrupt', reason: 'owner_unreadable' };
    throw error;
  }
  const parsed = parseLockOwner(text);
  return parsed.ok ? { status: 'valid', owner: parsed.owner } : { status: 'corrupt', reason: parsed.reason };
}

async function renameWithRetry(from, to, sleep) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!BUSY_CODES.has(error?.code) || attempt >= RENAME_RETRIES) throw error;
      await sleep(RENAME_BACKOFF_MS * 2 ** attempt);
    }
  }
}

// Atomically renames a directory. Returns false when another process won the race (or Windows denied it).
async function tryRename(from, to, sleep) {
  try {
    await renameWithRetry(from, to, sleep);
    return true;
  } catch (error) {
    if (LOST_CODES.has(error?.code) || BUSY_CODES.has(error?.code)) return false;
    throw error;
  }
}

async function removeTree(path) {
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

// Moves the lock aside under `asideName`, then keeps it only if the moved owner is still `expected`. A moved
// lock that turns out to be someone else's is renamed back.
async function removeLockIf(location, asideName, expected, sleep) {
  const aside = join(location.opsPath, asideName);
  if (!(await tryRename(location.lockPath, aside, sleep))) return { moved: false };
  const moved = await inspectDirectory(aside);
  const matches = expected === null
    ? moved.status === 'corrupt'
    : moved.status === 'valid' && sameOwner(moved.owner, expected);
  if (matches) {
    await removeTree(aside);
    return { moved: true, owner: moved.owner ?? null };
  }
  await tryRename(aside, location.lockPath, sleep);
  return { moved: false, changed: true };
}

async function writeOwner(location, owner, sleep) {
  const temporary = join(location.lockPath, `${LOCK_OWNER_FILE}.tmp-${owner.run_id}`);
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(renderLockOwner(owner));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await renameWithRetry(temporary, location.ownerPath, sleep);
}

async function createLockDirectory(location) {
  try {
    await mkdir(location.lockPath);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    // A directory that is being deleted refuses mkdir with a permission error on Windows: not acquired yet.
    if (process.platform === 'win32' && BUSY_CODES.has(error?.code)) return false;
    throw error;
  }
}

function blockedMessage(reason, holder) {
  if (reason === 'corrupt') {
    return 'Repository lock is held but its owner record is missing, partial or invalid, so it cannot be proven stale.';
  }
  if (holder === null) return 'Repository lock is busy.';
  const who = `pid ${holder.pid} on ${holder.host} (run ${holder.run_id}, command "${holder.command}", since ${holder.acquired_at})`;
  return reason === 'foreign_host'
    ? `Repository lock is held by ${who}; its host differs from this host, so it cannot be proven stale from here.`
    : `Repository lock is held by ${who}.`;
}

function blockedResult({ reason, holder, waited, attempts, recovered }) {
  return Object.freeze({
    status: 'blocked',
    reason,
    holder,
    recovered,
    waited_ms: waited,
    attempts,
    lock_path: LOCK_DISPLAY_PATH,
    finding: Object.freeze({
      code: LOCK_FINDING_CODE,
      severity: 'error',
      message: blockedMessage(reason, holder),
      file: LOCK_DISPLAY_PATH,
      line: null,
      detail: Object.freeze({ holder, reason }),
    }),
  });
}

async function classify(owner, environment) {
  if (owner.host !== environment.hostname()) return 'foreign_host';
  if (owner.pid === process.pid) return 'held';
  try {
    return (await environment.isProcessAlive(owner.pid)) ? 'held' : 'stale';
  } catch {
    return 'held';
  }
}

// Recovery is serialized per stale owner. Renaming `.ops/lock` by path alone is not enough: between a contender's
// "this owner is stale" judgement and its rename, a faster contender can finish its own recovery and install a new
// live owner at the same path, and the slow rename would then displace that live owner. So the recoverer first
// claims the stale owner by mkdir of `.ops/lock.recover-<stale run_id>` (run IDs are unique, so the name is never
// reused), re-reads the owner under the claim, and only then renames. While the claim is held nobody else can
// remove or replace the stale lock, so the re-read cannot go stale before the rename.
//
// Returns { status: 'recovered', evicted } | { status: 'lost' } (retry acquisition now) | { status: 'busy' }
// (another process holds the claim; wait like for any held lock).
async function recoverStale(location, judged, runId, environment) {
  const claim = join(location.opsPath, `${LOCK_DIRECTORY}.recover-${judged.run_id}`);
  try {
    await mkdir(claim);
  } catch (error) {
    if (error?.code === 'EEXIST' || (process.platform === 'win32' && BUSY_CODES.has(error?.code))) {
      return { status: 'busy' };
    }
    throw error;
  }
  try {
    const current = await inspectDirectory(location.lockPath);
    if (current.status !== 'valid' || !sameOwner(current.owner, judged)) return { status: 'lost' };
    await environment.hooks.beforeRecoveryRename?.();
    const removal = await removeLockIf(location, `${LOCK_DIRECTORY}.stale-${runId}`, judged, environment.sleep);
    if (!removal.moved) return { status: 'lost' };
    return { status: 'recovered', evicted: { pid: judged.pid, host: judged.host, run_id: judged.run_id } };
  } finally {
    await removeTree(claim);
  }
}

// Our own owner.json can be briefly unreadable while it is replaced or scanned (rename window, Windows sharing
// violation, partial read). That is not proof of another owner, so unreadable states are re-read a bounded number
// of times before release answers not_owner. A valid record (ours or someone else's) and an absent lock are final.
async function readOwnerForRelease(location, environment) {
  const read = environment.hooks.readOwnerFile ?? readFile;
  for (let attempt = 0; ; attempt += 1) {
    const current = await inspectDirectory(location.lockPath, read);
    if (current.status !== 'corrupt' || attempt >= OWNER_READ_RETRIES) return current;
    await environment.sleep(OWNER_READ_BACKOFF_MS * 2 ** attempt);
  }
}

async function releaseLock(location, runId, environment) {
  await assertContained(location);
  const current = await readOwnerForRelease(location, environment);
  if (current.status !== 'valid' || current.owner.run_id !== runId) return Object.freeze({ released: false, reason: 'not_owner' });
  const removal = await removeLockIf(location, `${LOCK_DIRECTORY}.release-${runId}`, current.owner, environment.sleep);
  return removal.moved
    ? Object.freeze({ released: true })
    : Object.freeze({ released: false, reason: 'not_owner' });
}

function createHandle(location, owner, environment) {
  let pending = null;
  return Object.freeze({
    run_id: owner.run_id,
    owner: Object.freeze({ ...owner }),
    lock_path: LOCK_DISPLAY_PATH,
    release() {
      if (pending === null) {
        pending = releaseLock(location, owner.run_id, environment).catch((error) => {
          pending = null;
          throw error;
        });
      }
      return pending;
    },
  });
}

export async function acquireRepositoryLock(options = {}) {
  const environment = resolveEnvironment(options);
  const command = options.command;
  const timeoutMs = integerOption(options.timeoutMs, LOCK_DEFAULT_TIMEOUT_MS, 'timeoutMs', 0);
  const retryMs = integerOption(options.retryMs, LOCK_DEFAULT_RETRY_MS, 'retryMs', 1);
  const runId = newRunId(environment);
  const buildOwner = () => ({
    schema: LOCK_OWNER_SCHEMA,
    pid: process.pid,
    host: environment.hostname(),
    run_id: runId,
    command,
    acquired_at: new Date(environment.nowMs()).toISOString(),
  });
  const draft = validateLockOwner(buildOwner());
  if (!draft.ok) {
    throw new TypeError(`cannot describe this acquirer: ${draft.issues.map(({ path, code }) => `${path} ${code}`).join(', ')}`);
  }
  const location = await locate(options);

  const start = environment.nowMs();
  const deadline = start + timeoutMs;
  let attempts = 0;
  let immediate = 0;
  let recovered = null;
  let blocked = { reason: 'held', holder: null };

  for (;;) {
    attempts += 1;
    await assertContained(location, { create: true });

    if (await createLockDirectory(location)) {
      const owner = buildOwner();
      let lost = false;
      for (let write = 0; ; write += 1) {
        try {
          await environment.hooks.beforeOwnerWrite?.();
          await writeOwner(location, owner, environment.sleep);
          break;
        } catch (error) {
          if (error?.code === 'ENOENT' && write < OWNER_WRITE_RETRIES) {
            // Our directory was moved away by a recoverer's rename. If it is back, write again; if not, start over.
            if ((await lstatOrNull(location.lockPath)) === null) {
              lost = true;
              break;
            }
            await environment.sleep(RENAME_BACKOFF_MS * 2 ** write);
            continue;
          }
          const left = await inspectDirectory(location.lockPath).catch(() => ({ status: 'valid' }));
          if (left.status !== 'valid') await removeTree(location.lockPath);
          throw error;
        }
      }
      if (!lost) {
        const handle = createHandle(location, owner, environment);
        return Object.freeze({
          status: 'acquired',
          handle,
          recovered,
          waited_ms: environment.nowMs() - start,
          attempts,
          lock_path: LOCK_DISPLAY_PATH,
        });
      }
      immediate += 1;
      if (immediate <= MAX_IMMEDIATE_RETRIES) continue;
    } else {
      const state = await inspectDirectory(location.lockPath);
      let retryNow = false;
      if (state.status === 'absent') {
        retryNow = true;
      } else if (state.status === 'corrupt') {
        // Possibly a fresh directory whose acquirer has not finished writing: keep waiting, never steal.
        blocked = { reason: 'corrupt', holder: null };
      } else {
        const holder = holderOf(state.owner);
        const verdict = await classify(state.owner, environment);
        if (verdict === 'stale') {
          const outcome = await recoverStale(location, state.owner, runId, environment);
          if (outcome.status === 'recovered') recovered = outcome.evicted;
          if (outcome.status === 'busy') blocked = { reason: 'held', holder };
          else retryNow = true;
        } else {
          blocked = { reason: verdict, holder };
        }
      }
      if (retryNow) {
        immediate += 1;
        if (immediate <= MAX_IMMEDIATE_RETRIES) continue;
      }
    }

    immediate = 0;
    const remaining = deadline - environment.nowMs();
    if (remaining <= 0) {
      return blockedResult({
        ...blocked,
        waited: Math.max(0, environment.nowMs() - start),
        attempts,
        recovered,
      });
    }
    const delay = Math.max(1, Math.round(retryMs * (0.5 + environment.random())));
    await environment.sleep(Math.min(delay, remaining));
  }
}

export function releaseRepositoryLock(handle) {
  if (handle === null || typeof handle !== 'object' || typeof handle.release !== 'function') {
    throw new TypeError('releaseRepositoryLock needs the handle returned by acquireRepositoryLock');
  }
  return handle.release();
}

export async function withRepositoryLock(options, fn) {
  if (typeof fn !== 'function') throw new TypeError('withRepositoryLock needs a function');
  const acquired = await acquireRepositoryLock(options);
  if (acquired.status !== 'acquired') return acquired;
  let value;
  try {
    value = await fn(acquired.handle);
  } catch (error) {
    // The original failure wins over a failed release.
    try {
      await acquired.handle.release();
    } catch {
      // Intentionally ignored; see above.
    }
    throw error;
  }
  const release = await acquired.handle.release();
  return Object.freeze({
    status: 'ok',
    value,
    release,
    run_id: acquired.handle.run_id,
    recovered: acquired.recovered,
    waited_ms: acquired.waited_ms,
    attempts: acquired.attempts,
    lock_path: LOCK_DISPLAY_PATH,
  });
}

export async function readLockOwner(options = {}) {
  const location = await locate(options);
  await assertContained(location);
  const state = await inspectDirectory(location.lockPath);
  if (state.status === 'absent') return Object.freeze({ status: 'absent', lock_path: LOCK_DISPLAY_PATH });
  if (state.status === 'valid') return Object.freeze({ status: 'valid', owner: state.owner, lock_path: LOCK_DISPLAY_PATH });
  return Object.freeze({ status: 'corrupt', reason: state.reason, lock_path: LOCK_DISPLAY_PATH });
}

const refusal = (reason, holder = null) => Object.freeze({ status: 'refused', reason, holder });

// Manual recovery. A named run ID removes exactly that owner's lock; null removes only a lock whose owner stays
// unreadable after a settle delay (a half-written lock may belong to an acquirer that is still alive).
export async function breakLock(options = {}) {
  const { expectedRunId } = options;
  if (expectedRunId !== null && !isUlid(expectedRunId)) {
    throw new TypeError('expectedRunId must be the holder run_id (a ULID), or null for an unreadable owner');
  }
  const environment = resolveEnvironment(options);
  const settleMs = integerOption(options.settleMs, DEFAULT_SETTLE_MS, 'settleMs', 0);
  const location = await locate(options);
  await assertContained(location);

  let state = await inspectDirectory(location.lockPath);
  if (state.status === 'corrupt' && expectedRunId === null) {
    await environment.sleep(settleMs);
    state = await inspectDirectory(location.lockPath);
  }
  if (state.status === 'absent') return refusal('no_lock');
  if (state.status === 'corrupt') {
    return expectedRunId === null ? removeBroken(location, null, environment) : refusal('owner_unreadable');
  }
  const holder = holderOf(state.owner);
  if (expectedRunId === null) return refusal('owner_valid', holder);
  if (state.owner.run_id !== expectedRunId) return refusal('owner_mismatch', holder);
  return removeBroken(location, state.owner, environment);
}

async function removeBroken(location, expected, environment) {
  const removal = await removeLockIf(
    location,
    `${LOCK_DIRECTORY}.break-${newRunId(environment)}`,
    expected,
    environment.sleep,
  );
  if (removal.moved) {
    // A recoverer that died mid-recovery leaves its claim behind; it only ever blocks this exact owner.
    if (expected !== null) await removeTree(join(location.opsPath, `${LOCK_DIRECTORY}.recover-${expected.run_id}`));
    return Object.freeze({ status: 'removed', holder: expected === null ? null : holderOf(expected) });
  }
  return refusal(removal.changed ? 'owner_mismatch' : 'no_lock');
}
