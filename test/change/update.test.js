import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateMutationChanges } from '../../lib/schemas/packet.js';
import {
  assertFindingsMatchCatalog, codesOf, createRepo, everything, fileWrite, patch, readEntry, roadFile, roadJson, seedRoad, snapshotOf, strict,
  update, updateForm,
} from './support.js';

const ID = 'R-P6-1';
const seeded = async (t, extra = {}) => {
  const repo = await createRepo(t);
  await seedRoad(repo, { id: ID, ...extra });
  return repo;
};
const guardReasons = (packet) => packet.findings.filter(({ code }) => code === 'AKRS-R014').map(({ detail }) => detail.reason).sort();

test('a full replacement is guarded by the snapshot, keeps status, lists exactly the Road file and replays as noop', async (t) => {
  const repo = await seeded(t);
  const before = await snapshotOf(repo, 'road-update', ID);
  const base = await updateForm(repo, ID);
  const document = { ...base, acceptance: ['The page renders.'], reads: [...base.reads, readEntry('app/config/payment-status.ts')] };
  const result = await update(repo, ID, document, { expectedSnapshot: before });
  assert.equal(result.outcome, 'committed');
  const { packet } = result;
  assert.equal(packet.status, 'ok');
  assert.deepEqual(packet.changed, ['roads/R-P6-1.json']);
  assert.equal(validateMutationChanges(packet, ['roads/R-P6-1.json']).ok, true);
  assert.deepEqual(packet.data.diff.map(({ field }) => field), ['reads', 'acceptance']);
  const stored = await roadJson(repo, ID);
  assert.equal(stored.status, 'QUEUED');
  assert.deepEqual(stored.acceptance, ['The page renders.']);
  assert.equal(stored.meta.generator.startsWith('akrs/'), true);
  assert.notEqual(packet.snapshot.before, packet.snapshot.after, 'the old packets are stale');
  assert.equal(packet.snapshot.before, before);
  const again = await update(repo, ID, document, { expectedSnapshot: before, requestId: packet.request_id });
  assert.equal(again.packet.status, 'noop');
});

test('rejected updates write nothing: id, status, plan, unknown key, graph, collision, no change, stale snapshot, missing guard', async (t) => {
  const repo = await seeded(t);
  await seedRoad(repo, { id: 'R-OTHER', writes: [fileWrite('src/shared.js')] }, { status: 'ACTIVE' });
  const snap = await snapshotOf(repo, 'road-update', ID);
  const base = await updateForm(repo, ID);
  const cases = [
    ['id_changed', { ...base, id: 'R-OTHER-2' }],
    ['status_changed', { ...base, status: 'ACTIVE' }],
    ['plan_changed', { ...base, plan: 'P9' }],
    ['write_collision', { ...base, writes: [fileWrite('src/shared.js')] }],
    ['no_change', base],
  ];
  for (const [reason, document] of cases) {
    const before = await everything(repo);
    const result = await update(repo, ID, document, { expectedSnapshot: snap });
    assert.equal(result.outcome, 'rejected', reason);
    assert.equal(guardReasons(result.packet).includes(reason), true, `${reason}: ${JSON.stringify(result.packet.findings.map(({ message }) => message))}`);
    assertFindingsMatchCatalog(result.packet);
    assert.deepEqual(await everything(repo), before, reason);
  }
  const graph = await update(repo, ID, { ...base, deps: ['R-NOPE'] }, { expectedSnapshot: snap });
  assert.deepEqual(codesOf(graph.packet), ['AKRS-R005']);
  const unknown = await update(repo, ID, { ...base, surprise: true }, { expectedSnapshot: snap });
  assert.equal(unknown.packet.data.kind, 'usage');
  const noGuard = await update(repo, ID, { ...base, acceptance: ['x'] });
  assert.equal(noGuard.packet.data.kind, 'usage');
  assert.match(noGuard.packet.findings[0].message, /--if-snapshot/);
  const stale = await update(repo, ID, { ...base, acceptance: ['x'] }, { expectedSnapshot: `sha256:${'0'.repeat(64)}` });
  assert.equal(stale.packet.status, 'blocked');
  assert.equal((await roadJson(repo, ID)).acceptance[0], base.acceptance[0]);
});

