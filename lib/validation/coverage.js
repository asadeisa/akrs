import { COMMAND_ID_PATTERN } from '../schemas/common.js';
import {
  issue,
  validateClosedObject,
  validationResult,
} from '../schemas/validation.js';

export const VALIDATION_CHECK_STATUSES = Object.freeze([
  'passed',
  'failed',
  'skipped',
  'not_applicable',
]);
export const VALIDATION_RESULT_KEYS = Object.freeze([
  'check', 'status', 'examined_count', 'finding_count', 'reason',
]);
export const VALIDATION_COVERAGE_KEYS = Object.freeze([
  'total_checks', 'passed', 'failed', 'skipped', 'not_applicable',
  'examined_count', 'finding_count',
]);
export const VALIDATION_DATA_KEYS = Object.freeze([
  'kind', 'legacy_characterization', 'coverage', 'checks',
]);

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validateValidationResult(value, { path = '$' } = {}) {
  const issues = [];
  if (!validateClosedObject(value, VALIDATION_RESULT_KEYS, path, issues)) {
    return validationResult(issues);
  }
  if (typeof value.check !== 'string' || !COMMAND_ID_PATTERN.test(value.check)) {
    issue(issues, `${path}.check`, 'invalid_format', 'must be a stable check ID');
  }
  if (!VALIDATION_CHECK_STATUSES.includes(value.status)) {
    issue(issues, `${path}.status`, 'invalid_value', 'must use a validation check status');
  }
  for (const key of ['examined_count', 'finding_count']) {
    if (!isCount(value[key])) issue(issues, `${path}.${key}`, 'invalid_value', 'must be a non-negative integer');
  }
  const reasonValid = value.reason === null
    || (typeof value.reason === 'string' && value.reason.length > 0 && !/[\r\n]/.test(value.reason));
  if (!reasonValid) issue(issues, `${path}.reason`, 'invalid_value', 'must be null or non-empty single-line text');

  if (value.status === 'passed') {
    if (value.examined_count < 1) issue(issues, `${path}.examined_count`, 'invalid_coverage', 'passed requires examined input');
    if (value.finding_count !== 0) issue(issues, `${path}.finding_count`, 'invalid_coverage', 'passed cannot contain findings');
    if (value.reason !== null) issue(issues, `${path}.reason`, 'invalid_coverage', 'passed has no reason');
  } else if (value.status === 'failed') {
    if (value.examined_count < 1) issue(issues, `${path}.examined_count`, 'invalid_coverage', 'failed requires examined input');
    if (value.finding_count < 1) issue(issues, `${path}.finding_count`, 'invalid_coverage', 'failed requires findings');
    if (value.reason !== null) issue(issues, `${path}.reason`, 'invalid_coverage', 'failed has no reason');
  } else if (value.status === 'skipped') {
    if (value.reason === null) issue(issues, `${path}.reason`, 'invalid_coverage', 'skipped requires a reason');
  } else if (value.status === 'not_applicable') {
    if (value.examined_count !== 0 || value.finding_count !== 0) {
      issue(issues, path, 'invalid_coverage', 'not_applicable cannot examine inputs or contain findings');
    }
    if (value.reason === null) issue(issues, `${path}.reason`, 'invalid_coverage', 'not_applicable requires a reason');
  }
  return validationResult(issues);
}

export function validateCoverage(value, { path = '$' } = {}) {
  const issues = [];
  if (!validateClosedObject(value, VALIDATION_COVERAGE_KEYS, path, issues)) {
    return validationResult(issues);
  }
  for (const key of VALIDATION_COVERAGE_KEYS) {
    if (!isCount(value[key])) issue(issues, `${path}.${key}`, 'invalid_value', 'must be a non-negative integer');
  }
  if (isCount(value.total_checks)
    && value.passed + value.failed + value.skipped + value.not_applicable !== value.total_checks) {
    issue(issues, `${path}.total_checks`, 'invalid_coverage', 'status counts must equal total checks');
  }
  return validationResult(issues);
}

export function validateValidationData(value) {
  const issues = [];
  if (!validateClosedObject(value, VALIDATION_DATA_KEYS, '$', issues)) return validationResult(issues);
  if (value.kind !== 'validation') issue(issues, '$.kind', 'invalid_value', 'must be validation');
  if (value.legacy_characterization !== false) {
    issue(issues, '$.legacy_characterization', 'invalid_value', 'must be false: validation reads canonical v2 artifacts only');
  }
  issues.push(...validateCoverage(value.coverage, { path: '$.coverage' }).issues);
  if (!Array.isArray(value.checks) || value.checks.length === 0) {
    issue(issues, '$.checks', 'invalid_type', 'must be a non-empty array');
  } else {
    value.checks.forEach((entry, index) => {
      issues.push(...validateValidationResult(entry, { path: `$.checks[${index}]` }).issues);
    });
  }
  return validationResult(issues);
}

export async function runCoveredCheck({
  id,
  applicable,
  required,
  emptyReason = 'required input was not readable',
  notApplicableReason = 'check is not applicable',
  run,
}) {
  if (!applicable) {
    return {
      result: {
        check: id,
        status: 'not_applicable',
        examined_count: 0,
        finding_count: 0,
        reason: notApplicableReason,
      },
      findings: [],
    };
  }

  let examinedCount = 0;
  let incompleteReason = null;
  try {
    const findings = await run({
      examined(count = 1) {
        if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('examined count must be a non-negative integer');
        examinedCount += count;
      },
      incomplete(reason) {
        if (typeof reason !== 'string' || reason.length === 0) throw new TypeError('incomplete reason must be non-empty');
        incompleteReason ??= reason;
      },
    });
    if (!Array.isArray(findings)) throw new TypeError('validation check must return a findings array');

    if (incompleteReason !== null || (required && examinedCount === 0)) {
      return {
        result: {
          check: id,
          status: 'skipped',
          examined_count: examinedCount,
          finding_count: findings.length,
          reason: incompleteReason ?? emptyReason,
        },
        findings,
      };
    }
    return {
      result: {
        check: id,
        status: findings.length > 0 ? 'failed' : 'passed',
        examined_count: examinedCount,
        finding_count: findings.length,
        reason: null,
      },
      findings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown check failure';
    const finding = {
      code: 'AKRS-C005',
      severity: 'warning',
      message: `Validation check ${id} could not complete.`,
      file: null,
      line: null,
      detail: { check: id, error: message },
    };
    return {
      result: {
        check: id,
        status: 'skipped',
        examined_count: examinedCount,
        finding_count: 1,
        reason: `check failed: ${message}`,
      },
      findings: [finding],
    };
  }
}

export function aggregateCoverage(checks) {
  const coverage = {
    total_checks: checks.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    not_applicable: 0,
    examined_count: 0,
    finding_count: 0,
  };
  for (const check of checks) {
    const validation = validateValidationResult(check);
    if (!validation.ok) throw new TypeError(`invalid validation result: ${JSON.stringify(validation.issues)}`);
    coverage[check.status] += 1;
    coverage.examined_count += check.examined_count;
    coverage.finding_count += check.finding_count;
  }
  return coverage;
}
