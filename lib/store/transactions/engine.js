// The transaction engine: stage, apply, recover and remove one transaction directory under <workflow>/.ops/tx.
// Decisions and the exact recovery rule are documented in TRANSACTION_POLICY; this file implements them and does not
// know about the journal or packets except through the plain values handed in.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { validatePacket } from '../../schemas/packet.js';
import { parseStrictJson } from '../canonical/index.js';
import {
  ensureOpsDirectory,
  inspectOpsDirectory,
  listDirectory,
  readTextIfExists,
  syncDirectory,
  writeFileAtomic,
} from '../ops-files.js';
import { isUlid } from '../../schemas/common.js';
import {
  createDurableFile,
  inspectPath,
  makeDirectoryDurable,
  removeDirectoryIfEmpty,
  removeDurable,
  replaceViaTemporary,
} from './files.js';
import { readManifest, writeManifest } from './manifest.js';
import { ChangeSetError, examine } from './plan.js';
import {
  AFTER_DIRECTORY,
  BEFORE_DIRECTORY,
  MANIFEST_FILE,
  PACKET_FILE,
  TRANSACTION_DIRECTORY,
  TRANSACTION_DISPLAY_PATH,
  TRANSACTION_FINDING_CODES,
  TRANSACTION_MANIFEST_SCHEMA,
} from './policy.js';

// Thrown by apply when the files are not what the plan saw (a non-CLI writer under the lock).
export class TransactionConflictError extends Error {
  constructor(path, reason) {
    super(`transaction conflict at ${path}: ${reason}`);
    this.name = 'TransactionConflictError';
    this.path = path;
  }
}

// A recovery that cannot be proven: carried as a value, never thrown across the module boundary.
class Blocked extends Error {
  constructor(reason, path = null) {
    super(`recovery blocked: ${reason}`);
    this.reason = reason;
    this.path = path;
  }
}

export const displayOf = (id, ...segments) => [TRANSACTION_DISPLAY_PATH, id, ...segments].join('/');
const absoluteOf = (root, path) => join(root, ...path.split('/'));
const imageName = (index) => String(index);

export function createTransactionContext({ location, requestId = null, command = null, boundary = null, id = null }) {
  return { location, root: location.root, requestId, command, boundary, id };
}

const withId = (ctx, id, extra = {}) => ({ ...ctx, id, ...extra });

export async function fire(ctx, point, extra = {}) {
  if (ctx.boundary === null || ctx.boundary === undefined) return;
  await ctx.boundary({
    point, index: null, request_id: ctx.requestId, transaction: ctx.id, command: ctx.command, ...extra,
  });
}

export function recoveryFinding({ transaction, requestId = null, reason, path = null }) {
  return {
    code: TRANSACTION_FINDING_CODES.recovery_blocked,
    severity: 'error',
    message: `Transaction ${transaction} cannot be recovered automatically (${reason}); nothing was changed.`,
    file: null,
    line: null,
    detail: { transaction, request_id: requestId, reason, path },
  };
}

async function transactionDirectory(ctx, id) {
  return inspectOpsDirectory(ctx.location, [TRANSACTION_DIRECTORY, id]);
}

export async function listTransactionIds(ctx) {
  const directory = await inspectOpsDirectory(ctx.location, [TRANSACTION_DIRECTORY]);
  return (await listDirectory(directory)).filter((name) => isUlid(name));
}

// ---- staging ---------------------------------------------------------------------------------------------
export async function stageTransaction(ctx, plan, { requestId, command, now }) {
  if ((await transactionDirectory(ctx, ctx.id)) !== null) throw new Error(`transaction directory ${ctx.id} already exists`);
  const dir = await ensureOpsDirectory(ctx.location, [TRANSACTION_DIRECTORY, ctx.id]);
  await ensureOpsDirectory(ctx.location, [TRANSACTION_DIRECTORY, ctx.id, BEFORE_DIRECTORY]);
  await ensureOpsDirectory(ctx.location, [TRANSACTION_DIRECTORY, ctx.id, AFTER_DIRECTORY]);
  await syncDirectory(ctx.location.opsPath);
  await syncDirectory(join(ctx.location.opsPath, TRANSACTION_DIRECTORY));
  await syncDirectory(dir);

  for (const operation of plan.operations) {
    if (operation.before !== null) {
      await createDurableFile(join(dir, BEFORE_DIRECTORY, imageName(operation.index)), operation.before);
      await fire(ctx, 'before_image_written', { index: operation.index });
    }
    if (operation.after !== null) {
      await createDurableFile(join(dir, AFTER_DIRECTORY, imageName(operation.index)), operation.after);
      await fire(ctx, 'after_image_written', { index: operation.index });
    }
  }
  const manifest = {
    schema: TRANSACTION_MANIFEST_SCHEMA,
    id: ctx.id,
    request_id: requestId,
    command,
    state: 'staging',
    operations: plan.operations.map(({ index, type, path, to, before_hash: beforeHash, after_hash: afterHash }) => ({
      index, type, path, to, before_hash: beforeHash, after_hash: afterHash,
    })),
    directories: [...plan.directories],
    progress: 0,
    created_at: now(),
    committed_at: null,
  };
  await writeManifest(dir, manifest);
  await fire(ctx, 'manifest_staged');
  const prepared = { ...manifest, state: 'prepared' };
  await writeManifest(dir, prepared);
  await fire(ctx, 'manifest_prepared');
  return { dir, manifest: prepared };
}

