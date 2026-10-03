// P1-W05 / F9: the frozen TRANSACTION_POLICY decision record, the closed manifest schema, the finding codes and the
// list of commands that must use the coordinator.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { getFindingDefinition } from '../../lib/findings/catalog.js';
import { COMMAND_SNAPSHOT_TABLE } from '../../lib/store/snapshots/index.js';
import {
  TRANSACTIONAL_COMMANDS,
  TRANSACTION_BOUNDARIES,
  TRANSACTION_EXCEPTIONS,
  TRANSACTION_FINDING_CODES,
  TRANSACTION_MANIFEST_SCHEMA,
  TRANSACTION_NON_MUTATIONS,
  TRANSACTION_OPERATION_TYPES,
  TRANSACTION_POLICY,
  TRANSACTION_RECOVERY_BOUNDARIES,
  TRANSACTION_STATES,
  validateTransactionManifest,
} from '../../lib/store/transactions/index.js';
import { ulid } from './support.js';

function assertDeepFrozen(value, path = 'value') {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true, `${path} is frozen`);
  for (const [key, child] of Object.entries(value)) assertDeepFrozen(child, `${path}.${key}`);
}

const sha = (character) => `sha256:${character.repeat(64)}`;

function manifest(overrides = {}) {
  return {
    schema: 'akrs.tx/v1',
    id: ulid(1),
    request_id: ulid(2),
    command: 'done',
    state: 'prepared',
    operations: [
      { index: 0, type: 'create', path: 'log/0002.jsonl', to: null, before_hash: null, after_hash: sha('a') },
      { index: 1, type: 'replace', path: 'roads/R1.json', to: null, before_hash: sha('b'), after_hash: sha('c') },
      { index: 2, type: 'delete', path: 'drafts/road-R1.json', to: null, before_hash: sha('d'), after_hash: null },
    ],
    directories: [],
    progress: 0,
    created_at: '2026-10-03T10:00:00.000Z',
    committed_at: null,
    ...overrides,
  };
}

test('TRANSACTION_POLICY is a frozen, documented F9 decision record', () => {
  assertDeepFrozen(TRANSACTION_POLICY);
  assert.equal(TRANSACTION_POLICY.manifest_schema, 'akrs.tx/v1');
  assert.equal(TRANSACTION_MANIFEST_SCHEMA, 'akrs.tx/v1');
  assert.equal(TRANSACTION_POLICY.location, '.ops/tx');
  assert.deepEqual(TRANSACTION_STATES, ['staging', 'prepared', 'applying', 'committed']);
  assert.deepEqual(TRANSACTION_POLICY.states, TRANSACTION_STATES);
  assert.deepEqual(TRANSACTION_OPERATION_TYPES, ['create', 'replace', 'append', 'move', 'delete']);
  assert.deepEqual(TRANSACTION_POLICY.operation_types, TRANSACTION_OPERATION_TYPES);
  assert.deepEqual(TRANSACTION_POLICY.manifest_keys, [
    'schema', 'id', 'request_id', 'command', 'state', 'operations', 'directories', 'progress', 'created_at', 'committed_at',
  ]);
  assert.deepEqual(TRANSACTION_POLICY.operation_keys, ['index', 'type', 'path', 'to', 'before_hash', 'after_hash']);
  assert.deepEqual(TRANSACTION_POLICY.order, [
    'acquire lock',
    'recover every incomplete transaction',
    'journal conflict and replay check',
    'render and validate the full proposed tree',
    'write before and after images and the staging manifest (fsync)',
    'mark the manifest prepared',
    'append the journal prepared record (carries the transaction ID)',
    'apply the operations in order, durable progress after each',
    'compute the after snapshot and write packet.json',
    'write the commit marker (manifest state committed)',
    'append the journal committed record',
    'remove the transaction directory',
    'release lock',
  ]);
  for (const key of ['layout', 'targets', 'operations', 'recovery', 'fsync', 'boundaries', 'commands', 'journal',
    'snapshots', 'windows', 'corruption']) {
    assert.ok(Object.hasOwn(TRANSACTION_POLICY, key), `policy documents ${key}`);
  }
  assert.match(TRANSACTION_POLICY.fsync.windows, /directory fsync is skipped/);
  assert.deepEqual(TRANSACTION_POLICY.finding_codes, TRANSACTION_FINDING_CODES);
});

