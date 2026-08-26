import {
  FINDING_SEVERITIES,
  compareStrings,
  validateWorkflowPath,
} from './common.js';
import {
  isPlainObject,
  issue,
  validateClosedObject,
  validateJsonValue,
  validationResult,
} from './validation.js';

export const FINDING_KEYS = Object.freeze([
  'code',
  'severity',
  'message',
  'file',
  'line',
  'detail',
]);

export function validateFinding(value, { path = '$' } = {}) {
  const issues = [];
  if (!validateClosedObject(value, FINDING_KEYS, path, issues)) return validationResult(issues);

  if (typeof value.code !== 'string' || !/^AKRS-[A-Z][0-9]{3}$/.test(value.code)) {
    issue(issues, `${path}.code`, 'invalid_format', 'must match AKRS-X000');
  }
  if (!FINDING_SEVERITIES.includes(value.severity)) {
    issue(issues, `${path}.severity`, 'invalid_value', 'must be info, warning, or error');
  }
  if (typeof value.message !== 'string' || value.message.length === 0) {
    issue(issues, `${path}.message`, 'invalid_type', 'must be a non-empty string');
  }
  if (value.file !== null) {
    issues.push(...validateWorkflowPath(value.file, `${path}.file`).issues);
  }
  if (value.line !== null && (!Number.isSafeInteger(value.line) || value.line < 1)) {
    issue(issues, `${path}.line`, 'invalid_value', 'must be null or a positive integer');
  }
  if (!isPlainObject(value.detail)) {
    issue(issues, `${path}.detail`, 'invalid_type', 'must be an object');
  } else {
    validateJsonValue(value.detail, `${path}.detail`, issues);
  }
  return validationResult(issues);
}

export function compareFindings(left, right) {
  return compareStrings(left.code, right.code)
    || compareStrings(left.file ?? '', right.file ?? '')
    || (left.line ?? 0) - (right.line ?? 0)
    || compareStrings(left.message, right.message);
}
