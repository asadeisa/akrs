import {
  COMMAND_ID_PATTERN,
  PACKET_STATUSES,
  RUN_ID_PATTERN,
  SNAPSHOT_PATTERN,
  compareStrings,
  isPortableAbsolutePath,
  isSortedUnique,
  isTimestamp,
  validateWorkflowPath,
} from './common.js';
import { compareFindings, validateFinding } from './finding.js';
import {
  isPlainObject,
  issue,
  validateClosedObject,
  validateJsonValue,
  validationResult,
} from './validation.js';

export const PACKET_KEYS = Object.freeze([
  'schema_version',
  'command',
  'run_id',
  'request_id',
  'timestamp',
  'status',
  'root',
  'snapshot',
  'data',
  'findings',
  'changed',
  'next_commands',
]);

const SNAPSHOT_KEYS = Object.freeze(['before', 'after']);
const NEXT_COMMAND_KEYS = Object.freeze(['command', 'args']);

function validateSnapshot(snapshot, path, issues) {
  if (!validateClosedObject(snapshot, SNAPSHOT_KEYS, path, issues)) return;
  for (const key of SNAPSHOT_KEYS) {
    const value = snapshot[key];
    if (value !== null && (typeof value !== 'string' || !SNAPSHOT_PATTERN.test(value))) {
      issue(issues, `${path}.${key}`, 'invalid_format', 'must be null or a sha256 snapshot');
    }
  }
}

function validateNextCommand(value, path, issues, knownCommands) {
  if (!validateClosedObject(value, NEXT_COMMAND_KEYS, path, issues)) return;
  if (typeof value.command !== 'string' || !COMMAND_ID_PATTERN.test(value.command)) {
    issue(issues, `${path}.command`, 'invalid_format', 'must be a stable command ID');
  } else if (knownCommands && !knownCommands.includes(value.command)) {
    issue(issues, `${path}.command`, 'unknown_command', 'command is not enabled');
  }
  if (!Array.isArray(value.args)) {
    issue(issues, `${path}.args`, 'invalid_type', 'must be an array');
  } else {
    value.args.forEach((argument, index) => {
      if (typeof argument !== 'string' || argument.length === 0 || /[\u0000-\u001f\u007f]/.test(argument)) {
        issue(issues, `${path}.args[${index}]`, 'invalid_value', 'must be a non-empty control-free string');
      }
    });
  }
}

export function validatePacket(value, { knownCommands } = {}) {
  const issues = [];
  if (!validateClosedObject(value, PACKET_KEYS, '$', issues)) return validationResult(issues);

  if (value.schema_version !== 'akrs.packet/v2') {
    issue(issues, '$.schema_version', 'invalid_value', 'must be akrs.packet/v2');
  }
  if (typeof value.command !== 'string' || !COMMAND_ID_PATTERN.test(value.command)) {
    issue(issues, '$.command', 'invalid_format', 'must be a stable command ID');
  } else if (knownCommands && !knownCommands.includes(value.command)) {
    issue(issues, '$.command', 'unknown_command', 'command is not enabled');
  }
  if (typeof value.run_id !== 'string' || !RUN_ID_PATTERN.test(value.run_id)) {
    issue(issues, '$.run_id', 'invalid_format', 'must be a 26-character ULID');
  }
  if (value.request_id !== null
    && (typeof value.request_id !== 'string' || !RUN_ID_PATTERN.test(value.request_id))) {
    issue(issues, '$.request_id', 'invalid_format', 'must be null or a 26-character ULID');
  }
  if (!isTimestamp(value.timestamp)) {
    issue(issues, '$.timestamp', 'invalid_format', 'must be an RFC 3339 UTC timestamp with milliseconds');
  }
  if (!PACKET_STATUSES.includes(value.status)) {
    issue(issues, '$.status', 'invalid_value', `must be one of: ${PACKET_STATUSES.join(', ')}`);
  }
  if (!isPortableAbsolutePath(value.root)) {
    issue(issues, '$.root', 'invalid_path', 'must be a normalized absolute / path');
  }

  validateSnapshot(value.snapshot, '$.snapshot', issues);
  if (!isPlainObject(value.data)) {
    issue(issues, '$.data', 'invalid_type', 'must be an object');
  } else {
    validateJsonValue(value.data, '$.data', issues);
  }

  if (!Array.isArray(value.findings)) {
    issue(issues, '$.findings', 'invalid_type', 'must be an array');
  } else {
    value.findings.forEach((finding, index) => {
      issues.push(...validateFinding(finding, { path: `$.findings[${index}]` }).issues);
    });
    if (!isSortedUnique(value.findings, compareFindings)) {
      issue(issues, '$.findings', 'invalid_order', 'must be sorted and unique');
    }
  }

  if (!Array.isArray(value.changed)) {
    issue(issues, '$.changed', 'invalid_type', 'must be an array');
  } else {
    value.changed.forEach((path, index) => {
      issues.push(...validateWorkflowPath(path, `$.changed[${index}]`).issues);
    });
    if (!isSortedUnique(value.changed, compareStrings)) {
      issue(issues, '$.changed', 'invalid_order', 'must be sorted and unique');
    }
  }

  if (!Array.isArray(value.next_commands)) {
    issue(issues, '$.next_commands', 'invalid_type', 'must be an array');
  } else {
    value.next_commands.forEach((command, index) => {
      validateNextCommand(command, `$.next_commands[${index}]`, issues, knownCommands);
    });
  }

  return validationResult(issues);
}

export function validateMutationChanges(packet, actualChanged) {
  const issues = [];
  if (packet?.request_id === null || packet?.request_id === undefined) {
    issue(issues, '$.request_id', 'missing_request_id', 'mutation packets require a request ID');
  } else if (typeof packet.request_id !== 'string' || !RUN_ID_PATTERN.test(packet.request_id)) {
    issue(issues, '$.request_id', 'invalid_format', 'must be a 26-character ULID');
  }
  if (!Array.isArray(actualChanged)) {
    issue(issues, '$.actual_changed', 'invalid_type', 'must be an array');
    return validationResult(issues);
  }

  const reported = new Set(Array.isArray(packet?.changed) ? packet.changed : []);
  const actual = new Set(actualChanged);
  actualChanged.forEach((path, index) => {
    issues.push(...validateWorkflowPath(path, `$.actual_changed[${index}]`).issues);
    if (!reported.has(path)) {
      issue(issues, `$.actual_changed[${index}]`, 'unreported_change', 'changed file is absent from packet.changed');
    }
  });
  for (const path of reported) {
    if (!actual.has(path)) {
      issue(issues, '$.changed', 'unobserved_change', `packet reports an unchanged file: ${path}`);
    }
  }
  return validationResult(issues);
}

export function validateReadOnlyPacket(packet) {
  const issues = [];
  if (packet?.snapshot?.before !== packet?.snapshot?.after) {
    issue(issues, '$.snapshot', 'snapshot_changed', 'read-only packet snapshots must match');
  }
  if (!Array.isArray(packet?.changed) || packet.changed.length !== 0) {
    issue(issues, '$.changed', 'unexpected_change', 'read-only packets cannot report changed files');
  }
  return validationResult(issues);
}
