import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { OUTPUT_FORMAT_FLAGS, commandManifest } from '../../lib/commands/manifest.js';
import { SCHEMA_REGISTRY } from '../../lib/schemas/index.js';
import { runCli } from '../helpers/process.js';
import {
  COMMAND_ENTRY_KEYS,
  COMMAND_MANIFEST_KEYS,
  COMMAND_EXPECTED_SNAPSHOT,
  COMMAND_IDEMPOTENCY,
  MCP_NAME_PATTERN,
  RESERVED_COMMAND_KEYS,
  validateCommandManifest,
} from '../../lib/schemas/command-manifest.js';
import { validateMutationChanges, validateReadOnlyPacket } from '../../lib/schemas/packet.js';

const base = JSON.parse(await readFile(new URL('../fixtures/packet-envelope/valid-manifest.json', import.meta.url), 'utf8'));

function manifestWith(...overrides) {
  const manifest = structuredClone(base);
  const [template] = manifest.commands;
  manifest.commands = overrides.map((override, index) => ({
    ...structuredClone(template),
    id: `example-${index}`,
    tokens: [`example-${index}`],
    input_schema: `akrs.command-input/example-${index}/v1`,
    output_schema: `akrs.command-output/example-${index}/v1`,
    ...override,
  }));
  return manifest;
}

const ok = (...overrides) => validateCommandManifest(manifestWith(...overrides)).ok;
const issueCodes = (...overrides) => validateCommandManifest(manifestWith(...overrides)).issues.map(({ code }) => code);

test('F2/F3 re-freeze: the entry keys gain mcp_tool and mcp_action and the capability enums widen', () => {
  assert.deepEqual(COMMAND_ENTRY_KEYS.slice(-3), ['next_command_builder', 'mcp_tool', 'mcp_action']);
  assert.equal(COMMAND_ENTRY_KEYS.length, 19);
  assert.deepEqual(COMMAND_IDEMPOTENCY, ['not_applicable', 'journal', 'none']);
  assert.deepEqual(COMMAND_EXPECTED_SNAPSHOT, ['not_applicable', 'required', 'lease', 'revalidate']);
  assert.equal(MCP_NAME_PATTERN.source, '^[a-z][a-z0-9_]{0,29}$');
  for (const list of [COMMAND_IDEMPOTENCY, COMMAND_EXPECTED_SNAPSHOT]) assert.equal(Object.isFrozen(list), true);
});

const WRITERS = [
  // [label, mutability, idempotency, expected_snapshot, dry_run, legal]
  ['journal mutation with each snapshot mode', 'mutation', 'journal', 'required', true, true],
  ['journal mutation with lease', 'mutation', 'journal', 'lease', true, true],
  ['journal mutation with revalidate', 'mutation', 'journal', 'revalidate', true, true],
  ['journal mutation with no snapshot', 'mutation', 'journal', 'not_applicable', true, true],
  ['journal mutation must dry-run', 'mutation', 'journal', 'revalidate', false, false],
  ['journal derived_write', 'derived_write', 'journal', 'not_applicable', true, true],
  ['execution without journal or dry-run', 'mutation', 'none', 'not_applicable', false, true],
  ['none mutation may still declare dry-run', 'mutation', 'none', 'not_applicable', true, true],
  ['derived_write cache output without journal', 'derived_write', 'none', 'not_applicable', false, true],
  ['none writer with a lease', 'mutation', 'none', 'lease', false, true],
  ['writer must declare journal or none', 'mutation', 'not_applicable', 'not_applicable', true, false],
  ['derived_write must declare journal or none', 'derived_write', 'not_applicable', 'not_applicable', false, false],
];

test('F3 re-freeze: dry_run is mandatory only for journal writers, and derived_write plus none is legal', () => {
  for (const [label, mutability, idempotency, snapshot, dryRun, legal] of WRITERS) {
    const result = ok({
      mutability, idempotency, expected_snapshot: snapshot, dry_run: dryRun,
    });
    assert.equal(result, legal, label);
  }
});

