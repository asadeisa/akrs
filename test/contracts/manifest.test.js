import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import {
  COMMAND_ENTRY_KEYS,
  COMMAND_MANIFEST_KEYS,
  COMMAND_MUTABILITY,
  COMMAND_EXPECTED_SNAPSHOT,
  COMMAND_IDEMPOTENCY,
  COMMAND_ROLES,
  COMMAND_STREAMING,
  COMMAND_VALUE_TYPES,
  validateCommandManifest,
} from '../../lib/schemas/command-manifest.js';

const fixtureUrl = new URL('../fixtures/packet-envelope/valid-manifest.json', import.meta.url);
const validManifest = JSON.parse(await readFile(fixtureUrl, 'utf8'));

test('F2 enables only commands whose owning packet delivered complete handlers', () => {
  assert.deepEqual(commandManifest.commands.map(({ id }) => id), [
    'help', 'version', 'validate', 'explain', 'init', 'sync', 'postinstall', 'road-new', 'task-new', 'memory-add', 'log-append', 'road-update', 'road-move',
    'scope-request', 'scope-approve', 'scope-reject', 'scope-list', 'test-define', 'test-handoff', 'state-set', 'state-render', 'init-scaffold', 'executor-set', 'executor-remove', 'executor-list', 'road-fit', 'road-details', 'verify', 'audit', 'doctor', 'template',
  ]);
  assert.equal(validateCommandManifest(commandManifest).ok, true);
});

test('F2 accepts the complete closed command entry grammar', () => {
  assert.equal(validateCommandManifest(validManifest).ok, true);
  assert.deepEqual(COMMAND_MANIFEST_KEYS, ['schema_version', 'commands', 'reserved_commands']);
  assert.deepEqual(COMMAND_ENTRY_KEYS, [
    'id', 'tokens', 'summary', 'input_schema', 'positionals', 'flags',
    'required_role', 'mutability', 'dry_run', 'idempotency',
    'expected_snapshot', 'snapshot_inputs', 'streaming', 'output_schema',
    'statuses', 'exit_codes', 'next_command_builder', 'mcp_tool', 'mcp_action',
  ]);
  assert.deepEqual(COMMAND_ROLES, ['any', 'leader', 'worker', 'tester']);
  assert.deepEqual(COMMAND_MUTABILITY, ['query', 'mutation', 'derived_write']);
  assert.deepEqual(COMMAND_VALUE_TYPES, ['boolean', 'string', 'path', 'integer', 'json']);
  assert.deepEqual(COMMAND_STREAMING, ['none', 'jsonl']);
  assert.deepEqual(COMMAND_IDEMPOTENCY, ['not_applicable', 'journal', 'none']);
  assert.deepEqual(COMMAND_EXPECTED_SNAPSHOT, ['not_applicable', 'required', 'lease', 'revalidate']);
});

test('F2 rejects every missing command field', () => {
  for (const key of COMMAND_ENTRY_KEYS) {
    const candidate = structuredClone(validManifest);
    delete candidate.commands[0][key];
    const result = validateCommandManifest(candidate);
    assert.equal(result.ok, false, key);
    assert.ok(result.issues.some((issue) => issue.code === 'missing_key'), key);
  }
});

test('F2 rejects unknown keys at every closed manifest level', () => {
  const candidates = [];
  const top = structuredClone(validManifest);
  top.extra = true;
  candidates.push(top);
  const entry = structuredClone(validManifest);
  entry.commands[0].extra = true;
  candidates.push(entry);
  const positional = structuredClone(validManifest);
  positional.commands[0].positionals[0].extra = true;
  candidates.push(positional);
  const flag = structuredClone(validManifest);
  flag.commands[0].flags[0].extra = true;
  candidates.push(flag);

  for (const candidate of candidates) {
    const result = validateCommandManifest(candidate);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === 'unknown_key'));
  }
});

test('F2 rejects malformed tokens, arguments, and contradictory capabilities', () => {
  const mutations = [
    (entry) => { entry.tokens = ['Road']; },
    (entry) => { entry.flags[0].name = '-r'; },
    (entry) => { entry.positionals.push({ name: 'optional', required: false, variadic: false }, { name: 'late', required: true, variadic: false }); },
    (entry) => { entry.mutability = 'mutation'; },
    (entry) => { entry.snapshot_inputs = ['zeta', 'alpha']; },
    (entry) => { entry.statuses = ['warning', 'ok']; },
    (entry) => { entry.exit_codes = [1, 0]; },
  ];

  for (const mutate of mutations) {
    const candidate = structuredClone(validManifest);
    mutate(candidate.commands[0]);
    assert.equal(validateCommandManifest(candidate).ok, false);
  }
});
