// Closed `akrs.lock-owner/v1` record: validation, canonical rendering and tolerant parsing of owner.json.
import { isUlid } from '../../schemas/common.js';
import { validateIntegerRange, validateIsoTimestamp } from '../../schemas/primitives.js';
import { issue, validateClosedObject, validationResult } from '../../schemas/validation.js';
import { canonicalizeJson, parseStrictJson } from '../canonical/index.js';
import { LOCK_OWNER_KEYS, LOCK_OWNER_SCHEMA } from './policy.js';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_HOST_LENGTH = 255;
const MAX_COMMAND_LENGTH = 200;
const MAX_PID = 4294967295;
export const MAX_OWNER_BYTES = 4096;

function validateLabel(value, path, issues, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    issue(issues, path, 'invalid_value', `must be a string of 1 to ${maxLength} characters`);
  } else if (CONTROL_CHARACTERS.test(value)) {
    issue(issues, path, 'invalid_value', 'control characters are forbidden');
  }
}

export function validateLockOwner(value) {
  const issues = [];
  if (!validateClosedObject(value, LOCK_OWNER_KEYS, '$', issues)) return validationResult(issues);
  if (Object.hasOwn(value, 'schema') && value.schema !== LOCK_OWNER_SCHEMA) {
    issue(issues, '$.schema', 'invalid_value', `must be ${LOCK_OWNER_SCHEMA}`);
  }
  if (Object.hasOwn(value, 'pid')) validateIntegerRange(value.pid, '$.pid', issues, { min: 1, max: MAX_PID });
  if (Object.hasOwn(value, 'host')) validateLabel(value.host, '$.host', issues, MAX_HOST_LENGTH);
  if (Object.hasOwn(value, 'run_id') && !isUlid(value.run_id)) {
    issue(issues, '$.run_id', 'invalid_format', 'must be a ULID');
  }
  if (Object.hasOwn(value, 'command')) validateLabel(value.command, '$.command', issues, MAX_COMMAND_LENGTH);
  if (Object.hasOwn(value, 'acquired_at')) validateIsoTimestamp(value.acquired_at, '$.acquired_at', issues);
  return validationResult(issues);
}

export function renderLockOwner(owner) {
  const result = validateLockOwner(owner);
  if (!result.ok) {
    throw new TypeError(`invalid lock owner: ${result.issues.map(({ path, code }) => `${path} ${code}`).join(', ')}`);
  }
  return canonicalizeJson(owner, { keys: LOCK_OWNER_KEYS });
}

// Reads owner.json text without ever throwing: a record that cannot be trusted is reported with a reason.
export function parseLockOwner(text) {
  if (typeof text !== 'string' || text.length > MAX_OWNER_BYTES) return { ok: false, reason: 'owner_too_large' };
  const parsed = parseStrictJson(text);
  if (!parsed.ok) return { ok: false, reason: 'invalid_json' };
  if (!validateLockOwner(parsed.value).ok) return { ok: false, reason: 'invalid_schema' };
  return { ok: true, owner: Object.freeze({ ...parsed.value }) };
}

export function holderOf(owner) {
  return {
    pid: owner.pid,
    host: owner.host,
    run_id: owner.run_id,
    command: owner.command,
    acquired_at: owner.acquired_at,
  };
}

export function sameOwner(left, right) {
  return LOCK_OWNER_KEYS.every((key) => left[key] === right[key]);
}
