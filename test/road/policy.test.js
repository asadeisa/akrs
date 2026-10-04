// The frozen P1-W06 decisions: manifest entries, how `template --to-draft` is declared, roles, the snapshot table,
// transaction membership, and the new permanent finding codes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { getFindingDefinition } from '../../lib/findings/catalog.js';
import { validateCommandManifest } from '../../lib/schemas/command-manifest.js';
import { COMMAND_SNAPSHOT_TABLE } from '../../lib/store/snapshots/index.js';
import { TRANSACTIONAL_COMMANDS, TRANSACTION_NON_MUTATIONS } from '../../lib/store/transactions/index.js';
import {
  AUTHORING_FINDING_CODES, DRAFT_POLICY, GENERATOR, READ_WINDOW_STATUSES, ROAD_STORE_POLICY, TASK_STORE_POLICY,
  TEMPLATE_DRAFT_POLICY,
} from '../../lib/store/roads/index.js';

const entry = (id) => commandManifest.commands.find((candidate) => candidate.id === id);
const flagNames = (id) => entry(id).flags.map(({ name }) => name);
const OUTPUT = ['--json', '--jsonl', '--prompt'];
const STATUSES = ['ok', 'warning', 'error', 'blocked', 'noop'];

test('the manifest with the new entries is valid and keeps the frozen entry shape', () => {
  assert.equal(validateCommandManifest(commandManifest).ok, true);
  assert.deepEqual(commandManifest.commands.map(({ id }) => id).slice(-30), ['road-new', 'task-new', 'memory-add', 'log-append', 'road-update', 'road-move',
    'scope-request', 'scope-approve', 'scope-reject', 'scope-list', 'test-define', 'test-handoff', 'state-set', 'state-render', 'init-scaffold', 'executor-set', 'executor-remove', 'executor-list', 'road-fit', 'road-details', 'verify', 'road-check', 'road-activate', 'road-finish', 'road-reopen', 'lease-release', 'test-details', 'audit', 'doctor', 'template']);
});

for (const [id, tokens, inputs, mcp] of [
  ['road-new', ['road', 'new'], ['executors', 'plans', 'roads'], ['akrs_write', 'road_new']],
  ['task-new', ['task', 'new'], ['road', 'road-task'], ['akrs_write', 'task_new']],
]) {
  test(`${id}: leader mutation with dry run, journal idempotency, revalidation and the MCP mapping of A1 6.2`, () => {
    const command = entry(id);
    assert.deepEqual(command.tokens, tokens);
    assert.equal(command.required_role, 'leader');
    assert.equal(command.mutability, 'mutation');
    assert.equal(command.dry_run, true);
    assert.equal(command.idempotency, 'journal');
    assert.equal(command.expected_snapshot, 'revalidate');
    assert.deepEqual(command.snapshot_inputs, inputs);
    assert.deepEqual(command.snapshot_inputs, COMMAND_SNAPSHOT_TABLE[id].inputs);
    assert.equal(command.streaming, 'none');
    assert.deepEqual(command.statuses, STATUSES);
    assert.deepEqual(command.exit_codes, [0, 1, 2, 3, 4]);
    assert.deepEqual([command.mcp_tool, command.mcp_action], mcp);
    assert.equal(command.input_schema, `akrs.command-input/${id}/v1`);
    assert.equal(command.output_schema, `akrs.command-output/${id}/v1`);
    assert.deepEqual(command.positionals, []);
    assert.deepEqual(flagNames(id).sort(), [
      '--dry-run', '--if-snapshot', '--input', '--request-id', '--root', '--workflow-root', ...OUTPUT,
    ].sort());
    const types = Object.fromEntries(command.flags.map(({ name, value_type: type }) => [name, type]));
    assert.deepEqual([types['--input'], types['--request-id'], types['--if-snapshot'], types['--dry-run']], ['path', 'string', 'string', 'boolean']);
    assert.equal(command.flags.every(({ required, repeatable }) => required === false && repeatable === false), true);
    assert.notEqual(command.next_command_builder, 'none', 'a builder exists for the runnable next commands');
  });
}

test('template: ONE query entry; --to-draft is a declared flag, not a second command or a mutation (decision)', () => {
  const command = entry('template');
  assert.equal(command.required_role, 'any');
  assert.equal(command.mutability, 'query');
  assert.equal(command.dry_run, false);
  assert.equal(command.idempotency, 'not_applicable');
  assert.equal(command.expected_snapshot, 'not_applicable');
  assert.deepEqual(command.snapshot_inputs, []);
  assert.deepEqual(COMMAND_SNAPSHOT_TABLE.template, { target: 'none', inputs: [], lease_guard: null });
  assert.deepEqual(command.tokens, ['template']);
  assert.deepEqual(command.positionals, [{ name: 'kind', required: true, variadic: false }]);
  assert.deepEqual(flagNames('template').sort(), ['--class', '--root', '--to-draft', '--workflow-root', ...OUTPUT].sort());
  assert.deepEqual([command.mcp_tool, command.mcp_action], ['akrs_road', 'template']);
  assert.deepEqual(command.exit_codes, [0, 1, 2, 3, 4]);
  assert.equal(commandManifest.commands.filter(({ id }) => id.startsWith('template')).length, 1, 'no template-to-draft command id');
  assert.equal(TRANSACTION_NON_MUTATIONS.includes('template'), true, 'drafts are scratch outside the transaction namespace');
  assert.equal(TRANSACTIONAL_COMMANDS.includes('template'), false);
  assert.match(TEMPLATE_DRAFT_POLICY.manifest, /mutability `query`/);
  assert.match(TEMPLATE_DRAFT_POLICY.to_draft, /never an overwrite/);
});

