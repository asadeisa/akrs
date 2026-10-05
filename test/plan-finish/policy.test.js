// P2-W08: `plan finish` is a Leader journal mutation with a required snapshot and an A1 MCP mapping; its gate has one finding
// code and a closed list of reasons, and its decisions are frozen.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { findingCatalog } from '../../lib/findings/catalog.js';
import { COMMAND_SNAPSHOT_TABLE } from '../../lib/store/snapshots/projections.js';
import { PLAN_FINISH_NEXT_COMMAND_BUILDERS } from '../../lib/store/plan-finish/next-commands.js';
import { PLAN_FINISH_FINDING_CODE, PLAN_FINISH_POLICY, PLAN_FINISH_REASONS } from '../../lib/store/plan-finish/policy.js';
import { TRANSACTIONAL_COMMANDS } from '../../lib/store/transactions/policy.js';

const entry = commandManifest.commands.find(({ id }) => id === 'plan-finish');

test('plan finish is a Leader journal mutation that needs --if-snapshot and maps to akrs_write plan_finish', () => {
  assert.ok(entry, 'registered in the manifest');
  assert.deepEqual([entry.tokens, entry.mutability, entry.idempotency, entry.expected_snapshot, entry.dry_run, entry.required_role], [['plan', 'finish'], 'mutation', 'journal', 'required', true, 'leader']);
  assert.deepEqual([entry.mcp_tool, entry.mcp_action, entry.streaming, entry.next_command_builder], ['akrs_write', 'plan_finish', 'none', 'plan-finish']);
  assert.deepEqual(entry.positionals, [{ name: 'plan', required: true, variadic: false }]);
  assert.deepEqual(entry.snapshot_inputs, COMMAND_SNAPSHOT_TABLE['plan-finish'].inputs);
  const names = entry.flags.map(({ name }) => name);
  for (const name of ['--if-snapshot', '--dry-run', '--request-id']) assert.ok(names.includes(name), name);
  assert.ok(TRANSACTIONAL_COMMANDS.includes('plan-finish'));
});

test('AKRS-T007 is the single gate code and the reasons are listed once, sorted', () => {
  assert.equal(PLAN_FINISH_FINDING_CODE, 'AKRS-T007');
  const catalogued = findingCatalog.find(({ code }) => code === PLAN_FINISH_FINDING_CODE);
  assert.equal(catalogued.category, 'tester');
  assert.deepEqual(catalogued.data_schema.properties.reason.enum, [...PLAN_FINISH_REASONS]);
  assert.deepEqual([...PLAN_FINISH_REASONS], [...PLAN_FINISH_REASONS].sort());
  assert.equal(new Set(PLAN_FINISH_REASONS).size, PLAN_FINISH_REASONS.length);
  for (const reason of [
    'already_closed', 'evidence_changed', 'evidence_missing', 'evidence_type_missing', 'finding_open', 'ledger_unusable', 'measurement_missing', 'measurement_over_budget',
    'no_roads', 'not_a_plan', 'plan_file_missing', 'plan_unverified', 'question_open', 'road_not_done', 'road_unverified', 'run_failed', 'run_missing', 'seam_owner_missing',
    'seam_owner_not_done', 'seam_unowned', 'tester_failed', 'tester_missing', 'tester_stale', 'tester_unverified', 'unknown_plan',
  ]) assert.ok(PLAN_FINISH_REASONS.includes(reason), reason);
});

test('the frozen decisions are written down and deep-frozen', () => {
  assert.equal(Object.isFrozen(PLAN_FINISH_POLICY), true);
  for (const key of ['gate', 'required_roads', 'tester', 'evidence', 'findings', 'seams_questions', 'closure', 'snapshot', 'stale']) {
    assert.equal(typeof PLAN_FINISH_POLICY[key], 'string', key);
    assert.ok(PLAN_FINISH_POLICY[key].length > 20, key);
  }
});

test('the next-command builder offers only commands that run as they are', () => {
  const build = PLAN_FINISH_NEXT_COMMAND_BUILDERS['plan-finish'];
  const snapshot = `sha256:${'a'.repeat(64)}`;
  assert.deepEqual(build({ phase: 'ready', plan: 'P6', snapshot, rootArgs: ['--root', '/r'] }), [{ command: 'plan-finish', args: ['P6', '--if-snapshot', snapshot, '--root', '/r'] }]);
  assert.deepEqual(build({ phase: 'done', rootArgs: [] }), [{ command: 'state-render', args: [] }]);
  assert.deepEqual(build({ phase: 'blocked', plan: 'P6', rootArgs: [] }), [{ command: 'test-details', args: ['P6'] }]);
  assert.deepEqual(build({ phase: 'rejected', plan: 'P6', rootArgs: [] }), [{ command: 'plan-finish', args: ['P6', '--dry-run'] }]);
  assert.throws(() => build({ phase: 'nonsense' }), /unknown next-command phase/);
});