// ---- applying --------------------------------------------------------------------------------------------
async function expectFile(operation, absolute, hash, label) {
  const state = await inspectPath(absolute);
  if (state.kind !== 'file' || state.hash !== hash) throw new TransactionConflictError(label, 'the file is not the one the plan read');
  return state;
}

async function applyOne(ctx, dir, operation) {
  const temporary = join(dir, `apply-${operation.index}.tmp`);
  const target = absoluteOf(ctx.root, operation.path);
  if (operation.type === 'create') {
    const state = await inspectPath(target);
    if (state.kind !== 'absent') throw new TransactionConflictError(operation.path, 'the target appeared after the plan');
    await replaceViaTemporary(temporary, target, operation.after);
  } else if (operation.type === 'replace' || operation.type === 'append') {
    await expectFile(operation, target, operation.before_hash, operation.path);
    await replaceViaTemporary(temporary, target, operation.after);
  } else if (operation.type === 'delete') {
    await expectFile(operation, target, operation.before_hash, operation.path);
    await removeDurable(target);
  } else {
    const destination = absoluteOf(ctx.root, operation.to);
    await expectFile(operation, target, operation.before_hash, operation.path);
    if ((await inspectPath(destination)).kind !== 'absent') {
      throw new TransactionConflictError(operation.to, 'the destination appeared after the plan');
    }
    await replaceViaTemporary(temporary, destination, operation.after);
    await removeDurable(target);
  }
}

// Applies the planned operations in order; the manifest records durable progress after each one.
export async function applyOperations(ctx, dir, plan, manifest) {
  for (const directory of manifest.directories) await makeDirectoryDurable(absoluteOf(ctx.root, directory));
  let current = manifest;
  for (const operation of plan.operations) {
    await applyOne(ctx, dir, operation);
    current = { ...current, state: 'applying', progress: operation.index + 1 };
    await writeManifest(dir, current);
    await fire(ctx, 'operation_applied', { index: operation.index });
  }
  return current;
}

export async function writePacketFile(dir, packet) {
  await writeFileAtomic(join(dir, PACKET_FILE), `${JSON.stringify(packet, null, 2)}\n`);
}

export async function writeCommitMarker(dir, manifest, committedAt) {
  const committed = { ...manifest, state: 'committed', progress: manifest.operations.length, committed_at: committedAt };
  await writeManifest(dir, committed);
  return committed;
}

// ---- recovery --------------------------------------------------------------------------------------------
async function safeTarget(ctx, path) {
  const first = path.split('/')[0].toLowerCase();
  if (first === '.ops' || first === '.cache') throw new Blocked('target_unexpected', path);
  try {
    return (await examine(ctx.root, path, 'path')).absolute;
  } catch (error) {
    if (error instanceof ChangeSetError) throw new Blocked('target_unexpected', path);
    throw error;
  }
}

// A staged image, trusted only when its bytes hash to the manifest hash.
async function loadImage(ctx, dir, id, kind, operation) {
  const hash = kind === BEFORE_DIRECTORY ? operation.before_hash : operation.after_hash;
  const display = displayOf(id, kind, imageName(operation.index));
  if (hash === null) throw new Blocked('image_missing', display);
  const state = await inspectPath(join(dir, kind, imageName(operation.index)));
  if (state.kind === 'absent') throw new Blocked('image_missing', display);
  if (state.kind !== 'file' || state.hash !== hash) throw new Blocked('image_corrupt', display);
  return state.bytes;
}

const writeAction = (path, bytes, index) => ({ kind: 'write', path, bytes, index });
const removeAction = (path, index) => ({ kind: 'remove', path, index });

