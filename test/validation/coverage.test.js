import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  VALIDATION_CHECK_STATUSES,
  aggregateCoverage,
  runCoveredCheck,
  validateCoverage,
  validateValidationResult,
} from '../../lib/validation/coverage.js';

test('required checks with zero readable inputs are skipped, never passed', async () => {
  const outcome = await runCoveredCheck({
    id: 'required-inputs',
    applicable: true,
    required: true,
    emptyReason: 'required input could not be parsed',
    run: async () => [],
  });

  assert.deepEqual(outcome.result, {
    check: 'required-inputs',
    status: 'skipped',
    examined_count: 0,
    finding_count: 0,
    reason: 'required input could not be parsed',
  });
  assert.equal(validateValidationResult(outcome.result).ok, true);
});

test('genuinely irrelevant checks are not applicable and do not execute', async () => {
  let invoked = 0;
  const outcome = await runCoveredCheck({
    id: 'readiness',
    applicable: false,
    required: false,
    notApplicableReason: 'no ACTIVE Road declares dependencies',
    run: async () => { invoked += 1; return []; },
  });

  assert.equal(invoked, 0);
  assert.equal(outcome.result.status, 'not_applicable');
  assert.equal(outcome.result.examined_count, 0);
  assert.equal(outcome.result.finding_count, 0);
});

test('every validation result uses the closed status vocabulary and coherent counts', () => {
  assert.deepEqual(VALIDATION_CHECK_STATUSES, [
    'passed', 'failed', 'skipped', 'not_applicable',
  ]);

  for (const status of VALIDATION_CHECK_STATUSES) {
    const candidate = {
      check: 'probe',
      status,
      examined_count: status === 'passed' || status === 'failed' ? 1 : 0,
      finding_count: status === 'failed' ? 1 : 0,
      reason: status === 'skipped' || status === 'not_applicable' ? 'why' : null,
    };
    assert.equal(validateValidationResult(candidate).ok, true, status);
  }

  const invalid = {
    check: 'probe', status: 'passed', examined_count: 0, finding_count: 0, reason: null,
  };
  assert.equal(validateValidationResult(invalid).ok, false);
  assert.equal(validateValidationResult({ ...invalid, extra: true }).ok, false);
});

test('coverage summary is derived only from validation results', () => {
  const checks = [
    { check: 'a', status: 'passed', examined_count: 2, finding_count: 0, reason: null },
    { check: 'b', status: 'failed', examined_count: 1, finding_count: 2, reason: null },
    { check: 'c', status: 'skipped', examined_count: 0, finding_count: 1, reason: 'unreadable' },
    { check: 'd', status: 'not_applicable', examined_count: 0, finding_count: 0, reason: 'irrelevant' },
  ];
  const coverage = aggregateCoverage(checks);

  assert.deepEqual(coverage, {
    total_checks: 4,
    passed: 1,
    failed: 1,
    skipped: 1,
    not_applicable: 1,
    examined_count: 3,
    finding_count: 3,
  });
  assert.equal(validateCoverage(coverage).ok, true);
});

test('a thrown check is skipped with partial examined count and a stable finding', async () => {
  const outcome = await runCoveredCheck({
    id: 'throwing-check',
    applicable: true,
    required: true,
    run: async ({ examined }) => {
      examined();
      examined(2);
      throw new Error('controlled read failure');
    },
  });

  assert.equal(outcome.result.status, 'skipped');
  assert.equal(outcome.result.examined_count, 3);
  assert.equal(outcome.result.finding_count, 1);
  assert.match(outcome.result.reason, /controlled read failure/);
  assert.equal(outcome.findings[0].code, 'AKRS-C005');
});
