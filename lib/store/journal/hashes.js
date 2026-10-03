// The two journal hashes (F8): request_hash for caller-supplied-ID conflicts, replay_key for the A1 replay rule.
// Both are contentHash over closed canonical compact JSON, so key order, whitespace and platform never matter.
import { COMMAND_ID_PATTERN, SNAPSHOT_PATTERN, isId, isUlid } from '../../schemas/common.js';
import { canonicalizeJsonCompact, contentHash } from '../canonical/index.js';
import {
  JOURNAL_REPLAY_AGAIN_SCHEMA,
  JOURNAL_REPLAY_SCHEMA,
  JOURNAL_REQUEST_SCHEMA,
  TARGET_KEYS,
} from './policy.js';

export const TARGET_SPEC = Object.freeze({ keys: [...TARGET_KEYS], arrays: {}, objects: {} });

const REQUEST_SPEC = Object.freeze({
  keys: ['schema', 'command', 'target', 'input', 'expected_snapshot'],
  arrays: {},
  objects: { target: TARGET_SPEC },
  json: ['input'],
});
const REPLAY_SPEC = Object.freeze({
  keys: ['schema', 'command', 'target', 'input'],
  arrays: {},
  objects: { target: TARGET_SPEC },
  json: ['input'],
});
const SALT_SPEC = Object.freeze({ keys: ['schema', 'replay_key', 'request_id'], arrays: {}, objects: {} });

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function checkCommand(command) {
  if (typeof command !== 'string' || !COMMAND_ID_PATTERN.test(command)) {
    throw new TypeError('command must be a stable command ID');
  }
  return command;
}

// { road?, plan? } -> the closed { road, plan } with null for absent members.
export function normalizeTarget(target = {}) {
  if (!isPlainObject(target)) throw new TypeError('target must be an object { road, plan }, never a bare string');
  for (const key of Object.keys(target)) {
    if (!TARGET_KEYS.includes(key)) throw new TypeError(`unknown target key: ${key}`);
  }
  const normalized = {};
  for (const key of TARGET_KEYS) {
    const value = target[key];
    if (value === undefined || value === null) normalized[key] = null;
    else if (isId(value)) normalized[key] = value;
    else throw new TypeError(`target.${key} must be a valid ID or null`);
  }
  return normalized;
}

export function checkExpectedSnapshot(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !SNAPSHOT_PATTERN.test(value)) {
    throw new TypeError('expected snapshot must be null or a sha256 snapshot');
  }
  return value;
}

export function computeRequestHash({ command, target, input, expectedSnapshot = null } = {}) {
  return contentHash(canonicalizeJsonCompact({
    schema: JOURNAL_REQUEST_SCHEMA,
    command: checkCommand(command),
    target: normalizeTarget(target),
    input,
    expected_snapshot: checkExpectedSnapshot(expectedSnapshot),
  }, REQUEST_SPEC));
}

export function computeReplayKey({ command, target, input } = {}) {
  return contentHash(canonicalizeJsonCompact({
    schema: JOURNAL_REPLAY_SCHEMA,
    command: checkCommand(command),
    target: normalizeTarget(target),
    input,
  }, REPLAY_SPEC));
}

export function saltReplayKey(replayKey, requestId) {
  if (typeof replayKey !== 'string' || !SNAPSHOT_PATTERN.test(replayKey)) {
    throw new TypeError('replayKey must be a sha256 hash');
  }
  if (!isUlid(requestId)) throw new TypeError('requestId must be a ULID');
  return contentHash(canonicalizeJsonCompact({
    schema: JOURNAL_REPLAY_AGAIN_SCHEMA,
    replay_key: replayKey,
    request_id: requestId,
  }, SALT_SPEC));
}

const PACKET_SPEC = Object.freeze({ keys: ['packet'], arrays: {}, objects: {}, json: ['packet'] });

// Hash of the final packet's canonical form (12-... section 4: "final packet hash").
export function computePacketHash(packet) {
  return contentHash(canonicalizeJsonCompact({ packet }, PACKET_SPEC));
}