test('both writers are in the transactional list and nowhere else (the only write path is runTransactionalMutation)', () => {
  for (const id of ['road-new', 'task-new']) {
    assert.equal(TRANSACTIONAL_COMMANDS.includes(id), true, id);
    assert.equal(TRANSACTION_NON_MUTATIONS.includes(id), false, id);
  }
});

test('roles: declared as manifest metadata, with the no-enforcement decision written down', () => {
  assert.equal(entry('road-new').required_role, 'leader');
  assert.equal(entry('task-new').required_role, 'leader');
  assert.equal(entry('template').required_role, 'any');
  assert.match(ROAD_STORE_POLICY.roles, /no adapter enforces roles/);
  assert.match(ROAD_STORE_POLICY.roles, /no authentication mechanism is invented/);
});

test('the new permanent finding codes are in the catalog with closed detail shapes', () => {
  assert.deepEqual(AUTHORING_FINDING_CODES, { unresolved_path: 'AKRS-R012', binding: 'AKRS-R013', draft: 'AKRS-C016' });
  const r012 = getFindingDefinition('AKRS-R012');
  assert.equal(r012.category, 'road');
  assert.deepEqual(Object.keys(r012.data_schema.properties).sort(), ['line_count', 'path', 'pointer', 'reason']);
  assert.deepEqual(r012.data_schema.properties.reason.enum, [...READ_WINDOW_STATUSES.filter((status) => !['ok', 'own_write'].includes(status))]);
  assert.equal(r012.data_schema.additionalProperties, false);
  const r013 = getFindingDefinition('AKRS-R013');
  assert.equal(r013.category, 'road');
  assert.deepEqual(Object.keys(r013.data_schema.properties).sort(), ['actual', 'expected', 'pointer', 'reason', 'subject']);
  assert.deepEqual(r013.data_schema.properties.reason.enum, [
    'plan_mismatch', 'plan_names_a_road', 'road_declares_no_task', 'road_missing', 'road_unreadable', 'task_exists', 'task_id_mismatch',
  ]);
  const c016 = getFindingDefinition('AKRS-C016');
  assert.equal(c016.category, 'command');
  assert.deepEqual(c016.data_schema.properties.reason.enum, ['exists', 'unsafe']);
  for (const definition of [r012, r013, c016]) {
    assert.equal(definition.rationale.length > 40, true);
    assert.equal(definition.remediation.length > 20, true);
  }
});

test('frozen store decisions are written down where tests can pin them', () => {
  assert.equal(GENERATOR, 'akrs/2.0.0-alpha.0');
  assert.match(ROAD_STORE_POLICY.placement, /roads\/<plan>\/<id>\.json/);
  assert.match(ROAD_STORE_POLICY.identity, /AKRS-R001/);
  assert.match(ROAD_STORE_POLICY.exit_codes, /exit 2/);
  assert.match(ROAD_STORE_POLICY.task_binding, /equals the Task `id`/);
  assert.deepEqual(TASK_STORE_POLICY.headings, ['Objective', 'Constraints', 'Approach', 'Notes']);
  assert.match(TASK_STORE_POLICY.prose, /never parsed/);
  assert.match(DRAFT_POLICY.success, /same transaction/);
  assert.match(DRAFT_POLICY.retry, /journal/);
  assert.deepEqual([...READ_WINDOW_STATUSES], ['case_mismatch', 'missing', 'not_file', 'not_text', 'ok', 'out_of_range', 'own_write', 'unsafe']);
});

test('the public core entry exports the Road and Task writers and the read-window projection', async () => {
  const core = await import('../../lib/core/index.js');
  const roads = await import('../../lib/store/roads/index.js');
  for (const name of ['createRoad', 'createTask', 'readRoad', 'readTask', 'projectReadWindows', 'buildStoredRoad', 'renderRoad', 'renderTaskScaffold', 'roadPath', 'taskPath', 'writeTemplateDraft']) {
    assert.equal(core[name], roads[name], `core exports ${name}`);
  }
  for (const name of ['createRoadNewPacket', 'createTaskNewPacket', 'createTemplatePacket']) assert.equal(typeof core[name], 'function', name);
  assert.equal(core.commandHandlers['road-new'], core.createRoadNewPacket);
  assert.equal(core.commandHandlers['task-new'], core.createTaskNewPacket);
  assert.equal(core.commandHandlers.template, core.createTemplatePacket);
  for (const { id, next_command_builder: builder } of core.commandManifest.commands) {
    assert.equal(typeof core.nextCommandBuilders[builder], 'function', `${id} names a real builder`);
  }
});
