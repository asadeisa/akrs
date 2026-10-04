// The frozen P1-W08 decisions: the manifest entry, role, snapshot row, transaction membership, the new permanent
// finding codes, the store policy text, and the exact frozen Memory labels.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest, nextCommandBuilders } from '../../lib/commands/manifest.js';
import { getFindingDefinition } from '../../lib/findings/catalog.js';
import { validateCommandManifest } from '../../lib/schemas/command-manifest.js';
import { MEMORY_LABELS, validateMemoryInput } from '../../lib/schemas/memory.js';
import { COMMAND_SNAPSHOT_TABLE } from '../../lib/store/snapshots/index.js';
import { TRANSACTIONAL_COMMANDS, TRANSACTION_NON_MUTATIONS } from '../../lib/store/transactions/index.js';
import {
  MEMORY_DIRECTORY, MEMORY_FILE_REASONS, MEMORY_FINDING_CODES, MEMORY_POINTER_REASONS, MEMORY_STORE_POLICY, memoryPath,
} from '../../lib/store/memory/index.js';
import { assumption, memoryInput, unknown } from './support.js';

const entry = (id) => commandManifest.commands.find((candidate) => candidate.id === id);

test('the frozen labels are exactly Decided, Assumption High|Med|Low and Unknown, with nothing else accepted', () => {
  assert.deepEqual([...MEMORY_LABELS], ['Decided', 'Assumption High', 'Assumption Med', 'Assumption Low', 'Unknown']);
  const accepted = [memoryInput(), assumption('High'), assumption('Med'), assumption('Low'), unknown()];
  assert.deepEqual(accepted.map(({ label }) => label), [...MEMORY_LABELS]);
  for (const document of accepted) assert.equal(validateMemoryInput(document).ok, true, document.label);
  for (const label of [
    'decided', 'DECIDED', 'Decided ', ' Decided', 'Decided.', 'Assumption', 'Assumption (High)', 'Assumption high',
    'Assumption  High', 'Assumption Medium', 'Assumption Critical', 'Assumption-High', 'unknown', 'Unknown ', 'Fact', 'Open', '', null, 7,
  ]) {
    assert.equal(validateMemoryInput({ ...memoryInput(), label }).ok, false, JSON.stringify(label));
  }
});

test('memory-add: leader mutation with dry run, journal idempotency, revalidation and the A1 6.2 MCP mapping', () => {
  assert.equal(validateCommandManifest(commandManifest).ok, true);
  const command = entry('memory-add');
  assert.notEqual(command, undefined);
  assert.deepEqual(command.tokens, ['memory', 'add']);
  assert.equal(command.required_role, 'leader');
  assert.equal(command.mutability, 'mutation');
  assert.equal(command.dry_run, true);
  assert.equal(command.idempotency, 'journal');
  assert.equal(command.expected_snapshot, 'revalidate');
  assert.deepEqual(command.snapshot_inputs, ['memory']);
  assert.deepEqual(command.snapshot_inputs, COMMAND_SNAPSHOT_TABLE['memory-add'].inputs);
  assert.equal(command.streaming, 'none');
  assert.deepEqual(command.statuses, ['ok', 'warning', 'error', 'blocked', 'noop']);
  assert.deepEqual(command.exit_codes, [0, 1, 2, 3, 4]);
  assert.deepEqual([command.mcp_tool, command.mcp_action], ['akrs_write', 'memory_add']);
  assert.equal(command.input_schema, 'akrs.command-input/memory-add/v1');
  assert.equal(command.output_schema, 'akrs.command-output/memory-add/v1');
  assert.deepEqual(command.positionals, []);
  assert.deepEqual(command.flags.map(({ name }) => name).sort(), [
    '--again', '--dry-run', '--if-snapshot', '--input', '--json', '--jsonl', '--prompt', '--request-id', '--root', '--workflow-root',
  ]);
  const types = Object.fromEntries(command.flags.map(({ name, value_type: type }) => [name, type]));
  assert.deepEqual([types['--input'], types['--request-id'], types['--if-snapshot'], types['--dry-run'], types['--again']],
    ['path', 'string', 'string', 'boolean', 'boolean']);
  assert.equal(command.flags.every(({ required, repeatable }) => required === false && repeatable === false), true);
  assert.equal(command.next_command_builder, 'memory-add');
  assert.equal(typeof nextCommandBuilders['memory-add'], 'function');
});

