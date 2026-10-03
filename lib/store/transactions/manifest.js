// The closed akrs.tx/v1 manifest: validation, canonical text, hashing and the atomic read/write of manifest.json.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { COMMAND_ID_PATTERN, SNAPSHOT_PATTERN, isTimestamp, isUlid } from '../../schemas/common.js';
import { isPlainObject, issue, validationResult } from '../../schemas/validation.js';
import { canonicalizeJson, parseStrictJson } from '../canonical/index.js';
import { readTextIfExists, writeFileAtomic } from '../ops-files.js';
import { validateRestrictedPath } from '../path-service.js';
import {
  MANIFEST_FILE,
  TRANSACTION_MANIFEST_KEYS,
  TRANSACTION_MANIFEST_SCHEMA,
  TRANSACTION_OPERATION_KEYS,
  TRANSACTION_OPERATION_TYPES,
  TRANSACTION_STATES,
} from './policy.js';

export const sha256Bytes = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const OPERATION_SPEC = Object.freeze({ keys: [...TRANSACTION_OPERATION_KEYS], arrays: {}, objects: {} });
const MANIFEST_SPEC = Object.freeze({
  keys: [...TRANSACTION_MANIFEST_KEYS],
  arrays: { operations: { kind: 'ordered', item: OPERATION_SPEC }, directories: { kind: 'ordered' } },
  objects: {},
});

