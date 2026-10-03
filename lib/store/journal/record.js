// The akrs.op/v1 state record (F8): closed, one compact canonical JSONL line per state change. `id` and `hash` come
// from the shared JSONL codec (id = ULID of the record, hash = sha256 over the record without `hash`).
import { SNAPSHOT_PATTERN, COMMAND_ID_PATTERN, isId, isUlid, isTimestamp, validateWorkflowPath } from '../../schemas/common.js';
import { isPlainObject, issue, validationResult } from '../../schemas/validation.js';
import { compareCodePoints } from '../canonical/index.js';
import { TARGET_SPEC } from './hashes.js';
import { OP_KEYS, OP_STATES, TARGET_KEYS } from './policy.js';

export const OP_SPEC = Object.freeze({
  keys: [...OP_KEYS],
  arrays: { changed: { kind: 'set' } },
  objects: { target: TARGET_SPEC },
  json: ['packet'],
});

const isSha = (value) => typeof value === 'string' && SNAPSHOT_PATTERN.test(value);

export function validateOpRecord(value) {
  const issues = [];
  const bad = (path, code, message) => issue(issues, path, code, message);
  if (!isPlainObject(value)) {
    bad('$', 'invalid_type', 'must be an object');
    return validationResult(issues);
  }
  for (const key of OP_KEYS) {
    if (!Object.hasOwn(value, key)) bad(`$.${key}`, 'missing_key', `missing required key: ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!OP_KEYS.includes(key)) bad(`$.${key}`, 'unknown_key', `unknown key: ${key}`);
  }
  const has = (key) => Object.hasOwn(value, key);
  if (has('id') && !isUlid(value.id)) bad('$.id', 'invalid_format', 'must be a ULID');
  if (has('hash') && !isSha(value.hash)) bad('$.hash', 'invalid_format', 'must be sha256:<64 lowercase hex>');
  if (has('ts') && !isTimestamp(value.ts)) bad('$.ts', 'invalid_format', 'must be an RFC 3339 UTC timestamp with milliseconds');
  if (has('request_id') && !isUlid(value.request_id)) bad('$.request_id', 'invalid_format', 'must be a ULID');
  if (has('command') && !(typeof value.command === 'string' && COMMAND_ID_PATTERN.test(value.command))) {
    bad('$.command', 'invalid_format', 'must be a stable command ID');
  }
  if (has('target')) {
    if (!isPlainObject(value.target)) {
      bad('$.target', 'invalid_type', 'must be an object');
    } else {
      for (const key of TARGET_KEYS) {
        if (!Object.hasOwn(value.target, key)) bad(`$.target.${key}`, 'missing_key', `missing required key: ${key}`);
        else if (value.target[key] !== null && !isId(value.target[key])) bad(`$.target.${key}`, 'invalid_format', 'must be an ID or null');
      }
      for (const key of Object.keys(value.target)) {
        if (!TARGET_KEYS.includes(key)) bad(`$.target.${key}`, 'unknown_key', `unknown key: ${key}`);
      }
    }
  }
  for (const key of ['request_hash', 'replay_key']) {
    if (has(key) && !isSha(value[key])) bad(`$.${key}`, 'invalid_format', 'must be sha256:<64 lowercase hex>');
  }
  if (has('state') && !OP_STATES.includes(value.state)) bad('$.state', 'invalid_value', `must be one of: ${OP_STATES.join(', ')}`);
  for (const key of ['expected_snapshot', 'before', 'after', 'packet_hash']) {
    if (has(key) && value[key] !== null && !isSha(value[key])) bad(`$.${key}`, 'invalid_format', 'must be null or sha256:<64 lowercase hex>');
  }
  if (has('changed')) {
    if (!Array.isArray(value.changed)) {
      bad('$.changed', 'invalid_type', 'must be an array');
    } else {
      value.changed.forEach((path, index) => issues.push(...validateWorkflowPath(path, `$.changed[${index}]`).issues));
      const ordered = value.changed.every((path, index) => index === 0 || (typeof path === 'string'
        && typeof value.changed[index - 1] === 'string' && compareCodePoints(value.changed[index - 1], path) < 0));
      if (!ordered) bad('$.changed', 'invalid_order', 'must be sorted and unique');
    }
  }
  if (has('packet') && value.packet !== null && !isPlainObject(value.packet)) bad('$.packet', 'invalid_type', 'must be null or an object');
  if (has('transaction') && value.transaction !== null && !isUlid(value.transaction)) {
    bad('$.transaction', 'invalid_format', 'must be null or a transaction ULID');
  }
  if (has('draft') && value.draft !== null) issues.push(...validateWorkflowPath(value.draft, '$.draft').issues);

  if (issues.length === 0) {
    if (value.state === 'committed') {
      if (value.packet === null) bad('$.packet', 'invalid_value', 'a committed record carries the final packet');
      if (value.packet_hash === null) bad('$.packet_hash', 'invalid_value', 'a committed record carries the packet hash');
    } else {
      if (value.packet !== null) bad('$.packet', 'invalid_value', 'only a committed record carries a packet');
      if (value.packet_hash !== null) bad('$.packet_hash', 'invalid_value', 'only a committed record carries a packet hash');
      if (value.after !== null) bad('$.after', 'invalid_value', 'only a committed record has an after snapshot');
      if (value.changed.length !== 0) bad('$.changed', 'invalid_value', 'only a committed record lists changed files');
    }
  }
  return validationResult(issues);
}