// Restore: every operation, newest first, back to its before image. Pure planning: no byte is written here.
async function planRestore(ctx, dir, manifest) {
  const actions = [];
  for (const operation of [...manifest.operations].reverse()) {
    const target = await safeTarget(ctx, operation.path);
    const current = await inspectPath(target);
    const unexpected = () => new Blocked('target_unexpected', operation.path);
    const is = (state, hash) => state.kind === 'file' && state.hash === hash;
    const restoreBefore = async () => writeAction(target, await loadImage(ctx, dir, manifest.id, BEFORE_DIRECTORY, operation), operation.index);

    if (operation.type === 'create') {
      if (current.kind === 'absent') continue;
      if (!is(current, operation.after_hash)) throw unexpected();
      actions.push(removeAction(target, operation.index));
    } else if (operation.type === 'replace' || operation.type === 'append') {
      if (is(current, operation.before_hash)) continue;
      if (!is(current, operation.after_hash)) throw unexpected();
      actions.push(await restoreBefore());
    } else if (operation.type === 'delete') {
      if (is(current, operation.before_hash)) continue;
      if (current.kind !== 'absent') throw unexpected();
      actions.push(await restoreBefore());
    } else {
      const destination = await safeTarget(ctx, operation.to);
      const moved = await inspectPath(destination);
      if (is(current, operation.before_hash) && moved.kind === 'absent') continue;
      if (current.kind !== 'absent' && !is(current, operation.before_hash)) throw unexpected();
      if (moved.kind !== 'absent' && !is(moved, operation.after_hash)) throw new Blocked('target_unexpected', operation.to);
      if (current.kind === 'absent') actions.push(await restoreBefore());
      if (moved.kind !== 'absent') actions.push(removeAction(destination, operation.index));
    }
  }
  return actions;
}

// Roll forward: every operation, in order, to its after image.
async function planForward(ctx, dir, manifest) {
  const actions = [];
  for (const operation of manifest.operations) {
    const target = await safeTarget(ctx, operation.path);
    const current = await inspectPath(target);
    const unexpected = () => new Blocked('target_unexpected', operation.path);
    const is = (state, hash) => state.kind === 'file' && state.hash === hash;
    const applyAfter = async (path) => writeAction(path, await loadImage(ctx, dir, manifest.id, AFTER_DIRECTORY, operation), operation.index);

    if (operation.type === 'create') {
      if (is(current, operation.after_hash)) continue;
      if (current.kind !== 'absent') throw unexpected();
      actions.push(await applyAfter(target));
    } else if (operation.type === 'replace' || operation.type === 'append') {
      if (is(current, operation.after_hash)) continue;
      if (!is(current, operation.before_hash)) throw unexpected();
      actions.push(await applyAfter(target));
    } else if (operation.type === 'delete') {
      if (current.kind === 'absent') continue;
      if (!is(current, operation.before_hash)) throw unexpected();
      actions.push(removeAction(target, operation.index));
    } else {
      const destination = await safeTarget(ctx, operation.to);
      const moved = await inspectPath(destination);
      if (!is(moved, operation.after_hash) && moved.kind !== 'absent') throw new Blocked('target_unexpected', operation.to);
      if (current.kind !== 'absent' && !is(current, operation.before_hash)) throw unexpected();
      if (moved.kind === 'absent') {
        if (current.kind === 'absent') throw unexpected(); // neither copy exists: nothing can be proven
        actions.push(await applyAfter(destination));
      }
      if (current.kind !== 'absent') actions.push(removeAction(target, operation.index));
    }
  }
  return actions;
}

async function perform(ctx, actions, direction, manifest) {
  if (direction === 'forward') {
    for (const directory of manifest.directories) await makeDirectoryDurable(absoluteOf(ctx.root, directory));
  }
  for (const action of actions) {
    if (action.kind === 'write') {
      await replaceViaTemporary(join(ctx.scratch, `recover-${action.index}.tmp`), action.path, action.bytes);
    } else {
      await removeDurable(action.path);
    }
    await fire(ctx, 'recovery_step', { index: action.index, direction });
  }
}

async function removeCreatedDirectories(ctx, manifest) {
  const deepestFirst = [...manifest.directories].sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? 1 : -1));
  for (const directory of deepestFirst) await removeDirectoryIfEmpty(absoluteOf(ctx.root, directory));
}

