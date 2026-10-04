import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest, nextCommandBuilders } from '../../lib/commands/manifest.js';
import { getFindingDefinition } from '../../lib/findings/catalog.js';
import { TESTER_GUARD_REASONS, contractPath, handoffPath } from '../../lib/store/verification/index.js';
import { TRANSACTIONAL_COMMANDS } from '../../lib/store/transactions/index.js';

test('T002 is a permanent tester-family code whose reasons are the frozen vocabulary', () => {
  const definition = getFindingDefinition('AKRS-T002');
  assert.equal(definition.category, 'tester');
  assert.deepEqual(definition.data_schema.properties.reason.enum, [...TESTER_GUARD_REASONS]);
  assert.deepEqual([...TESTER_GUARD_REASONS], [...TESTER_GUARD_REASONS].sort());
  assert.equal(definition.data_schema.additionalProperties, false);
});

test('canonical locations: <workflow>/verifications/<key>/contract.json and handoff.jsonl', () => {
  assert.equal(contractPath('P6'), 'verifications/P6/contract.json');
  assert.equal(handoffPath('R-ONLY-1'), 'verifications/R-ONLY-1/handoff.jsonl');
  assert.throws(() => contractPath('../x'));
});

test('test-define and test-handoff are live, journaled, transactional mutations with builders and A1 MCP mapping', () => {
  const byId = Object.fromEntries(commandManifest.commands.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId['test-define'].tokens, ['test', 'define']);
  assert.deepEqual(byId['test-handoff'].tokens, ['test', 'handoff']);
  assert.equal(byId['test-define'].required_role, 'leader');
  assert.equal(byId['test-handoff'].required_role, 'worker');
  assert.deepEqual([byId['test-define'].mcp_tool, byId['test-define'].mcp_action], ['akrs_write', 'verification_define']);
  assert.deepEqual([byId['test-handoff'].mcp_tool, byId['test-handoff'].mcp_action], ['akrs_test', 'handoff']);
  assert.equal(byId['test-handoff'].flags.find(({ name }) => name === '--reach').repeatable, true);
  for (const id of ['test-define', 'test-handoff']) {
    assert.equal(byId[id].mutability, 'mutation', id);
    assert.equal(byId[id].idempotency, 'journal', id);
    assert.equal(TRANSACTIONAL_COMMANDS.includes(id), true, id);
    assert.equal(typeof nextCommandBuilders[id], 'function', id);
  }
  const flat = nextCommandBuilders['test-handoff']({
    phase: 'duplicate', plan: 'P6', file: null, rootArgs: [],
    document: { road: 'R-1', result: 'Ready.', reach: ['a', 'b'], expect: 'ok' },
  });
  assert.deepEqual(flat[0].args, ['P6', '--road', 'R-1', '--result', 'Ready.', '--reach', 'a', '--reach', 'b', '--expect', 'ok', '--again']);
});
