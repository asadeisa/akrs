import {
  COMMAND_ID_PATTERN,
  EXIT_CODES,
  PACKET_STATUSES,
  SCHEMA_ID_PATTERN,
  compareStrings,
  isSortedUnique,
} from './common.js';
import { issue, validateClosedObject, validationResult } from './validation.js';

export const COMMAND_MANIFEST_KEYS = Object.freeze(['schema_version', 'commands']);
export const COMMAND_ENTRY_KEYS = Object.freeze([
  'id',
  'tokens',
  'summary',
  'input_schema',
  'positionals',
  'flags',
  'required_role',
  'mutability',
  'dry_run',
  'idempotency',
  'expected_snapshot',
  'snapshot_inputs',
  'streaming',
  'output_schema',
  'statuses',
  'exit_codes',
  'next_command_builder',
]);

const POSITIONAL_KEYS = Object.freeze(['name', 'required', 'variadic']);
const FLAG_KEYS = Object.freeze(['name', 'value_type', 'required', 'repeatable']);
export const COMMAND_ROLES = Object.freeze(['any', 'leader', 'worker', 'tester']);
export const COMMAND_MUTABILITY = Object.freeze(['query', 'mutation', 'derived_write']);
export const COMMAND_VALUE_TYPES = Object.freeze(['boolean', 'string', 'path', 'integer', 'json']);
export const COMMAND_STREAMING = Object.freeze(['none', 'jsonl']);
export const COMMAND_REQUIREMENT = Object.freeze(['not_applicable', 'required']);
const TOKEN_PATTERN = /^(?:--)?[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function validatePositionals(positionals, path, issues) {
  if (!Array.isArray(positionals)) {
    issue(issues, path, 'invalid_type', 'must be an array');
    return;
  }
  const names = new Set();
  let optionalSeen = false;
  positionals.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!validateClosedObject(entry, POSITIONAL_KEYS, entryPath, issues)) return;
    if (typeof entry.name !== 'string' || !COMMAND_ID_PATTERN.test(entry.name)) {
      issue(issues, `${entryPath}.name`, 'invalid_format', 'must be a stable argument name');
    } else if (names.has(entry.name)) {
      issue(issues, `${entryPath}.name`, 'duplicate_value', 'argument name must be unique');
    }
    names.add(entry.name);
    if (typeof entry.required !== 'boolean') {
      issue(issues, `${entryPath}.required`, 'invalid_type', 'must be boolean');
    }
    if (typeof entry.variadic !== 'boolean') {
      issue(issues, `${entryPath}.variadic`, 'invalid_type', 'must be boolean');
    }
    if (optionalSeen && entry.required === true) {
      issue(issues, `${entryPath}.required`, 'invalid_order', 'required arguments cannot follow optional arguments');
    }
    if (entry.required === false) optionalSeen = true;
    if (entry.variadic === true && index !== positionals.length - 1) {
      issue(issues, `${entryPath}.variadic`, 'invalid_order', 'variadic argument must be last');
    }
  });
}

function validateFlags(flags, path, issues) {
  if (!Array.isArray(flags)) {
    issue(issues, path, 'invalid_type', 'must be an array');
    return;
  }
  const names = new Set();
  flags.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!validateClosedObject(entry, FLAG_KEYS, entryPath, issues)) return;
    if (typeof entry.name !== 'string' || !/^--[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(entry.name)) {
      issue(issues, `${entryPath}.name`, 'invalid_format', 'must be a long flag name');
    } else if (names.has(entry.name)) {
      issue(issues, `${entryPath}.name`, 'duplicate_value', 'flag name must be unique');
    }
    names.add(entry.name);
    if (!COMMAND_VALUE_TYPES.includes(entry.value_type)) {
      issue(issues, `${entryPath}.value_type`, 'invalid_value', `must be one of: ${COMMAND_VALUE_TYPES.join(', ')}`);
    }
    if (typeof entry.required !== 'boolean') {
      issue(issues, `${entryPath}.required`, 'invalid_type', 'must be boolean');
    }
    if (typeof entry.repeatable !== 'boolean') {
      issue(issues, `${entryPath}.repeatable`, 'invalid_type', 'must be boolean');
    }
  });
}

function validateOrderedVocabulary(values, vocabulary, path, issues) {
  if (!Array.isArray(values) || values.length === 0) {
    issue(issues, path, 'invalid_type', 'must be a non-empty array');
    return;
  }
  for (const [index, value] of values.entries()) {
    if (!vocabulary.includes(value)) {
      issue(issues, `${path}[${index}]`, 'invalid_value', 'contains an unsupported value');
    }
  }
  const compare = (left, right) => vocabulary.indexOf(left) - vocabulary.indexOf(right);
  if (!isSortedUnique(values, compare)) {
    issue(issues, path, 'invalid_order', 'must use canonical order without duplicates');
  }
}