test('the recorded boundaries are the documented crash points', () => {
  assert.deepEqual(TRANSACTION_BOUNDARIES, [
    'before_image_written', 'after_image_written', 'manifest_staged', 'manifest_prepared', 'journal_prepared',
    'operation_applied', 'packet_written', 'commit_marker', 'journal_committed', 'journal_indexed',
    'cleanup_started', 'cleanup_images_removed', 'cleanup_finished',
  ]);
  assert.deepEqual(TRANSACTION_RECOVERY_BOUNDARIES, [
    'recovery_started', 'recovery_step', 'recovery_completed', 'recovery_cleanup',
  ]);
  assert.deepEqual(TRANSACTION_POLICY.boundaries.recorded, TRANSACTION_BOUNDARIES);
  assert.deepEqual(TRANSACTION_POLICY.boundaries.recovery, TRANSACTION_RECOVERY_BOUNDARIES);
});

test('the new permanent finding codes exist in the catalog', () => {
  assert.deepEqual(TRANSACTION_FINDING_CODES, { recovery_blocked: 'AKRS-C014', invalid_change_set: 'AKRS-C015' });
  for (const code of Object.values(TRANSACTION_FINDING_CODES)) {
    const definition = getFindingDefinition(code);
    assert.ok(definition, code);
    assert.equal(definition.category, 'command');
    assert.equal(definition.severity, 'error');
  }
});

test('the manifest validator accepts a closed akrs.tx/v1 manifest in every state', () => {
  assert.equal(validateTransactionManifest(manifest()).ok, true);
  assert.equal(validateTransactionManifest(manifest({ state: 'staging' })).ok, true);
  assert.equal(validateTransactionManifest(manifest({ state: 'applying', progress: 2 })).ok, true);
  assert.equal(validateTransactionManifest(manifest({
    state: 'committed', progress: 3, committed_at: '2026-10-03T10:00:01.000Z',
  })).ok, true);
});

test('the manifest validator is closed and refuses every malformed shape', () => {
  const bad = (value, code) => {
    const verdict = validateTransactionManifest(value);
    assert.equal(verdict.ok, false, JSON.stringify(value).slice(0, 120));
    if (code !== undefined) assert.ok(verdict.issues.some((item) => item.code === code), `${code}: ${JSON.stringify(verdict.issues)}`);
  };
  bad(null);
  bad([]);
  bad({ ...manifest(), extra: 1 }, 'unknown_key');
  const { schema: _schema, ...withoutSchema } = manifest();
  bad(withoutSchema, 'missing_key');
  bad(manifest({ schema: 'akrs.tx/v2' }));
  bad(manifest({ id: 'not-a-ulid' }));
  bad(manifest({ request_id: 'nope' }));
  bad(manifest({ command: 'Not A Command' }));
  bad(manifest({ state: 'done' }), 'invalid_value');
  bad(manifest({ operations: [] }));
  bad(manifest({ operations: 'x' }));
  bad(manifest({ progress: -1 }));
  bad(manifest({ progress: 4 }), 'out_of_range');
  bad(manifest({ progress: 1 }), 'invalid_value'); // prepared means nothing applied yet
  bad(manifest({ created_at: 'yesterday' }));
  bad(manifest({ state: 'committed', progress: 3, committed_at: null }), 'invalid_value');
  bad(manifest({ committed_at: '2026-10-03T10:00:01.000Z' }), 'invalid_value');
  bad(manifest({ state: 'committed', progress: 2, committed_at: '2026-10-03T10:00:01.000Z' }), 'invalid_value');
  const withOperation = (patch, at = 0) => manifest({
    operations: manifest().operations.map((operation, index) => (index === at ? { ...operation, ...patch } : operation)),
  });
  bad(withOperation({ index: 5 }), 'invalid_value');
  bad(withOperation({ type: 'rename' }), 'invalid_value');
  bad(withOperation({ path: '../escape' }));
  bad(withOperation({ path: '/abs' }));
  bad(withOperation({ before_hash: sha('a') }), 'invalid_value'); // create must have no before image
  bad(withOperation({ after_hash: null }), 'invalid_value');
  bad(withOperation({ to: 'x/y' }), 'invalid_value'); // only move has a destination
  bad(withOperation({ after_hash: 'sha256:zz' }));
  bad(withOperation({ extra: true }), 'unknown_key');
  bad(withOperation({ type: 'delete', before_hash: null, after_hash: null }), 'invalid_value');
  bad(withOperation({ type: 'delete', before_hash: sha('a'), after_hash: sha('b') }), 'invalid_value');
  bad(withOperation({ type: 'move', before_hash: sha('a'), after_hash: sha('b'), to: 'roads/x.json' }), 'invalid_value');
  bad(withOperation({ type: 'move', before_hash: sha('a'), after_hash: sha('a'), to: null }), 'invalid_value');
  bad(manifest({ directories: ['../x'] }));
  bad(manifest({ directories: 'x' }));
});

