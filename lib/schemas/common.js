import { issue, validationResult } from './validation.js';

export const PACKET_STATUSES = Object.freeze(['ok', 'warning', 'error', 'blocked', 'noop']);
export const EVENT_TYPES = Object.freeze(['started', 'progress', 'evidence', 'finding', 'complete']);
export const FINDING_SEVERITIES = Object.freeze(['info', 'warning', 'error']);
export const EXIT_CODES = Object.freeze([0, 1, 2, 3, 4]);

export const RUN_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const COMMAND_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const SCHEMA_ID_PATTERN = /^akrs\.[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)+\/v[1-9][0-9]*$/;
export const SNAPSHOT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

export function isPortableAbsolutePath(value) {
  if (typeof value !== 'string' || value.includes('\\') || value.includes('\0')) return false;
  if (value === '/') return true;
  if (/^[A-Za-z]:\/$/.test(value)) return true;
  if (/^[A-Za-z]:\/[^/]+(?:\/[^/]+)*$/.test(value)) return true;
  if (/^\/[^/]+(?:\/[^/]+)*$/.test(value)) return true;
  return /^\/\/[^/]+\/[^/]+(?:\/[^/]+)*$/.test(value);
}

export function validateWorkflowPath(value, path = '$') {
  const issues = [];
  if (typeof value !== 'string' || value.length === 0) {
    issue(issues, path, 'invalid_type', 'must be a non-empty string');
    return validationResult(issues);
  }

  const segments = value.split('/');
  const invalid = value.includes('\\')
    || value.includes('\0')
    || value.startsWith('/')
    || /^[A-Za-z]:\//.test(value)
    || value.startsWith('//')
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..');
  if (invalid) {
    issue(issues, path, 'invalid_path', 'must be a normalized repository-relative / path');
  }
  return validationResult(issues);
}

// Note: compareStrings/isSortedUnique order by UTF-16 code units. Stored sets (Q6) are ordered by code point:
// artifact readers and writers must use compareCodePoints from lib/store/canonical/json.js instead.
export function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isSortedUnique(values, compare = compareStrings) {
  return values.every((value, index) => index === 0 || compare(values[index - 1], value) < 0);
}

// P1-W01 additions (Q2, Q8): artifact schema IDs and explicit IDs.
export const ARTIFACT_SCHEMA_ID_PATTERN = /^akrs\.[a-z][a-z0-9-]*\/v[1-9][0-9]*$/;
export const ID_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*$/;
export const ID_MAX_LENGTH = 64;

export function isArtifactSchemaId(value) {
  return typeof value === 'string' && ARTIFACT_SCHEMA_ID_PATTERN.test(value);
}

// IDs are file names (roads, plans, tasks, scope logs, evidence dirs); Windows treats these stems as devices.
const DEVICE_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function isId(value) {
  return typeof value === 'string' && value.length <= ID_MAX_LENGTH && ID_PATTERN.test(value)
    && !DEVICE_STEM.test(value.split('.')[0]);
}

// A ULID is a 128-bit value in 26 Crockford base32 characters, so the first character is at most 7.
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isUlid(value) {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}
