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

export function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isSortedUnique(values, compare = compareStrings) {
  return values.every((value, index) => index === 0 || compare(values[index - 1], value) < 0);
}