test('memory-add is transactional and nowhere else; the other Phase 1 writers keep their entries', () => {
  assert.equal(TRANSACTIONAL_COMMANDS.includes('memory-add'), true);
  assert.equal(TRANSACTION_NON_MUTATIONS.includes('memory-add'), false);
  assert.deepEqual(COMMAND_SNAPSHOT_TABLE['memory-add'], { target: 'none', inputs: ['memory'], lease_guard: null });
  assert.deepEqual(commandManifest.commands.map(({ id }) => id).slice(-30), ['road-new', 'task-new', 'memory-add', 'log-append', 'road-update', 'road-move',
    'scope-request', 'scope-approve', 'scope-reject', 'scope-list', 'test-define', 'test-handoff', 'state-set', 'state-render', 'init-scaffold', 'executor-set', 'executor-remove', 'executor-list', 'road-fit', 'road-details', 'verify', 'road-check', 'road-activate', 'road-finish', 'road-reopen', 'lease-release', 'test-details', 'audit', 'doctor', 'template']);
});

test('the permanent finding codes: M001 exists, M002 (pointer) and M003 (file) are new, with closed detail shapes', () => {
  assert.deepEqual({ ...MEMORY_FINDING_CODES }, { schema: 'AKRS-M001', pointer: 'AKRS-M002', file: 'AKRS-M003' });
  assert.equal(getFindingDefinition('AKRS-M001').category, 'memory');
  const m002 = getFindingDefinition('AKRS-M002');
  assert.equal(m002.category, 'memory');
  assert.equal(m002.severity, 'error');
  assert.deepEqual(Object.keys(m002.data_schema.properties).sort(), ['line_count', 'path', 'pointer', 'reason']);
  assert.deepEqual(m002.data_schema.properties.reason.enum, [...MEMORY_POINTER_REASONS]);
  assert.deepEqual([...MEMORY_POINTER_REASONS], ['case_mismatch', 'missing', 'not_file', 'not_text', 'out_of_range', 'unsafe']);
  assert.equal(m002.data_schema.additionalProperties, false);
  const m003 = getFindingDefinition('AKRS-M003');
  assert.equal(m003.category, 'memory');
  assert.deepEqual(Object.keys(m003.data_schema.properties).sort(), ['path', 'pointer', 'reason', 'topic']);
  assert.deepEqual(m003.data_schema.properties.reason.enum, [...MEMORY_FILE_REASONS]);
  assert.deepEqual([...MEMORY_FILE_REASONS], ['case_mismatch', 'not_file', 'not_text', 'table_not_last', 'unsafe']);
  assert.equal(m003.data_schema.additionalProperties, false);
  for (const definition of [m002, m003]) {
    assert.equal(definition.rationale.length > 40, true);
    assert.equal(definition.remediation.length > 20, true);
  }
});

test('the store layout is documented and the path grammar follows the topic ID', () => {
  assert.equal(MEMORY_DIRECTORY, 'memory');
  assert.equal(memoryPath('payments'), 'memory/payments.md');
  assert.equal(memoryPath('ui.v2-notes'), 'memory/ui.v2-notes.md');
  for (const bad of ['', 'a/b', '../x', 'a b', 'CON', 'a'.repeat(65), null, 7]) assert.throws(() => memoryPath(bad), TypeError, String(bad));
  assert.match(MEMORY_STORE_POLICY.location, /memory\/<topic>\.md/);
  assert.match(MEMORY_STORE_POLICY.topic, /ID grammar/);
  assert.match(MEMORY_STORE_POLICY.create, /header/);
  assert.match(MEMORY_STORE_POLICY.append, /one canonical Markdown record/);
  assert.match(MEMORY_STORE_POLICY.text, /LF/);
  assert.match(MEMORY_STORE_POLICY.pointers, /path service/);
  assert.match(MEMORY_STORE_POLICY.unknown, /never promoted/);
  assert.match(MEMORY_STORE_POLICY.prose, /never scanned/);
  assert.match(MEMORY_STORE_POLICY.duplicates, /--again/);
  assert.match(MEMORY_STORE_POLICY.roles, /no adapter enforces roles/);
  assert.match(MEMORY_STORE_POLICY.reader, /unverified/);
});

test('the public core entry exports the Memory writer, reader and handler', async () => {
  const core = await import('../../lib/core/index.js');
  const memory = await import('../../lib/store/memory/index.js');
  for (const name of [
    'addMemory', 'readMemory', 'readMemoryFile', 'listMemoryFiles', 'parseMemoryText', 'memoryPath', 'renderMemoryRecord',
    'MEMORY_STORE_POLICY', 'MEMORY_FINDING_CODES',
  ]) {
    assert.notEqual(core[name], undefined, `core exports ${name}`);
    assert.equal(core[name], memory[name], `core exports ${name}`);
  }
  assert.equal(typeof core.createMemoryAddPacket, 'function');
  assert.equal(core.commandHandlers['memory-add'], core.createMemoryAddPacket);
  for (const { id, next_command_builder: builder } of core.commandManifest.commands) {
    assert.equal(typeof core.nextCommandBuilders[builder], 'function', `${id} names a real builder`);
  }
});
