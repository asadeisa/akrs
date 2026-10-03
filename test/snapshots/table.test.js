// F5 freeze: the per-command snapshot projection table (P1-W02 + A1 F17 projection part).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import {
  COMMAND_SNAPSHOT_TABLE,
  EMPTY_SNAPSHOT,
  LEASE_CONTRACT_PROJECTION,
  PLAN_CLOSE_PROJECTION,
  PRODUCT_INPUT_POLICY,
  ROAD_PACKET_PROJECTION,
  SNAPSHOT_EXCLUSIONS,
  SNAPSHOT_PROJECTIONS,
  SNAPSHOT_TARGETS,
  SNAPSHOT_VALUE_TOKENS,
  TESTER_LEASE_PROJECTION,
  TESTER_PACKET_PROJECTION,
  WORKFLOW_PROJECTION,
  validateSnapshotTable,
} from '../../lib/store/snapshots/index.js';
import * as core from '../../lib/core/index.js';

// Every read and mutation command of COMMAND-MATRIX.md, by its binding manifest ID.
const MATRIX_COMMANDS = [
  'agents-doctor', 'agents-list', 'agents-setup', 'audit', 'boot', 'doctor', 'done', 'executor-list',
  'executor-remove', 'executor-set', 'explain', 'graph', 'help', 'init', 'init-scaffold', 'lease-release', 'log',
  'log-append', 'mcp', 'memory-add', 'next', 'page', 'plan-finish', 'postinstall', 'projects-add', 'projects-list',
  'projects-remove', 'reuse-scan', 'road-activate', 'road-check', 'road-details', 'road-finish', 'road-fit',
  'road-move', 'road-new', 'road-reopen', 'road-update', 'scope-approve', 'scope-list', 'scope-reject',
  'scope-request', 'stale', 'state-render', 'state-set', 'status', 'status-all-projects', 'sync', 'task-new',
  'template', 'test-define', 'test-details', 'test-handoff', 'test-result', 'test-run', 'validate', 'verify',
  'version', 'view', 'watch', 'where', 'work', 'yield', 'guard',
].sort();

const sorted = (values) => [...values].sort();

test('F5 the table has exactly one closed row per matrix command', () => {
  assert.deepEqual(Object.keys(COMMAND_SNAPSHOT_TABLE).sort(), MATRIX_COMMANDS);
  for (const [id, row] of Object.entries(COMMAND_SNAPSHOT_TABLE)) {
    assert.deepEqual(Object.keys(row).sort(), ['inputs', 'lease_guard', 'target'], id);
    assert.ok(Object.isFrozen(row) && Object.isFrozen(row.inputs), id);
  }
  assert.equal(validateSnapshotTable(COMMAND_SNAPSHOT_TABLE).ok, true);
});

test('F5 the projection catalog is closed and every row uses only in-scope projections', () => {
  assert.deepEqual(sorted(Object.keys(SNAPSHOT_PROJECTIONS)), [
    'agent-configs', 'doctrine', 'executors', 'log', 'memory', 'plan', 'plan-contract', 'plan-handoffs',
    'plan-product', 'plan-reads', 'plan-results', 'plan-roads', 'plans', 'projects-registry', 'road', 'road-deps',
    'road-handoffs', 'road-reads', 'road-scope-requests', 'road-scope-resolutions', 'road-task', 'road-writes',
    'roads', 'scope', 'state', 'state-render', 'tasks', 'verifications',
  ]);
  assert.deepEqual([...SNAPSHOT_TARGETS], ['none', 'road', 'plan']);
  for (const [id, projection] of Object.entries(SNAPSHOT_PROJECTIONS)) {
    assert.deepEqual(Object.keys(projection).sort(), ['engine', 'scope', 'source'], id);
    assert.ok(['global', 'road', 'plan'].includes(projection.scope), id);
    assert.ok(['snapshots', 'doctrine-install', 'agents-registry', 'user-config'].includes(projection.engine), id);
    assert.equal(typeof projection.source, 'string');
  }
  for (const [id, row] of Object.entries(COMMAND_SNAPSHOT_TABLE)) {
    assert.deepEqual([...row.inputs], sorted(new Set(row.inputs)), `${id} inputs are sorted and unique`);
    for (const input of row.inputs) {
      const { scope } = SNAPSHOT_PROJECTIONS[input];
      assert.ok(scope === 'global' || scope === row.target, `${id} uses ${input} outside its target`);
    }
  }
});

