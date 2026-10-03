// Shared plumbing for the CLI-owned `<workflow>/.ops` stores (journal, leases): contained locations, durable
// writes, and "run under the repository lock, or prove you already hold it". Plain store functions: no printing,
// no process exit. Everything here lives under .ops, which no snapshot projection reads.
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, truncate } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PathSafetyError, createPathService } from './path-service.js';
import { readLockOwner, withRepositoryLock } from './lock/index.js';

const OPS = '.ops';
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRIES = 4;
const RENAME_BACKOFF_MS = 10;
const realSleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

const unsafe = (message) => new PathSafetyError(`unsafe .ops path: ${message}`);

function isWithin(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`));
}

export async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

// Resolves <workflow>/.ops after the path service has proven the roots are safe containers.
export async function locateOps({ repositoryRoot, workflowRoot } = {}) {
  if (typeof workflowRoot !== 'string' || workflowRoot.length === 0) {
    throw new TypeError('workflowRoot is required');
  }
  const service = await createPathService({ repositoryRoot: repositoryRoot ?? workflowRoot, workflowRoot });
  await service.resolveWorkflowPath(OPS);
  const root = await realpath(resolve(service.workflow_root));
  return Object.freeze({ root, opsPath: join(root, OPS) });
}

function checkDirectory(location, metadata, display) {
  if (metadata.isSymbolicLink()) throw unsafe(`${display} is a symbolic link or junction`);
  if (!metadata.isDirectory()) throw unsafe(`${display} is not a directory`);
}

// Returns the real path of <ops>/<segments...> when it exists as a plain directory, null when it is absent.
// Links, files and escapes throw. Never creates anything.
export async function inspectOpsDirectory(location, segments) {
  let current = location.opsPath;
  let display = OPS;
  for (const segment of ['', ...segments]) {
    if (segment !== '') {
      current = join(current, segment);
      display = `${display}/${segment}`;
    }
    const metadata = await lstatOrNull(current);
    if (metadata === null) return null;
    checkDirectory(location, metadata, display);
    if (!isWithin(location.root, await realpath(current))) throw unsafe(`${display} resolves outside the workflow root`);
  }
  return current;
}

// Same checks, creating each missing directory (non-recursive, so a race is an EEXIST that is re-checked).
export async function ensureOpsDirectory(location, segments) {
  let current = location.opsPath;
  let display = OPS;
  for (const segment of ['', ...segments]) {
    if (segment !== '') {
      current = join(current, segment);
      display = `${display}/${segment}`;
    }
    let metadata = await lstatOrNull(current);
    if (metadata === null) {
      try {
        await mkdir(current);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      metadata = await lstatOrNull(current);
      if (metadata === null) throw unsafe(`${display} disappeared while it was created`);
    }
    checkDirectory(location, metadata, display);
    if (!isWithin(location.root, await realpath(current))) throw unsafe(`${display} resolves outside the workflow root`);
  }
  return current;
}

// Directory fsync makes a rename or a new file durable on POSIX; Windows cannot open a directory, so it is skipped.
export async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

export async function renameWithRetry(from, to, sleep = realSleep) {
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

// temp file + fsync + rename (+ directory fsync): a reader sees the old bytes or the new bytes, never a mixture.
export async function writeFileAtomic(path, text) {
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(text);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await renameWithRetry(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await syncDirectory(resolve(path, '..'));
}

// append + fsync. The caller holds the repository lock, so appends of one file never interleave.
export async function appendFileDurable(path, text) {
  const created = (await lstatOrNull(path)) === null;
  const handle = await open(path, 'a');
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (created) await syncDirectory(resolve(path, '..'));
}

// Create or overwrite a small flag file and make it durable (no rename: the flag only has to exist or not).
export async function writeFileDurable(path, text) {
  const created = (await lstatOrNull(path)) === null;
  const handle = await open(path, 'w');
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (created) await syncDirectory(resolve(path, '..'));
}

// A crash can leave a partial last line. Under the lock it is removed so the next append starts on a clean line.
export async function repairTornTail(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (text === '' || text.endsWith('\n')) return false;
  const keep = Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1), 'utf8');
  await truncate(path, keep);
  return true;
}

export async function readTextIfExists(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function listDirectory(path) {
  if (path === null) return [];
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function removeFile(path) {
  await rm(path, { force: true, maxRetries: 3, retryDelay: 10 });
}

function isHandle(value) {
  return value !== null && typeof value === 'object' && typeof value.release === 'function' && typeof value.run_id === 'string';
}

// Runs fn(handle) under the repository lock. With `heldLock` (a handle the caller got from the lock module) it
// verifies that the handle still owns the lock instead of taking it again, which would deadlock a caller that
// is already inside its critical section. Returns { status: 'ok', value } or the lock's blocked result.
export async function withLockOrHeld({
  repositoryRoot, workflowRoot, heldLock, lockOptions, command,
}, fn) {
  if (heldLock !== undefined && heldLock !== null) {
    if (!isHandle(heldLock)) throw new TypeError('heldLock must be a handle returned by acquireRepositoryLock');
    const owner = await readLockOwner({ repositoryRoot, workflowRoot });
    if (owner.status !== 'valid' || owner.owner.run_id !== heldLock.run_id) {
      throw new TypeError('heldLock does not hold the repository lock any more: lease and journal writes need the lock');
    }
    return { status: 'ok', value: await fn(heldLock) };
  }
  const locked = await withRepositoryLock({ ...(lockOptions ?? {}), repositoryRoot, workflowRoot, command }, fn);
  return locked.status === 'ok' ? { status: 'ok', value: locked.value } : locked;
}