test('F3 re-freeze: queries stay pure and every capability must be not_applicable', () => {
  assert.equal(ok({}), true);
  for (const mutation of [
    { idempotency: 'journal' },
    { idempotency: 'none' },
    { expected_snapshot: 'required' },
    { expected_snapshot: 'lease' },
    { expected_snapshot: 'revalidate' },
    { dry_run: true },
  ]) {
    assert.equal(ok(mutation), false, JSON.stringify(mutation));
    assert.equal(issueCodes(mutation).includes('invalid_capability'), true, JSON.stringify(mutation));
  }
  for (const [key, value] of [['idempotency', 'required'], ['expected_snapshot', 'yes'], ['idempotency', 'JOURNAL']]) {
    assert.equal(ok({ [key]: value }), false, `${key}=${value}`);
  }
});

test('F2 re-freeze: mcp_tool and mcp_action are required, null together, or a matching name pair', () => {
  assert.equal(ok({ mcp_tool: null, mcp_action: null }), true);
  assert.equal(ok({ mcp_tool: 'akrs_status', mcp_action: 'validate' }), true);
  assert.equal(ok({ mcp_tool: 'a', mcp_action: 'b' }), true);
  assert.equal(ok({ mcp_tool: `a${'b'.repeat(29)}`, mcp_action: 'x' }), true);
  for (const bad of ['Akrs_Road', '1abc', 'a-b', '', 'a'.repeat(31), 'akrs road', 5, [], {}, true]) {
    assert.equal(ok({ mcp_tool: bad, mcp_action: 'x' }), false, `tool ${JSON.stringify(bad)}`);
    assert.equal(ok({ mcp_tool: 'akrs_status', mcp_action: bad }), false, `action ${JSON.stringify(bad)}`);
  }
  assert.equal(ok({ mcp_tool: 'akrs_status', mcp_action: null }), false);
  assert.equal(ok({ mcp_tool: null, mcp_action: 'validate' }), false);
  assert.equal(issueCodes({ mcp_tool: 'akrs_status', mcp_action: null }).includes('invalid_mcp_pair'), true);
  assert.equal(ok({ mcp_tool: 'akrs_status', mcp_action: 'validate' }, { mcp_tool: 'akrs_status', mcp_action: 'explain' }), true);
  assert.equal(ok({ mcp_tool: 'akrs_status', mcp_action: 'validate' }, { mcp_tool: 'akrs_status', mcp_action: 'validate' }), false);
  assert.equal(issueCodes(
    { mcp_tool: 'akrs_status', mcp_action: 'validate' },
    { mcp_tool: 'akrs_status', mcp_action: 'validate' },
  ).includes('duplicate_value'), true);
});

test('F2 re-freeze: both new keys are required keys of every entry', () => {
  for (const key of ['mcp_tool', 'mcp_action']) {
    const manifest = manifestWith({});
    delete manifest.commands[0][key];
    const result = validateCommandManifest(manifest);
    assert.equal(result.ok, false, key);
    assert.equal(result.issues.some(({ code, path }) => code === 'missing_key' && path.endsWith(key)), true, key);
  }
});

const P0_COMMANDS = {
  help: { idempotency: 'not_applicable', expected_snapshot: 'not_applicable', mcp: [null, null], dry_run: false },
  version: { idempotency: 'not_applicable', expected_snapshot: 'not_applicable', mcp: [null, null], dry_run: false },
  validate: { idempotency: 'not_applicable', expected_snapshot: 'not_applicable', mcp: ['akrs_status', 'validate'], dry_run: false },
  explain: { idempotency: 'not_applicable', expected_snapshot: 'not_applicable', mcp: ['akrs_status', 'explain'], dry_run: false },
  init: { idempotency: 'journal', expected_snapshot: 'revalidate', mcp: [null, null], dry_run: true },
  sync: { idempotency: 'journal', expected_snapshot: 'revalidate', mcp: [null, null], dry_run: true },
  postinstall: { idempotency: 'none', expected_snapshot: 'not_applicable', mcp: [null, null], dry_run: true },
};

