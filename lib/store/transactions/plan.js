// Turns the operations a command rendered into a plan: every path proven safe, every operation checked against the
// files as they are NOW (under the lock), before and after bytes and hashes computed, created directories listed.
// Nothing is written here; a problem is a ChangeSetError (a usage error found before prepare).
import { join } from 'node:path';
import { PathSafetyError, createPathService } from '../path-service.js';
import { inspectPath, sha256 } from './files.js';
import { TRANSACTION_OPERATION_TYPES } from './policy.js';

export class ChangeSetError extends Error {
  constructor(path, reason) {
    super(`invalid transaction operation: ${reason}`);
    this.name = 'ChangeSetError';
    this.path = path;
    this.reason = reason;
  }
}

const OPERATION_KEYS = ['type', 'path', 'to', 'content'];
const RESERVED = ['.ops', '.cache'];

const isBytes = (value) => typeof value === 'string' || value instanceof Uint8Array;
const toBuffer = (value) => (typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value));

// Workflow-relative namespaces a transaction never writes (TRANSACTION_POLICY.targets).
function checkNamespace(path, type) {
  const segments = path.split('/');
  const first = segments[0].toLowerCase();
  if (RESERVED.includes(first)) throw new ChangeSetError(path, `${segments[0]} is a reserved CLI namespace, not a workflow artifact`);
  if (first === 'verifications' && segments[2]?.toLowerCase() === 'evidence') {
    throw new ChangeSetError(path, 'evidence is written by the Tester run, not by a transaction');
  }
  if (first === 'drafts' && type !== 'delete') {
    throw new ChangeSetError(path, 'a draft may only be deleted by a transaction, never created or changed');
  }
}

function safePath(pathService, value, label, type) {
  if (typeof value !== 'string') throw new ChangeSetError(null, `${label} must be a string`);
  try {
    pathService.assertWritableTarget(value);
  } catch (error) {
    if (error instanceof PathSafetyError) throw new ChangeSetError(value, error.message);
    throw error;
  }
  checkNamespace(value, type);
  return value;
}

// Walks the segments below the real workflow root with lstat: a link anywhere on the way (to another repository
// folder, for instance) is refused, a file in the middle of the chain is not a directory, and the missing tail is
// reported so created directories can be recorded. Returns { absolute, state, missing: [workflow-relative dirs] }.
export async function examine(root, path, label) {
  const segments = path.split('/');
  let current = root;
  const missing = [];
  let state = null;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    const last = index === segments.length - 1;
    const here = missing.length > 0 ? { kind: 'absent' } : await inspectPath(current);
    if (here.kind === 'link') throw new ChangeSetError(path, `${label} passes through a symbolic link or junction`);
    if (here.kind === 'other') throw new ChangeSetError(path, `${label} is not a regular file or directory`);
    if (here.kind === 'absent') {
      if (!last) missing.push(segments.slice(0, index + 1).join('/'));
      state = { kind: 'absent' };
      continue;
    }
    if (!last && here.kind !== 'dir') throw new ChangeSetError(path, `${segments.slice(0, index + 1).join('/')} is not a directory`);
    state = here;
  }
  return { absolute: current, state, missing };
}