test('a removal needs a reason; a write collision that already existed is not blamed on the update', async (t) => {
  const repo = await seeded(t);
  const snap = await snapshotOf(repo, 'road-update', ID);
  const base = await updateForm(repo, ID);
  const removing = { ...base, reads: base.reads.slice(1), writes: [], checks: [] };
  const without = await update(repo, ID, removing, { expectedSnapshot: snap });
  assert.deepEqual(guardReasons(without.packet), ['removal_reason_missing', 'removal_reason_missing', 'removal_reason_missing']);
  const withReason = await update(repo, ID, removing, { expectedSnapshot: snap, reason: 'The page moved to another Road.' });
  assert.equal(withReason.outcome, 'committed');
  assert.deepEqual((await roadJson(repo, ID)).writes, []);
});

test('a dry run returns the exact proposed Road, diff, relations and budget and changes no byte', async (t) => {
  const repo = await seeded(t);
  await seedRoad(repo, { id: 'R-NEXT', deps: [ID] });
  const before = await strict(repo);
  const document = await updateForm(repo, ID, { acceptance: ['One.', 'Two.'] });
  const result = await update(repo, ID, document, { dryRun: true });
  assert.equal(result.outcome, 'dry_run');
  const { data } = result.packet;
  assert.equal(data.dry_run, true);
  assert.deepEqual(data.would_change, ['roads/R-P6-1.json']);
  assert.deepEqual(data.proposed.acceptance, ['One.', 'Two.']);
  assert.deepEqual(data.diff.map(({ field }) => field), ['acceptance']);
  assert.deepEqual(data.relations, { dependencies: [], dependents: ['R-NEXT'], task: null, pending_scope_requests: 0 });
  assert.equal(data.budget.reads, 2);
  assert.equal(data.budget.writes, 1);
  assert.equal(data.budget.read_lines, 14 + 3);
  assert.deepEqual(await strict(repo), before);
});

test('a patch expands to the full object: patch and full replacement write identical bytes', async (t) => {
  const patched = await seeded(t);
  const full = await seeded(t);
  const ops = [
    { op: 'add_read', read: readEntry('SOT/02-rules.md') },
    { op: 'remove_read', path: 'SOT/02-rules.md', lines: [2, 4], reason: 'Replaced by the whole file.' },
    { op: 'add_write', write: fileWrite('src/own.js') },
    { op: 'replace_acceptance', acceptance: ['Works.'] },
    { op: 'replace_steps', steps: ['One step.'] },
  ];
  const a = await patch(patched, ID, ops);
  assert.equal(a.outcome, 'committed');
  const base = await updateForm(full, ID);
  const b = await update(full, ID, {
    ...base,
    reads: [base.reads[0], readEntry('SOT/02-rules.md')],
    writes: [fileWrite('app/pages/admin.vue'), fileWrite('src/own.js')].sort((x, y) => (x.path < y.path ? -1 : 1)),
    acceptance: ['Works.'],
    steps: ['One step.'],
  }, { expectedSnapshot: await snapshotOf(full, 'road-update', ID), reason: 'Replaced by the whole file.' });
  assert.equal(b.outcome, 'committed');
  assert.equal(await roadFile(patched, ID), await roadFile(full, ID));
});

test('patch validation: closed operations, a reason on every remove_*, targets must exist; nothing is written', async (t) => {
  const repo = await seeded(t);
  const before = await everything(repo);
  const bad = [
    [[{ op: 'drop_everything' }], 'usage'],
    [[{ op: 'remove_write', path: 'app/pages/admin.vue' }], 'usage'],
    [[{ op: 'add_check', check: {}, extra: 1 }], 'usage'],
    [[{ op: 'remove_check', name: 'unit', reason: 'x', more: 1 }], 'usage'],
    [[{ op: 'remove_write', path: 'nope.js', reason: 'x' }], 'findings'],
    [[{ op: 'add_check', check: { name: 'unit', argv: ['npm', 'test'], timeout_ms: 1000 } }], 'findings'],
  ];
  for (const [ops, kind] of bad) {
    const result = await patch(repo, ID, ops);
    assert.equal(result.outcome, 'rejected', JSON.stringify(ops));
    assert.equal(result.packet.data.kind, kind, JSON.stringify(ops));
  }
  assert.deepEqual(await everything(repo), before);
});