function validateEntry(entry, path, issues) {
  if (!validateClosedObject(entry, COMMAND_ENTRY_KEYS, path, issues)) return;
  if (typeof entry.id !== 'string' || !COMMAND_ID_PATTERN.test(entry.id)) {
    issue(issues, `${path}.id`, 'invalid_format', 'must be a stable command ID');
  }
  if (!Array.isArray(entry.tokens) || entry.tokens.length === 0) {
    issue(issues, `${path}.tokens`, 'invalid_type', 'must be a non-empty array');
  } else {
    entry.tokens.forEach((token, index) => {
      if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
        issue(issues, `${path}.tokens[${index}]`, 'invalid_format', 'must be a lowercase command token');
      }
    });
  }
  if (typeof entry.summary !== 'string' || entry.summary.length === 0 || /[\r\n]/.test(entry.summary)) {
    issue(issues, `${path}.summary`, 'invalid_value', 'must be non-empty single-line text');
  }
  for (const key of ['input_schema', 'output_schema']) {
    if (typeof entry[key] !== 'string' || !SCHEMA_ID_PATTERN.test(entry[key])) {
      issue(issues, `${path}.${key}`, 'invalid_format', 'must be a versioned AKRS schema ID');
    }
  }
  validatePositionals(entry.positionals, `${path}.positionals`, issues);
  validateFlags(entry.flags, `${path}.flags`, issues);
  if (!COMMAND_ROLES.includes(entry.required_role)) {
    issue(issues, `${path}.required_role`, 'invalid_value', `must be one of: ${COMMAND_ROLES.join(', ')}`);
  }
  if (!COMMAND_MUTABILITY.includes(entry.mutability)) {
    issue(issues, `${path}.mutability`, 'invalid_value', `must be one of: ${COMMAND_MUTABILITY.join(', ')}`);
  }
  if (typeof entry.dry_run !== 'boolean') {
    issue(issues, `${path}.dry_run`, 'invalid_type', 'must be boolean');
  }
  if (!COMMAND_REQUIREMENT.includes(entry.idempotency)) {
    issue(issues, `${path}.idempotency`, 'invalid_value', 'must be not_applicable or required');
  }
  if (!COMMAND_REQUIREMENT.includes(entry.expected_snapshot)) {
    issue(issues, `${path}.expected_snapshot`, 'invalid_value', 'must be not_applicable or required');
  }
  if (!Array.isArray(entry.snapshot_inputs)) {
    issue(issues, `${path}.snapshot_inputs`, 'invalid_type', 'must be an array');
  } else {
    entry.snapshot_inputs.forEach((value, index) => {
      if (typeof value !== 'string' || !COMMAND_ID_PATTERN.test(value)) {
        issue(issues, `${path}.snapshot_inputs[${index}]`, 'invalid_format', 'must be a stable projection ID');
      }
    });
    if (!isSortedUnique(entry.snapshot_inputs, compareStrings)) {
      issue(issues, `${path}.snapshot_inputs`, 'invalid_order', 'must be sorted and unique');
    }
  }
  if (!COMMAND_STREAMING.includes(entry.streaming)) {
    issue(issues, `${path}.streaming`, 'invalid_value', 'must be none or jsonl');
  }
  validateOrderedVocabulary(entry.statuses, PACKET_STATUSES, `${path}.statuses`, issues);
  validateOrderedVocabulary(entry.exit_codes, EXIT_CODES, `${path}.exit_codes`, issues);
  if (typeof entry.next_command_builder !== 'string'
    || !COMMAND_ID_PATTERN.test(entry.next_command_builder)) {
    issue(issues, `${path}.next_command_builder`, 'invalid_format', 'must be a stable builder ID');
  }

  const writes = entry.mutability === 'mutation' || entry.mutability === 'derived_write';
  if (writes && (entry.dry_run !== true || entry.idempotency !== 'required')) {
    issue(issues, path, 'invalid_capability', 'writers require dry-run and idempotency');
  }
  if (!writes && (entry.dry_run !== false
    || entry.idempotency !== 'not_applicable'
    || entry.expected_snapshot !== 'not_applicable')) {
    issue(issues, path, 'invalid_capability', 'queries cannot declare mutation capabilities');
  }
}

export function validateCommandManifest(value) {
  const issues = [];
  if (!validateClosedObject(value, COMMAND_MANIFEST_KEYS, '$', issues)) return validationResult(issues);
  if (value.schema_version !== 'akrs.command-manifest/v1') {
    issue(issues, '$.schema_version', 'invalid_value', 'must be akrs.command-manifest/v1');
  }
  if (!Array.isArray(value.commands)) {
    issue(issues, '$.commands', 'invalid_type', 'must be an array');
  } else {
    const ids = new Set();
    const tokenSets = new Set();
    value.commands.forEach((entry, index) => {
      validateEntry(entry, `$.commands[${index}]`, issues);
      if (ids.has(entry?.id)) issue(issues, `$.commands[${index}].id`, 'duplicate_value', 'command ID must be unique');
      ids.add(entry?.id);
      const tokenKey = Array.isArray(entry?.tokens) ? entry.tokens.join('\0') : '';
      if (tokenSets.has(tokenKey)) issue(issues, `$.commands[${index}].tokens`, 'duplicate_value', 'command tokens must be unique');
      tokenSets.add(tokenKey);
    });
  }
  return validationResult(issues);
}
