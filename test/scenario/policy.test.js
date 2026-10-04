// P2-W14: the frozen run decisions (F18, run part) and the catalog entries behind them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getFindingDefinition } from '../../lib/findings/catalog.js';
import { RUN_BLOCK_REASONS, RUN_FINDING_CODES, RUN_POLICY, RUN_REFUSAL_REASONS, RUN_STEP_FINDING_REASONS } from '../../lib/scenario/policy.js';
import { SCENARIO_STEPS } from '../../lib/schemas/verification.js';

test('the policy names the order, the lease rule, the evidence layout and the verdict boundary', () => {
  assert.equal(RUN_POLICY.order[0], 'validate the contract scenario (before any process starts)');
  assert.equal(RUN_POLICY.order.at(-1), 'write the evidence and the run record under the repository lock');
  assert.match(RUN_POLICY.evidence.directory, /verifications\/<plan>\/evidence\/<run-id>\//);
  assert.match(RUN_POLICY.evidence.record, /run\.json/);
  assert.match(RUN_POLICY.evidence.write, /F9/);
  assert.match(RUN_POLICY.verdict, /never|mechanical/);
  assert.match(RUN_POLICY.steps.vocabulary, new RegExp(SCENARIO_STEPS.join('.*')));
});

test('the two new finding codes are in the tester family with closed reasons', () => {
  assert.deepEqual(RUN_FINDING_CODES, { refused: 'AKRS-T004', step: 'AKRS-T005' });
  const refused = getFindingDefinition('AKRS-T004');
  const step = getFindingDefinition('AKRS-T005');
  assert.deepEqual([refused.category, refused.severity, step.category], ['tester', 'error', 'tester']);
  assert.deepEqual(refused.data_schema.properties.reason.enum, [...RUN_REFUSAL_REASONS]);
  assert.deepEqual(step.data_schema.properties.reason.enum, [...RUN_STEP_FINDING_REASONS]);
  assert.deepEqual([...RUN_BLOCK_REASONS], ['launch_failed', 'no_browser', 'ready_timeout', 'setup_failed']);
});