test('a move operation carries a destination and equal before and after hashes', () => {
  const move = manifest({
    operations: [{ index: 0, type: 'move', path: 'roads/R9.json', to: 'roads/archive/R9.json', before_hash: sha('e'), after_hash: sha('e') }],
    directories: ['roads/archive'],
  });
  assert.equal(validateTransactionManifest(move).ok, true);
});

test('TRANSACTIONAL_COMMANDS pins every workflow mutation that must use the coordinator', () => {
  assert.deepEqual(TRANSACTIONAL_COMMANDS, [
    'done', 'executor-remove', 'executor-set', 'init-scaffold', 'log-append', 'memory-add', 'plan-finish',
    'road-activate', 'road-finish', 'road-move', 'road-new', 'road-reopen', 'road-update', 'scope-approve',
    'scope-reject', 'scope-request', 'state-render', 'state-set', 'task-new', 'test-define', 'test-handoff',
    'test-result', 'yield',
  ]);
  assertDeepFrozen(TRANSACTIONAL_COMMANDS);
  assert.deepEqual(TRANSACTION_POLICY.commands.transactional, TRANSACTIONAL_COMMANDS);
});

test('the explicit exceptions are documented with a reason and the store that owns them', () => {
  assertDeepFrozen(TRANSACTION_EXCEPTIONS);
  assert.deepEqual(Object.keys(TRANSACTION_EXCEPTIONS), [
    'agents-setup', 'init', 'lease-release', 'postinstall', 'projects-add', 'projects-remove', 'sync', 'work',
  ]);
  const reasons = new Set(Object.values(TRANSACTION_EXCEPTIONS).map(({ reason }) => reason));
  assert.deepEqual([...reasons].sort(), ['agent_config', 'doctrine_install', 'lease_store', 'user_config']);
  for (const [command, entry] of Object.entries(TRANSACTION_EXCEPTIONS)) {
    assert.equal(typeof entry.store, 'string', command);
    assert.ok(entry.store.length > 20, `${command} names its store`);
  }
  // install commands keep the P0-W06 doctrine store
  for (const command of ['init', 'sync', 'postinstall']) assert.equal(TRANSACTION_EXCEPTIONS[command].reason, 'doctrine_install');
  // lease-only commands still go through the journal recovery hooks, so they never run beside an unrecovered transaction
  for (const command of ['work', 'lease-release']) assert.match(TRANSACTION_EXCEPTIONS[command].store, /recovery hooks/);
});

test('every command-table row is a coordinator command, a documented exception, or not a mutation', () => {
  const rows = Object.keys(COMMAND_SNAPSHOT_TABLE).sort();
  const transactional = new Set(TRANSACTIONAL_COMMANDS);
  const exceptions = new Set(Object.keys(TRANSACTION_EXCEPTIONS));
  const nonMutations = new Set(TRANSACTION_NON_MUTATIONS);
  assert.equal(transactional.size, TRANSACTIONAL_COMMANDS.length, 'no duplicates');
  assert.equal(nonMutations.size, TRANSACTION_NON_MUTATIONS.length, 'no duplicates');
  for (const row of rows) {
    const memberships = [transactional, exceptions, nonMutations].filter((set) => set.has(row)).length;
    assert.equal(memberships, 1, `${row} must be in exactly one of the three lists`);
  }
  for (const command of [...transactional, ...exceptions, ...nonMutations]) {
    assert.ok(Object.hasOwn(COMMAND_SNAPSHOT_TABLE, command), `${command} is a command-table row`);
  }
  // queries, executions and derived caches that must never be listed as transactional
  for (const command of ['road-check', 'road-fit', 'page', 'view', 'verify', 'test-run', 'boot', 'validate', 'status']) {
    assert.ok(nonMutations.has(command), `${command} is not a mutation`);
  }
});

test('every enabled mutation command of the manifest is covered', () => {
  const covered = new Set([...TRANSACTIONAL_COMMANDS, ...Object.keys(TRANSACTION_EXCEPTIONS)]);
  for (const command of commandManifest.commands) {
    if (command.mutability === 'mutation') assert.ok(covered.has(command.id), `${command.id} needs a transaction decision`);
  }
});