async function readStoredPacket(dir, manifest) {
  const display = displayOf(manifest.id, PACKET_FILE);
  const text = await readTextIfExists(join(dir, PACKET_FILE));
  if (text === null) throw new Blocked('packet_missing', display);
  const parsed = parseStrictJson(text);
  if (!parsed.ok) throw new Blocked('packet_corrupt', display);
  const verdict = validatePacket(parsed.value);
  if (!verdict.ok || parsed.value.request_id !== manifest.request_id || parsed.value.command !== manifest.command
    || !['ok', 'warning'].includes(parsed.value.status)) {
    throw new Blocked('packet_corrupt', display);
  }
  return parsed.value;
}

// Decides and performs the recovery of ONE transaction directory.
//   owned: the journal holds a prepared record that names this transaction.
// Returns { outcome, request_id, manifest?, packet? } with outcome one of
//   discarded | rolled_back | rolled_forward | committed_orphan | gone | blocked (with `finding`).
// The directory is never removed here; the caller removes it once the journal agrees.
export async function recoverOne(baseCtx, id, { owned, expectedRequestId = null }) {
  const ctx = withId(baseCtx, id);
  await fire(ctx, 'recovery_started');
  let requestId = expectedRequestId;
  const blocked = (reason, path = null) => ({
    outcome: 'blocked', request_id: requestId, finding: recoveryFinding({ transaction: id, requestId, reason, path }),
  });
  try {
    const dir = await transactionDirectory(baseCtx, id);
    if (dir === null) return owned ? blocked('directory_missing', displayOf(id)) : { outcome: 'gone', request_id: requestId };
    ctx.scratch = dir;
    const read = await readManifest(dir, id);
    if (read.status === 'absent') {
      return owned ? blocked('manifest_corrupt', displayOf(id, MANIFEST_FILE)) : { outcome: 'discarded', request_id: requestId };
    }
    if (read.status === 'corrupt') return blocked('manifest_corrupt', displayOf(id, MANIFEST_FILE));
    const { manifest } = read;
    requestId = manifest.request_id;
    ctx.requestId = requestId;
    ctx.command = manifest.command;
    if (expectedRequestId !== null && manifest.request_id !== expectedRequestId) return blocked('journal_mismatch', displayOf(id, MANIFEST_FILE));

    if (manifest.state === 'staging') {
      return owned ? blocked('journal_mismatch', displayOf(id, MANIFEST_FILE)) : { outcome: 'discarded', request_id: requestId, manifest };
    }
    if (manifest.state === 'committed') {
      if (!owned) return { outcome: 'committed_orphan', request_id: requestId, manifest };
      const packet = await readStoredPacket(dir, manifest);
      const actions = await planForward(ctx, dir, manifest);
      await perform(ctx, actions, 'forward', manifest);
      if ((await planForward(ctx, dir, manifest)).length > 0) throw new Blocked('target_unexpected', null);
      await fire(ctx, 'recovery_completed', { outcome: 'rolled_forward' });
      return { outcome: 'rolled_forward', request_id: requestId, manifest, packet };
    }
    const actions = await planRestore(ctx, dir, manifest);
    await perform(ctx, actions, 'restore', manifest);
    await removeCreatedDirectories(ctx, manifest);
    if ((await planRestore(ctx, dir, manifest)).length > 0) throw new Blocked('target_unexpected', null);
    await fire(ctx, 'recovery_completed', { outcome: 'rolled_back' });
    return { outcome: 'rolled_back', request_id: requestId, manifest };
  } catch (error) {
    if (error instanceof Blocked) return blocked(error.reason, error.path);
    throw error;
  }
}

// Removes a transaction directory. Order: packet and apply scratch, images, then (after a boundary) the manifest
// last, so an interrupted removal still leaves the proof a later recovery needs.
export async function removeTransaction(baseCtx, id, { cleanupBoundaries = false } = {}) {
  const ctx = withId(baseCtx, id);
  const dir = await transactionDirectory(baseCtx, id);
  if (dir === null) return false;
  if (cleanupBoundaries) await fire(ctx, 'cleanup_started');
  for (const name of await listDirectory(dir)) {
    if (name === MANIFEST_FILE || name === BEFORE_DIRECTORY || name === AFTER_DIRECTORY) continue;
    await rm(join(dir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
  for (const name of [BEFORE_DIRECTORY, AFTER_DIRECTORY]) {
    await rm(join(dir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
  await syncDirectory(dir);
  if (cleanupBoundaries) await fire(ctx, 'cleanup_images_removed');
  await rm(join(dir, MANIFEST_FILE), { force: true, maxRetries: 3, retryDelay: 10 });
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  await syncDirectory(join(ctx.location.opsPath, TRANSACTION_DIRECTORY));
  if (cleanupBoundaries) await fire(ctx, 'cleanup_finished');
  return true;
}
