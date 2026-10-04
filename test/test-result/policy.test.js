// P2-W07: `test result` is a journaled, transactional Tester mutation with a lease-implied snapshot, an A1 MCP mapping and
// one new finding code; its frozen decisions are pinned here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { findingCatalog as FINDING_CATALOG } from '../../lib/findings/catalog.js';
import { COMMAND_SNAPSHOT_TABLE } from '../../lib/store/snapshots/projections.js';
import { RESULT_FINDING_CODE, RESULT_GUARD_REASONS, RESULT_POLICY } from '../../lib/store/test-result/policy.js';
import { TEST_RESULT_NEXT_COMMAND_BUILDERS } from '../../lib/store/test-result/next-commands.js';
import { TRANSACTIONAL_COMMANDS } from '../../lib/store/transactions/policy.js';

const entry = commandManifest.commands.find(({ id }) => id === 'test-result');

test('test result is a Tester journal mutation whose expected snapshot is implied by the Tester lease', () => {
  assert.ok(entry, 'registered in the manifest');
  assert.deepEqual([entry.tokens, entry.mutability, entry.idempotency, entry.expected_snapshot, entry.dry_run, entry.required_role], [['test', 'result'], 'mutation', 'journal', 'lease', true, 'tester']);
  assert.deepEqual([entry.mcp_tool, entry.mcp_action, entry.streaming, entry.next_command_builder], ['akrs_test', 'result', 'none', 'test-result']);
  assert.deepEqual(entry.positionals, [{ name: 'plan', required: true, variadic: false }]);
  assert.deepEqual(entry.snapshot_inputs, COMMAND_SNAPSHOT_TABLE['test-result'].inputs);
  const flags = Object.fromEntries(entry.flags.map(({ name, value_type: type }) => [name, type]));
  for (const name of ['--verdict', '--because', '--input', '--again', '--dry-run', '--request-id', '--if-snapshot']) assert.ok(name in flags, name);
  assert.ok(TRANSACTIONAL_COMMANDS.includes('test-result'));
});

test('the Tester never gets a flag that types a hash, a snapshot of its own or a Road', () => {
  const names = entry.flags.map(({ name }) => name);
  for (const forbidden of ['--snapshot', '--tested-snapshot', '--contract-hash', '--hash', '--run']) assert.equal(names.includes(forbidden), false, forbidden);
});

test('AKRS-T006 is the single refusal code and every reason is listed once, sorted', () => {
  assert.equal(RESULT_FINDING_CODE, 'AKRS-T006');
  const catalogued = FINDING_CATALOG.find(({ code }) => code === RESULT_FINDING_CODE);
  assert.equal(catalogued.category, 'tester');
  assert.deepEqual(catalogued.data_schema.properties.reason.enum, [...RESULT_GUARD_REASONS]);
  assert.deepEqual([...RESULT_GUARD_REASONS], [...RESULT_GUARD_REASONS].sort());
  assert.equal(new Set(RESULT_GUARD_REASONS).size, RESULT_GUARD_REASONS.length);
  for (const reason of [
    'acceptance_contradicts', 'check_failed', 'check_undeclared', 'contract_missing', 'contract_unverified', 'evidence_missing',
    'evidence_type_missing', 'evidence_undeclared', 'finding_open', 'lease_missing', 'lease_stale', 'ledger_unusable', 'measurement_inconsistent',
    'measurement_missing', 'measurement_over_budget', 'measurement_undeclared', 'packet_blocked', 'policy_none', 'run_blocked', 'run_failed',
    'run_missing', 'run_required', 'run_stale', 'unknown_plan',
  ]) assert.ok(RESULT_GUARD_REASONS.includes(reason), reason);
});

test('the frozen decisions are written down and deep-frozen', () => {
  assert.equal(Object.isFrozen(RESULT_POLICY), true);
  for (const key of ['identity', 'flat', 'pass', 'run', 'evidence', 'measurements', 'checks', 'append', 'state', 'lease']) {
    assert.equal(typeof RESULT_POLICY[key], 'string', key);
    assert.ok(RESULT_POLICY[key].length > 20, key);
  }
});

test('the next-command builder offers only commands that run as they are', () => {
  const build = TEST_RESULT_NEXT_COMMAND_BUILDERS['test-result'];
  assert.deepEqual(build({ phase: 'recorded', plan: 'P6', rootArgs: ['--root', '/r'] }), [{ command: 'test-details', args: ['P6', '--root', '/r'] }]);
  assert.deepEqual(build({ phase: 'needs_run', plan: 'P6', rootArgs: [] }), [{ command: 'test-run', args: ['P6'] }]);
  assert.deepEqual(build({ phase: 'rejected', plan: 'P6', rootArgs: [] }), [{ command: 'test-details', args: ['P6'] }]);
  assert.deepEqual(build({ phase: 'template', plan: 'P6', rootArgs: [] }), [{ command: 'template', args: ['result'] }, { command: 'test-details', args: ['P6'] }]);
  assert.throws(() => build({ phase: 'nonsense' }), /unknown next-command phase/);
  for (const forbidden of ['plan-finish']) assert.equal(JSON.stringify(build({ phase: 'recorded', plan: 'P6' })).includes(forbidden), false);
});
