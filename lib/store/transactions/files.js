// Durable file primitives of the transaction engine (fsync contract: TRANSACTION_POLICY.fsync). Everything here is
// called under the repository lock with absolute paths the plan already proved to be contained.
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rm, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { renameWithRetry, syncDirectory } from '../ops-files.js';

export const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const isMissing = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

// { kind: 'absent' } | { kind: 'file', bytes, hash } | { kind: 'dir' } | { kind: 'link' } | { kind: 'other' }
export async function inspectPath(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return { kind: 'absent' };
    throw error;
  }
  if (metadata.isSymbolicLink()) return { kind: 'link' };
  if (metadata.isDirectory()) return { kind: 'dir' };
  if (!metadata.isFile()) return { kind: 'other' };
  const bytes = await readFile(path);
  return { kind: 'file', bytes, hash: sha256(bytes) };
}

export async function readBytesIfFile(path) {
  const state = await inspectPath(path);
  return state.kind === 'file' ? state.bytes : null;
}

// open + write + fsync + close; `flag` 'wx' refuses to overwrite.
async function writeSynced(path, bytes, flag) {
  const handle = await open(path, flag);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// A new file inside the transaction directory (an image): created exclusively, fsynced, directory fsynced.
export async function createDurableFile(path, bytes) {
  await writeSynced(path, bytes, 'wx');
  await syncDirectory(dirname(path));
}

// Replaces `target` with `bytes` through a temporary file that lives in `temporary` (inside the transaction
// directory, so a crash never leaves a stray file in the artifact tree), then renames it over the target.
export async function replaceViaTemporary(temporary, target, bytes) {
  await writeSynced(temporary, bytes, 'w');
  try {
    await renameWithRetry(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await syncDirectory(dirname(target));
}

export async function removeDurable(path) {
  await rm(path, { force: true, maxRetries: 3, retryDelay: 10 });
  await syncDirectory(dirname(path));
}

// Creates one directory (the parent must exist) and makes the new entry durable; an existing directory is fine.
export async function makeDirectoryDurable(path) {
  try {
    await mkdir(path);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return;
  }
  await syncDirectory(dirname(path));
}

// Removes a directory only when it is empty; anything else (or an absent directory) is left alone.
export async function removeDirectoryIfEmpty(path) {
  try {
    if ((await readdir(path)).length > 0) return false;
    await rmdir(path);
  } catch (error) {
    if (isMissing(error) || error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') return false;
    throw error;
  }
  await syncDirectory(dirname(path));
  return true;
}