test('Q16 the shipped P0 manifest carries the re-frozen capability values', () => {
  assert.equal(validateCommandManifest(commandManifest).ok, true);
  assert.deepEqual(commandManifest.commands.map(({ id }) => id), Object.keys(P0_COMMANDS));
  for (const entry of commandManifest.commands) {
    const expected = P0_COMMANDS[entry.id];
    assert.equal(entry.idempotency, expected.idempotency, entry.id);
    assert.equal(entry.expected_snapshot, expected.expected_snapshot, entry.id);
    assert.deepEqual([entry.mcp_tool, entry.mcp_action], expected.mcp, entry.id);
    assert.equal(entry.dry_run, expected.dry_run, entry.id);
  }
});

test('Q16 derived_write cache files are listed in changed while queries still reject any change', () => {
  const packet = {
    request_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    changed: ['akrs/.cache/view/index.html'],
    snapshot: { before: `sha256:${'a'.repeat(64)}`, after: `sha256:${'a'.repeat(64)}` },
  };
  assert.equal(validateMutationChanges(packet, ['akrs/.cache/view/index.html']).ok, true);
  assert.equal(validateReadOnlyPacket(packet).ok, false);
  assert.equal(validateReadOnlyPacket({ ...packet, changed: [] }).ok, true);
  assert.equal(validateReadOnlyPacket({
    ...packet, changed: [], snapshot: { before: `sha256:${'a'.repeat(64)}`, after: `sha256:${'b'.repeat(64)}` },
  }).ok, false);
});

test('F2 re-freeze: the A1 command classes (page, test run, verify) are expressible', () => {
  assert.equal(ok({
    mutability: 'derived_write', idempotency: 'none', expected_snapshot: 'not_applicable', dry_run: false,
    mcp_tool: 'akrs_page', mcp_action: 'read',
  }), true);
  assert.equal(ok({
    mutability: 'mutation', idempotency: 'none', expected_snapshot: 'lease', dry_run: false,
    mcp_tool: 'akrs_test', mcp_action: 'run',
  }), true);
  assert.equal(ok({
    mutability: 'mutation', idempotency: 'journal', expected_snapshot: 'revalidate', dry_run: true,
    mcp_tool: 'akrs_write', mcp_action: 'road_new',
  }), true);
});

// ---- item 7: reserved (frozen, not yet dispatched) scope commands --------------------------------------------
const reservedBase = () => structuredClone(commandManifest.reserved_commands[0]);
const withReserved = (...entries) => ({ ...structuredClone(base), reserved_commands: entries });
const reservedOk = (...entries) => validateCommandManifest(withReserved(...entries)).ok;
const reservedCodes = (...entries) => validateCommandManifest(withReserved(...entries)).issues.map(({ code }) => code);

const flag = (name, valueType, required) => ({ name, value_type: valueType, required, repeatable: false });
const OUTPUT = OUTPUT_FORMAT_FLAGS.map((entry) => ({ ...entry }));

const RESERVED = {
  'scope-request': {
    tokens: ['scope', 'request'],
    mutability: 'mutation',
    positionals: [],
    flags: [flag('--input', 'path', true), ...OUTPUT],
    input_schema: 'akrs.scope-request/v1',
  },
  'scope-approve': {
    tokens: ['scope', 'approve'],
    mutability: 'mutation',
    positionals: [{ name: 'target', required: true, variadic: false }],
    flags: [flag('--reason', 'string', false), ...OUTPUT],
    input_schema: null,
  },
  'scope-reject': {
    tokens: ['scope', 'reject'],
    mutability: 'mutation',
    positionals: [{ name: 'target', required: true, variadic: false }],
    flags: [flag('--reason', 'string', true), ...OUTPUT],
    input_schema: null,
  },
  'scope-list': {
    tokens: ['scope', 'list'],
    mutability: 'query',
    positionals: [{ name: 'road', required: false, variadic: false }],
    flags: OUTPUT,
    input_schema: null,
  },
};