const isHash = (value) => typeof value === 'string' && SNAPSHOT_PATTERN.test(value);
const pathProblem = (value) => {
  try {
    validateRestrictedPath(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'invalid path';
  }
};

function validateOperation(value, index, issues) {
  const base = `$.operations[${index}]`;
  if (!isPlainObject(value)) {
    issue(issues, base, 'invalid_type', 'must be an object');
    return;
  }
  for (const key of TRANSACTION_OPERATION_KEYS) {
    if (!Object.hasOwn(value, key)) issue(issues, `${base}.${key}`, 'missing_key', `missing required key: ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!TRANSACTION_OPERATION_KEYS.includes(key)) issue(issues, `${base}.${key}`, 'unknown_key', `unknown key: ${key}`);
  }
  if (value.index !== index) issue(issues, `${base}.index`, 'invalid_value', 'must equal the position in operations');
  if (!TRANSACTION_OPERATION_TYPES.includes(value.type)) {
    issue(issues, `${base}.type`, 'invalid_value', `must be one of: ${TRANSACTION_OPERATION_TYPES.join(', ')}`);
  }
  for (const key of ['path', 'to']) {
    if (key === 'to' && value.to === null) continue;
    if (!Object.hasOwn(value, key)) continue;
    const problem = typeof value[key] === 'string' ? pathProblem(value[key]) : 'must be a string';
    if (problem !== null) issue(issues, `${base}.${key}`, 'invalid_path', problem);
  }
  for (const key of ['before_hash', 'after_hash']) {
    if (Object.hasOwn(value, key) && value[key] !== null && !isHash(value[key])) {
      issue(issues, `${base}.${key}`, 'invalid_format', 'must be null or sha256:<64 lowercase hex>');
    }
  }
  if (!TRANSACTION_OPERATION_TYPES.includes(value.type)) return;
  const needsBefore = value.type !== 'create';
  const needsAfter = value.type !== 'delete';
  if (needsBefore !== (value.before_hash !== null)) {
    issue(issues, `${base}.before_hash`, 'invalid_value', needsBefore ? 'must be a hash' : 'a create has no before image');
  }
  if (needsAfter !== (value.after_hash !== null)) {
    issue(issues, `${base}.after_hash`, 'invalid_value', needsAfter ? 'must be a hash' : 'a delete has no after image');
  }
  if ((value.type === 'move') !== (value.to !== null)) {
    issue(issues, `${base}.to`, 'invalid_value', value.type === 'move' ? 'a move needs a destination' : 'only a move has a destination');
  }
  if (value.type === 'move' && value.before_hash !== value.after_hash) {
    issue(issues, `${base}.after_hash`, 'invalid_value', 'a move does not change content: after_hash must equal before_hash');
  }
}

export function validateTransactionManifest(value) {
  const issues = [];
  if (!isPlainObject(value)) {
    issue(issues, '$', 'invalid_type', 'must be an object');
    return validationResult(issues);
  }
  for (const key of TRANSACTION_MANIFEST_KEYS) {
    if (!Object.hasOwn(value, key)) issue(issues, `$.${key}`, 'missing_key', `missing required key: ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!TRANSACTION_MANIFEST_KEYS.includes(key)) issue(issues, `$.${key}`, 'unknown_key', `unknown key: ${key}`);
  }
  if (value.schema !== TRANSACTION_MANIFEST_SCHEMA) issue(issues, '$.schema', 'invalid_value', `must be ${TRANSACTION_MANIFEST_SCHEMA}`);
  if (!isUlid(value.id)) issue(issues, '$.id', 'invalid_format', 'must be a ULID');
  if (!isUlid(value.request_id)) issue(issues, '$.request_id', 'invalid_format', 'must be a ULID');
  if (!(typeof value.command === 'string' && COMMAND_ID_PATTERN.test(value.command))) {
    issue(issues, '$.command', 'invalid_format', 'must be a stable command ID');
  }
  if (!TRANSACTION_STATES.includes(value.state)) {
    issue(issues, '$.state', 'invalid_value', `must be one of: ${TRANSACTION_STATES.join(', ')}`);
  }
  if (!isTimestamp(value.created_at)) issue(issues, '$.created_at', 'invalid_format', 'must be an RFC 3339 UTC timestamp');
  if (value.committed_at !== null && !isTimestamp(value.committed_at)) {
    issue(issues, '$.committed_at', 'invalid_format', 'must be null or an RFC 3339 UTC timestamp');
  }
  let count = null;
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    issue(issues, '$.operations', 'invalid_type', 'must be a non-empty array');
  } else {
    count = value.operations.length;
    value.operations.forEach((operation, index) => validateOperation(operation, index, issues));
  }
  if (!Array.isArray(value.directories)) {
    issue(issues, '$.directories', 'invalid_type', 'must be an array');
  } else {
    value.directories.forEach((directory, index) => {
      const problem = typeof directory === 'string' ? pathProblem(directory) : 'must be a string';
      if (problem !== null) issue(issues, `$.directories[${index}]`, 'invalid_path', problem);
    });
  }
  if (!Number.isSafeInteger(value.progress) || value.progress < 0) {
    issue(issues, '$.progress', 'invalid_value', 'must be a non-negative integer');
  } else if (count !== null && value.progress > count) {
    issue(issues, '$.progress', 'out_of_range', 'cannot exceed the number of operations');
  }
  if (issues.length === 0) {
    if (['staging', 'prepared'].includes(value.state) && value.progress !== 0) {
      issue(issues, '$.progress', 'invalid_value', `a ${value.state} transaction has applied nothing`);
    }
    if (value.state === 'committed') {
      if (value.progress !== count) issue(issues, '$.progress', 'invalid_value', 'a committed transaction applied every operation');
      if (value.committed_at === null) issue(issues, '$.committed_at', 'invalid_value', 'a committed transaction has committed_at');
    } else if (value.committed_at !== null) {
      issue(issues, '$.committed_at', 'invalid_value', 'only a committed transaction has committed_at');
    }
  }
  return validationResult(issues);
}

export function renderManifest(manifest) {
  return canonicalizeJson(manifest, MANIFEST_SPEC);
}

export async function writeManifest(directory, manifest) {
  await writeFileAtomic(join(directory, MANIFEST_FILE), renderManifest(manifest));
}

// { status: 'absent' } | { status: 'corrupt', reason } | { status: 'ok', manifest }
export async function readManifest(directory, expectedId) {
  const text = await readTextIfExists(join(directory, MANIFEST_FILE));
  if (text === null) return { status: 'absent' };
  const parsed = parseStrictJson(text);
  if (!parsed.ok) return { status: 'corrupt', reason: 'not valid JSON' };
  const verdict = validateTransactionManifest(parsed.value);
  if (!verdict.ok) return { status: 'corrupt', reason: `${verdict.issues[0].path} ${verdict.issues[0].code}` };
  if (parsed.value.id !== expectedId) return { status: 'corrupt', reason: 'manifest id differs from its directory' };
  return { status: 'ok', manifest: parsed.value };
}
