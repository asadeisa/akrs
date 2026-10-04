// P2-W05: the transition table is closed and manifest-driven, status is owned by the lifecycle commands only, and the new
// finding is a catalog member with a closed reason list.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { getFindingDefinition } from '../../lib/findings/catalog.js';
import { ROAD_STATUSES } from '../../lib/schemas/road.js';
import { LIFECYCLE_FINDING_CODE, LIFECYCLE_POLICY, LIFECYCLE_REASONS, LIFECYCLE_TRANSITIONS } from '../../lib/store/lifecycle/index.js';
import { TRANSACTIONAL_COMMANDS } from '../../lib/store/transactions/index.js';
import { everything, update, updateForm } from '../change/support.js';
import { assertFindingsMatchCatalog } from '../road/support.js';
import { lifecycleWorld } from './support.js';

const entry = (id) => commandManifest.commands.find((command) => command.id === id);

test('the legal transitions are exactly the lifecycle commands of the manifest, and no edge is open-ended', () => {
  assert.deepEqual(Object.keys(LIFECYCLE_TRANSITIONS), ['road-activate', 'road-finish', 'road-reopen']);
  assert.equal(Object.isFrozen(LIFECYCLE_TRANSITIONS), true);
  for (const [id, row] of Object.entries(LIFECYCLE_TRANSITIONS)) {
    assert.ok(entry(id) !== undefined, `${id} is a manifest command`);
    assert.ok(TRANSACTIONAL_COMMANDS.includes(id), `${id} writes through the transaction coordinator`);
    assert.ok(row.from.length > 0 && row.from.every((status) => ROAD_STATUSES.includes(status)));
    assert.ok(ROAD_STATUSES.includes(row.to));
    assert.equal(row.from.includes(row.to), false, 'a transition changes the status');
  }
  assert.deepEqual(LIFECYCLE_TRANSITIONS['road-activate'], { ...LIFECYCLE_TRANSITIONS['road-activate'], from: ['QUEUED'], to: 'ACTIVE' });
  assert.deepEqual([LIFECYCLE_TRANSITIONS['road-finish'].from, LIFECYCLE_TRANSITIONS['road-finish'].to], [['ACTIVE'], 'DONE']);
  assert.deepEqual([LIFECYCLE_TRANSITIONS['road-reopen'].from, LIFECYCLE_TRANSITIONS['road-reopen'].to], [['ACTIVE', 'DONE'], 'QUEUED']);
  assert.equal(typeof LIFECYCLE_POLICY.decisions, 'object');
});

test('the manifest declares road check as a query and the lifecycle writers as guarded, journaled, dry-run capable mutations', () => {
  assert.deepEqual([entry('road-check').tokens, entry('road-check').mutability, entry('road-check').expected_snapshot], [['road', 'check'], 'query', 'not_applicable']);
  for (const [id, verb] of [['road-activate', 'activate'], ['road-finish', 'finish'], ['road-reopen', 'reopen']]) {
    const command = entry(id);
    assert.deepEqual(command.tokens, ['road', verb]);
    assert.equal(command.mutability, 'mutation');
    assert.equal(command.dry_run, true);
    assert.equal(command.idempotency, 'journal');
    assert.equal(command.expected_snapshot, 'required');
    assert.ok(command.flags.some(({ name }) => name === '--if-snapshot') && command.flags.some(({ name }) => name === '--request-id'));
  }
  assert.deepEqual([entry('lease-release').tokens, entry('lease-release').required_role, entry('lease-release').mutability], [['lease', 'release'], 'leader', 'mutation']);
  assert.equal(entry('road-activate').required_role, 'leader');
});

test('status cannot be smuggled through road update', async (t) => {
  const { repo } = await lifecycleWorld(t, { status: 'QUEUED' });
  const before = await everything(repo);
  const form = await updateForm(repo, 'R-P6-1', { status: 'DONE' }, 'roads/P6');
  const result = await update(repo, 'R-P6-1', form, { dryRun: true });
  assert.equal(result.packet.status, 'error');
  assert.deepEqual(result.packet.findings.map(({ detail }) => detail.reason), ['status_changed']);
  assert.equal(await everything(repo), before);
});

test('AKRS-R025 is a catalog finding whose reasons are the closed lifecycle list', () => {
  assert.equal(LIFECYCLE_FINDING_CODE, 'AKRS-R025');
  const definition = getFindingDefinition('AKRS-R025');
  assert.notEqual(definition, null);
  assert.deepEqual([...definition.data_schema.properties.reason.enum].sort(), [...LIFECYCLE_REASONS].sort());
  assert.equal(new Set(LIFECYCLE_REASONS).size, LIFECYCLE_REASONS.length);
  assertFindingsMatchCatalog({ findings: [] });
});