test('F14 the manifest gains a closed top-level reserved_commands key after commands', () => {
  assert.deepEqual(COMMAND_MANIFEST_KEYS, ['schema_version', 'commands', 'reserved_commands']);
  assert.deepEqual(RESERVED_COMMAND_KEYS, [
    'id', 'tokens', 'owner_packet', 'mutability', 'positionals', 'flags', 'input_schema', 'store',
  ]);
  assert.deepEqual(Object.keys(commandManifest), COMMAND_MANIFEST_KEYS);
  assert.equal(Object.isFrozen(commandManifest.reserved_commands), true);
  assert.equal(Object.isFrozen(RESERVED_COMMAND_KEYS), true);
  const missing = structuredClone(base);
  delete missing.reserved_commands;
  assert.equal(validateCommandManifest(missing).issues.some(({ code, path }) => code === 'missing_key' && path === '$.reserved_commands'), true);
  for (const bad of [null, {}, 'x', 5]) {
    assert.equal(validateCommandManifest({ ...structuredClone(base), reserved_commands: bad }).ok, false, JSON.stringify(bad));
  }
  assert.equal(reservedOk(), true);
});

test('F14 the four scope commands are frozen exactly as decided (names, owner, input, flags, store)', () => {
  assert.deepEqual(commandManifest.reserved_commands.map(({ id }) => id), Object.keys(RESERVED));
  for (const entry of commandManifest.reserved_commands) {
    const expected = RESERVED[entry.id];
    assert.deepEqual(Object.keys(entry), RESERVED_COMMAND_KEYS, entry.id);
    assert.deepEqual(entry.tokens, expected.tokens, entry.id);
    assert.equal(entry.owner_packet, 'P1-W07', entry.id);
    assert.equal(entry.mutability, expected.mutability, entry.id);
    assert.deepEqual(entry.positionals, expected.positionals, entry.id);
    assert.deepEqual(entry.flags, expected.flags, entry.id);
    assert.equal(entry.input_schema, expected.input_schema, entry.id);
    assert.equal(entry.store, 'scope/{road}.jsonl', entry.id);
  }
  assert.equal(validateCommandManifest(commandManifest).ok, true);
});

test('F14 reserved entries are closed objects: every key is required and unknown keys are rejected', () => {
  for (const key of RESERVED_COMMAND_KEYS) {
    const entry = reservedBase();
    delete entry[key];
    const result = validateCommandManifest(withReserved(entry));
    assert.equal(result.ok, false, key);
    assert.equal(result.issues.some(({ code, path }) => code === 'missing_key' && path.endsWith(`.${key}`)), true, key);
  }
  const extra = { ...reservedBase(), extra: true };
  assert.equal(reservedCodes(extra).includes('unknown_key'), true);
  assert.equal(reservedCodes('scope-list').includes('invalid_type'), true);
});