export async function planOperations({ repositoryRoot, workflowRoot, root, operations }) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new ChangeSetError(null, 'a transaction needs at least one operation');
  }
  const pathService = await createPathService({ repositoryRoot: repositoryRoot ?? workflowRoot, workflowRoot });
  const used = new Map();
  const claim = (path, index) => {
    if (used.has(path)) throw new ChangeSetError(path, `path appears more than once (operations ${used.get(path)} and ${index})`);
    used.set(path, index);
  };
  const created = new Set();
  const planned = [];

  for (const [index, raw] of operations.entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ChangeSetError(null, `operation ${index} must be an object`);
    for (const key of Object.keys(raw)) {
      if (!OPERATION_KEYS.includes(key)) throw new ChangeSetError(null, `operation ${index} has an unknown key: ${key}`);
    }
    const { type } = raw;
    if (!TRANSACTION_OPERATION_TYPES.includes(type)) {
      throw new ChangeSetError(typeof raw.path === 'string' ? raw.path : null, `unknown operation type: ${String(type)}`);
    }
    const path = safePath(pathService, raw.path, 'path', type);
    const hasTo = raw.to !== undefined && raw.to !== null;
    if (type === 'move' && !hasTo) throw new ChangeSetError(path, 'a move needs a destination (to)');
    if (type !== 'move' && hasTo) throw new ChangeSetError(path, `a ${type} has no destination: only a move does`);
    const hasContent = raw.content !== undefined;
    if ((type === 'delete' || type === 'move') && hasContent) throw new ChangeSetError(path, `a ${type} carries no content`);
    if (['create', 'replace', 'append'].includes(type)) {
      if (!hasContent) throw new ChangeSetError(path, `a ${type} needs content`);
      if (!isBytes(raw.content)) throw new ChangeSetError(path, 'content must be a string or bytes');
    }
    const to = type === 'move' ? safePath(pathService, raw.to, 'to', 'move') : null;
    if (to !== null && to === path) throw new ChangeSetError(path, 'a move cannot target itself');
    if (type === 'move' && path.split('/')[0].toLowerCase() === 'drafts') {
      throw new ChangeSetError(path, 'a draft may only be deleted by a transaction, never moved');
    }
    claim(path, index);
    if (to !== null) claim(to, index);

    // the case check of the path service (a path that differs only in case from an existing entry)
    for (const candidate of [path, to].filter((value) => value !== null)) {
      let resolved;
      try {
        resolved = await pathService.resolveWorkflowPath(candidate);
      } catch (error) {
        if (error instanceof PathSafetyError) throw new ChangeSetError(candidate, error.message);
        throw error;
      }
      if (!resolved.case_matches) throw new ChangeSetError(candidate, 'path case does not match the existing filesystem entry');
    }

    const source = await examine(root, path, 'path');
    const operation = {
      index, type, path, to, absolute: source.absolute, absoluteTo: null, before: null, after: null,
    };
    const directoryProblem = (state) => (state.kind === 'dir' ? 'is a directory' : null);

    if (type === 'create') {
      if (source.state.kind === 'file') throw new ChangeSetError(path, 'file already exists: create needs an absent target');
      if (source.state.kind === 'dir') throw new ChangeSetError(path, 'target is a directory');
      operation.after = toBuffer(raw.content);
      for (const directory of source.missing) created.add(directory);
    } else {
      if (source.state.kind === 'absent') throw new ChangeSetError(path, `target does not exist: ${type} needs an existing file`);
      const problem = directoryProblem(source.state);
      if (problem !== null) throw new ChangeSetError(path, `target ${problem}`);
      operation.before = source.state.bytes;
      if (type === 'replace') operation.after = toBuffer(raw.content);
      if (type === 'append') {
        const added = toBuffer(raw.content);
        if (added.length === 0) throw new ChangeSetError(path, 'an append of empty content changes nothing');
        operation.after = Buffer.concat([source.state.bytes, added]);
      }
      if (type === 'move') {
        operation.after = source.state.bytes;
        const destination = await examine(root, to, 'to');
        if (destination.state.kind !== 'absent') throw new ChangeSetError(to, 'destination already exists');
        operation.absoluteTo = destination.absolute;
        for (const directory of destination.missing) created.add(directory);
      }
    }
    operation.before_hash = operation.before === null ? null : sha256(operation.before);
    operation.after_hash = operation.after === null ? null : sha256(operation.after);
    planned.push(operation);
  }

  // a directory one operation creates cannot also be a file another operation writes
  for (const directory of created) {
    if (used.has(directory)) throw new ChangeSetError(directory, 'path is both a file to write and a directory another operation needs');
  }
  const directories = [...created].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
  return { operations: planned, directories, root };
}

export const describePlan = (plan) => plan.operations.map(({ index, type, path, to, before_hash: beforeHash, after_hash: afterHash }) => ({
  index, type, path, to, before_hash: beforeHash, after_hash: afterHash,
}));
