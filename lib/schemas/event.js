import { EVENT_TYPES, RUN_ID_PATTERN, isTimestamp } from './common.js';
import { validatePacket } from './packet.js';
import {
  isPlainObject,
  issue,
  validateClosedObject,
  validateJsonValue,
  validationResult,
} from './validation.js';

export const EVENT_KEYS = Object.freeze([
  'schema_version',
  'run_id',
  'sequence',
  'timestamp',
  'type',
  'data',
]);

export function validateEvent(value, { knownCommands } = {}) {
  const issues = [];
  if (!validateClosedObject(value, EVENT_KEYS, '$', issues)) return validationResult(issues);

  if (value.schema_version !== 'akrs.event/v1') {
    issue(issues, '$.schema_version', 'invalid_value', 'must be akrs.event/v1');
  }
  if (typeof value.run_id !== 'string' || !RUN_ID_PATTERN.test(value.run_id)) {
    issue(issues, '$.run_id', 'invalid_format', 'must be a 26-character ULID');
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    issue(issues, '$.sequence', 'invalid_value', 'must be a positive integer');
  }
  if (!isTimestamp(value.timestamp)) {
    issue(issues, '$.timestamp', 'invalid_format', 'must be an RFC 3339 UTC timestamp with milliseconds');
  }
  if (!EVENT_TYPES.includes(value.type)) {
    issue(issues, '$.type', 'invalid_value', `must be one of: ${EVENT_TYPES.join(', ')}`);
  }
  if (!isPlainObject(value.data)) {
    issue(issues, '$.data', 'invalid_type', 'must be an object');
  } else if (value.type === 'complete') {
    if (!validateClosedObject(value.data, ['packet'], '$.data', issues)) return validationResult(issues);
    const packetResult = validatePacket(value.data.packet, { knownCommands });
    issues.push(...packetResult.issues.map((entry) => ({ ...entry, path: `$.data.packet${entry.path.slice(1)}` })));
    if (value.data.packet?.run_id !== value.run_id) {
      issue(issues, '$.run_id', 'run_id_mismatch', 'complete event and packet run IDs must match');
    }
  } else {
    validateJsonValue(value.data, '$.data', issues);
  }
  return validationResult(issues);
}