test('F14 reserved entry fields reuse the live validators and the new owner/schema/store rules', () => {
  const entry = (override) => ({ ...reservedBase(), ...override });
  assert.equal(reservedOk(entry({ id: 'Bad_Id' })), false);
  assert.equal(reservedOk(entry({ tokens: [] })), false);
  assert.equal(reservedOk(entry({ tokens: ['Scope'] })), false);
  assert.equal(reservedOk(entry({ mutability: 'write' })), false);
  assert.equal(reservedOk(entry({ mutability: 'derived_write' })), true);
  for (const owner of ['P1-W07', 'P0-W06', 'P9-W99']) assert.equal(reservedOk(entry({ owner_packet: owner })), true, owner);
  for (const owner of ['p1-w07', 'P1-W7', 'P10-W07', 'P1-W007', '', null, 7]) {
    assert.equal(reservedOk(entry({ owner_packet: owner })), false, String(owner));
  }
  assert.equal(reservedOk(entry({ positionals: [{ name: 'a', required: false, variadic: false }, { name: 'b', required: true, variadic: false }] })), false);
  assert.equal(reservedOk(entry({ positionals: [{ name: 'a', required: true, variadic: false }, { name: 'a', required: true, variadic: false }] })), false);
  assert.equal(reservedOk(entry({ positionals: 'x' })), false);
  assert.equal(reservedOk(entry({ flags: [flag('--reason', 'string', true), flag('--reason', 'string', false)] })), false);
  assert.equal(reservedOk(entry({ flags: [flag('reason', 'string', true)] })), false);
  assert.equal(reservedOk(entry({ flags: [flag('--reason', 'text', true)] })), false);
  assert.equal(reservedOk(entry({ flags: [] })), true);
  assert.equal(reservedOk(entry({ input_schema: null })), true);
  assert.equal(reservedOk(entry({ input_schema: 'akrs.scope-request/v1' })), true);
  for (const schema of ['scope-request', 'akrs.scope-request', 'akrs.scope-request/v0', 'AKRS.x/v1', '', 5]) {
    assert.equal(reservedOk(entry({ input_schema: schema })), false, String(schema));
  }
  assert.equal(reservedOk(entry({ store: null })), true);
  for (const store of ['scope/{road}.jsonl', 'a/b.jsonl', 'file.jsonl']) assert.equal(reservedOk(entry({ store })), true, store);
  for (const store of ['/scope/x.jsonl', '../x.jsonl', 'scope/../x.jsonl', 'scope//x.jsonl', 'scope/./x.jsonl', 'scope/x/',
    'scope\\x.jsonl', 'C:/x.jsonl', 'scope/{Road}.jsonl', 'scope/{}.jsonl', 'scope/{road.jsonl', '', 7, 'scope/a b.jsonl']) {
    assert.equal(reservedOk(entry({ store })), false, JSON.stringify(store));
  }
});

test('F14 ids and token sets are unique across commands and reserved_commands together', () => {
  const live = commandManifest.commands[0];
  const collideId = { ...reservedBase(), id: live.id };
  const collideTokens = { ...reservedBase(), tokens: [...live.tokens] };
  const idIssues = validateCommandManifest({ ...structuredClone(commandManifest), reserved_commands: [collideId] }).issues;
  assert.equal(idIssues.some(({ code, path }) => code === 'duplicate_value' && path === '$.reserved_commands[0].id'), true);
  const tokenIssues = validateCommandManifest({ ...structuredClone(commandManifest), reserved_commands: [collideTokens] }).issues;
  assert.equal(tokenIssues.some(({ code, path }) => code === 'duplicate_value' && path === '$.reserved_commands[0].tokens'), true);
  assert.equal(reservedCodes(reservedBase(), reservedBase()).filter((code) => code === 'duplicate_value').length, 2);
  assert.equal(reservedOk(reservedBase(), { ...reservedBase(), id: 'scope-other', tokens: ['scope', 'other'] }), true);
});

test('F14 every non-null reserved input_schema is a registered artifact schema', () => {
  const schemas = commandManifest.reserved_commands.map(({ input_schema: schema }) => schema).filter((schema) => schema !== null);
  assert.deepEqual(schemas, ['akrs.scope-request/v1']);
  for (const schema of schemas) assert.equal(Object.hasOwn(SCHEMA_REGISTRY, schema), true, schema);
});

test('F14 reserved commands are not dispatched or listed: the CLI answers akrs scope list with the unknown-command finding', async () => {
  for (const args of [['scope', 'list'], ['scope', 'request'], ['scope', 'approve', 'R-1'], ['scope', 'reject', 'R-1']]) {
    const result = await runCli([...args, '--json']);
    assert.equal(result.exitCode, 2, args.join(' '));
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.status, 'error', args.join(' '));
    assert.equal(packet.findings[0].code, 'AKRS-C001', args.join(' '));
  }
  const plain = await runCli(['scope', 'list']);
  assert.equal(plain.exitCode, 2);
  assert.equal(plain.stdout, '');
  assert.match(plain.stderr, /AKRS-C001/);
  const help = await runCli(['--help']);
  assert.equal(help.stdout.includes('scope'), false);
  assert.deepEqual(commandManifest.commands.map(({ id }) => id).filter((id) => id.startsWith('scope')), []);
});