test('F5/F17 named projections pin exactly what affects each guarded surface', () => {
  assert.deepEqual([...LEASE_CONTRACT_PROJECTION],
    ['executors', 'road', 'road-deps', 'road-reads', 'road-scope-resolutions']);
  assert.deepEqual([...ROAD_PACKET_PROJECTION],
    ['executors', 'road', 'road-deps', 'road-reads', 'road-scope-requests', 'road-scope-resolutions', 'road-task']);
  assert.deepEqual([...TESTER_LEASE_PROJECTION], ['plan-contract', 'plan-product', 'plan-reads', 'plan-roads']);
  assert.deepEqual([...TESTER_PACKET_PROJECTION],
    ['plan', 'plan-contract', 'plan-handoffs', 'plan-product', 'plan-reads', 'plan-roads']);
  assert.deepEqual([...PLAN_CLOSE_PROJECTION],
    ['plan', 'plan-contract', 'plan-handoffs', 'plan-product', 'plan-reads', 'plan-results', 'plan-roads']);
  assert.deepEqual([...WORKFLOW_PROJECTION],
    ['executors', 'log', 'memory', 'plans', 'roads', 'scope', 'state', 'state-render', 'tasks', 'verifications']);

  const row = (id) => COMMAND_SNAPSHOT_TABLE[id];
  // A Road packet, a Road lifecycle command, and the Leader's guarded Road update share one projection, so an
  // expected snapshot taken from road-details is comparable. Cross-Road checks are revalidated under the lock.
  for (const id of ['road-details', 'road-update', 'road-check', 'road-activate', 'road-finish', 'road-reopen', 'scope-approve']) {
    assert.deepEqual(row(id).inputs, ROAD_PACKET_PROJECTION, id);
    assert.equal(row(id).target, 'road', id);
  }
  for (const id of ['work', 'done', 'yield', 'lease-release']) assert.deepEqual(row(id).inputs, LEASE_CONTRACT_PROJECTION, id);
  assert.deepEqual(row('test-details').inputs, TESTER_PACKET_PROJECTION);
  for (const id of ['test-run', 'test-result']) assert.deepEqual(row(id).inputs, TESTER_LEASE_PROJECTION, id);
  assert.deepEqual(row('plan-finish').inputs, PLAN_CLOSE_PROJECTION);
  for (const id of ['validate', 'boot', 'status', 'next', 'graph']) assert.deepEqual(row(id).inputs, WORKFLOW_PROJECTION, id);
  for (const id of ['help', 'version', 'explain', 'template', 'guard', 'page', 'mcp', 'watch']) {
    assert.deepEqual(row(id).inputs, [], id);
  }
  for (const id of ['init', 'sync', 'postinstall']) assert.deepEqual(row(id).inputs, ['doctrine'], id);

  // Only lease-implied guards name a lease; everything else compares an explicit snapshot against `inputs`.
  const leased = Object.entries(COMMAND_SNAPSHOT_TABLE).filter(([, value]) => value.lease_guard !== null)
    .map(([id, value]) => `${id}:${value.lease_guard}`).sort();
  assert.deepEqual(leased, ['done:road', 'road-finish:road', 'test-result:plan', 'test-run:plan', 'work:road', 'yield:road']);
});

test('F5 no projection reaches an excluded namespace, evidence, run records, or git metadata', () => {
  assert.deepEqual([...SNAPSHOT_EXCLUSIONS], [
    '.git/**',
    '{workflow}/.cache/**',
    '{workflow}/.ops/**',
    '{workflow}/drafts/**',
    '{workflow}/verifications/*/evidence/**',
  ]);
  assert.deepEqual([...SNAPSHOT_VALUE_TOKENS],
    ['ambiguous', 'case_mismatch', 'missing', 'not_file', 'not_text', 'out_of_range', 'unparseable', 'unsafe']);
  assert.deepEqual(Object.keys(PRODUCT_INPUT_POLICY).sort(), [
    'git_index', 'ignored', 'missing', 'source', 'staged', 'symlinks', 'text_normalization', 'tracked_dirty', 'untracked',
  ]);
  assert.equal(PRODUCT_INPUT_POLICY.source, 'working_tree_bytes');
  assert.equal(PRODUCT_INPUT_POLICY.git_index, 'not_an_input');
  assert.equal(EMPTY_SNAPSHOT, 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('F5 every enabled manifest entry declares exactly its table projection', () => {
  for (const entry of commandManifest.commands) {
    const row = COMMAND_SNAPSHOT_TABLE[entry.id];
    assert.ok(row !== undefined, `${entry.id} has a snapshot table row`);
    assert.deepEqual([...entry.snapshot_inputs], [...row.inputs], entry.id);
  }
  for (const entry of commandManifest.reserved_commands) {
    assert.ok(COMMAND_SNAPSHOT_TABLE[entry.id] !== undefined, `${entry.id} has a snapshot table row`);
  }
});

const INVALID_TABLES = [
  ['unknown row key', { validate: { target: 'none', inputs: [], lease_guard: null, extra: 1 } }],
  ['missing row key', { validate: { target: 'none', inputs: [] } }],
  ['unknown target', { validate: { target: 'repo', inputs: [], lease_guard: null } }],
  ['unknown projection', { validate: { target: 'none', inputs: ['everything'], lease_guard: null } }],
  ['unsorted inputs', { validate: { target: 'none', inputs: ['state', 'log'], lease_guard: null } }],
  ['duplicate inputs', { validate: { target: 'none', inputs: ['log', 'log'], lease_guard: null } }],
  ['road projection without road target', { validate: { target: 'none', inputs: ['road'], lease_guard: null } }],
  ['plan projection on a road row', { 'road-details': { target: 'road', inputs: ['plan'], lease_guard: null } }],
  ['lease guard on wrong target', { work: { target: 'plan', inputs: ['plan'], lease_guard: 'road' } }],
  ['unknown lease guard', { work: { target: 'road', inputs: ['road'], lease_guard: 'session' } }],
  ['bad command id', { 'Road New': { target: 'none', inputs: [], lease_guard: null } }],
  ['not an object', []],
];

for (const [name, table] of INVALID_TABLES) {
  test(`F5 an invalid table is rejected: ${name}`, () => {
    const result = validateSnapshotTable(table);
    assert.equal(result.ok, false);
    assert.ok(result.issues.length > 0);
  });
}

test('F5 the core entry exports the snapshot engine', () => {
  for (const name of ['computeSnapshot', 'commandSnapshot', 'captureReadSnapshot', 'validateSnapshotTable']) {
    assert.equal(typeof core[name], 'function', name);
  }
  assert.equal(core.COMMAND_SNAPSHOT_TABLE, COMMAND_SNAPSHOT_TABLE);
  assert.equal(core.LEASE_CONTRACT_PROJECTION, LEASE_CONTRACT_PROJECTION);
});
