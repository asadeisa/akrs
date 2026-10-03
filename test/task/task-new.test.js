import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { LEASE_CONTRACT_PROJECTION, ROAD_PACKET_PROJECTION, commandSnapshot, computeSnapshot } from '../../lib/store/snapshots/index.js';
import { validateMutationChanges, validateReadOnlyPacket } from '../../lib/schemas/packet.js';
import { createTask, readRoad, readTask, renderTaskScaffold } from '../../lib/store/roads/index.js';
import {
  assertFindingsMatchCatalog, authoringOptions, codesOf, createRepo, draftDocument, fakeProviders, pointersOf, roadInput,
  seedRoad, treeDigest,
} from '../road/support.js';
import { taskInput } from './scaffold.test.js';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const stdin = (document) => ({ stdin: Buffer.from(JSON.stringify(document)) });
const submit = (repo, document, extra = {}) => createTask({ ...authoringOptions(repo, extra), channel: stdin(document) });
const fromFile = (repo, inputPath, extra = {}) => createTask({ ...authoringOptions(repo, extra), channel: { inputPath } });
const everything = (repo) => treeDigest(repo);
const strict = (repo) => treeDigest(repo, { exclude: [] });

const ROAD = roadInput({ id: 'R-P6-1', plan: 'P6', task: 'T-P6-1' });
async function repoWithRoad(t, road = ROAD, folder = 'roads/P6') {
  const repo = await createRepo(t);
  await seedRoad(repo, road, { folder });
  return repo;
}

test('task new scaffolds tasks/<id>.md from the submitted fields and leaves the Road untouched', async (t) => {
  const repo = await repoWithRoad(t);
  const roadBytes = await repo.read('akrs/roads/P6/R-P6-1.json');
  const result = await submit(repo, taskInput());
  assert.equal(result.outcome, 'committed');
  const { packet } = result;
  assert.equal(packet.status, 'ok');
  assert.equal(packet.command, 'task-new');
  assert.match(packet.request_id, ULID);
  assert.deepEqual(packet.changed, ['tasks/T-P6-1.md']);
  assert.deepEqual(packet.data.task, {
    id: 'T-P6-1', plan: 'P6', road: 'R-P6-1', path: 'akrs/tasks/T-P6-1.md', meta_state: 'declared',
  });
  assert.equal(await repo.read('akrs/tasks/T-P6-1.md'), renderTaskScaffold(taskInput(), { roadPath: 'akrs/roads/P6/R-P6-1.json' }));
  assert.equal(await repo.read('akrs/roads/P6/R-P6-1.json'), roadBytes);
  assert.equal(validateMutationChanges(packet, ['tasks/T-P6-1.md']).ok, true);
  assert.deepEqual(await readTask({ ...repo.options, id: 'T-P6-1' }), {
    id: 'T-P6-1', plan: 'P6', road: 'R-P6-1', path: 'akrs/tasks/T-P6-1.md', meta_state: 'declared',
  });
});

test('the scaffold is generated only from submitted Task fields: no acceptance, writes, steps, checks, reads or boundaries of the Road', async (t) => {
  const sentinelRoad = roadInput({
    id: 'R-P6-1', plan: 'P6', task: 'T-P6-1',
    acceptance: ['ACCEPT-SENTINEL-71c2 the table lists every booking'],
    boundaries: ['BOUNDARY-SENTINEL-88aa no backend change'],
    steps: ['STEP-SENTINEL-19ef create the page'],
    writes: [{ path: 'app/pages/WRITE-SENTINEL-3d4b.vue', class: 'file', action: 'create' }],
    checks: [{ name: 'CHECK-SENTINEL-5a6c', argv: ['npm', 'run', 'CHECK-ARGV-SENTINEL-77b1'], timeout_ms: 1000 }],
    reads: [{ path: 'SOT/09-use-cases.md', lines: [28, 41], why: 'WHY-SENTINEL-2c9d' }],
  });
  const repo = await repoWithRoad(t, sentinelRoad);
  assert.equal((await submit(repo, taskInput())).outcome, 'committed');
  const text = await repo.read('akrs/tasks/T-P6-1.md');
  for (const sentinel of ['ACCEPT-SENTINEL', 'BOUNDARY-SENTINEL', 'STEP-SENTINEL', 'WRITE-SENTINEL', 'CHECK-SENTINEL', 'CHECK-ARGV-SENTINEL', 'WHY-SENTINEL', 'use-case line']) {
    assert.equal(text.includes(sentinel), false, sentinel);
  }
});

test('a Task document cannot carry executable fields: the closed schema refuses them with pointers', async (t) => {
  const repo = await repoWithRoad(t);
  const before = await strict(repo);
  for (const key of ['acceptance', 'writes', 'reads', 'steps', 'checks', 'deps', 'boundaries', 'forbidden', 'status', 'meta']) {
    const result = await submit(repo, { ...taskInput(), [key]: ['x'] });
    assert.equal(result.outcome, 'rejected', key);
    assert.equal(result.packet.data.kind, 'usage', key);
    assert.deepEqual(codesOf(result.packet), ['AKRS-R011'], key);
    assert.deepEqual(pointersOf(result.packet), [`/${key}`], key);
    assertFindingsMatchCatalog(result.packet);
  }
  const { objective: _objective, ...missing } = taskInput();
  const gone = await submit(repo, missing);
  assert.deepEqual(pointersOf(gone.packet), ['/objective']);
  assert.equal(await strict(repo), before);
});

test('an unfilled task template names the exact missing inputs', async (t) => {
  const repo = await repoWithRoad(t);
  const { buildTemplate } = await import('../../lib/schemas/templates.js');
  const result = await submit(repo, buildTemplate('task').skeleton);
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(result.packet.data.missing_inputs.map(({ pointer }) => pointer), ['/id', '/objective', '/road']);
});

// ---- binding to the Road ---------------------------------------------------------------------------------------
test('the Road must exist, declare this Task, and share its plan; every refusal writes nothing and has a stable reason', async (t) => {
  const missingRoad = await createRepo(t);
  const noTask = await repoWithRoad(t, roadInput({ id: 'R-P6-1', plan: 'P6', task: null }));
  const otherTask = await repoWithRoad(t, roadInput({ id: 'R-P6-1', plan: 'P6', task: 'T-other' }));
  const otherPlan = await repoWithRoad(t, roadInput({ id: 'R-P6-1', plan: 'P7', task: 'T-P6-1' }));
  const noPlan = await repoWithRoad(t, roadInput({ id: 'R-P6-1', plan: null, task: 'T-P6-1' }), 'roads');
  const cases = [
    [missingRoad, 'road_missing', '/road', 'R-P6-1', null, null],
    [noTask, 'road_declares_no_task', '/id', 'R-P6-1', null, 'T-P6-1'],
    [otherTask, 'task_id_mismatch', '/id', 'R-P6-1', 'T-other', 'T-P6-1'],
    [otherPlan, 'plan_mismatch', '/plan', 'R-P6-1', 'P7', 'P6'],
    [noPlan, 'plan_mismatch', '/plan', 'R-P6-1', null, 'P6'],
  ];
  for (const [repo, reason, pointer, subject, expected, actual] of cases) {
    const before = await everything(repo);
    const result = await submit(repo, taskInput());
    assert.equal(result.outcome, 'rejected', reason);
    assert.equal(result.packet.status, 'error');
    assert.equal(result.packet.data.kind, 'findings');
    assert.deepEqual(codesOf(result.packet), ['AKRS-R013'], reason);
    assert.deepEqual(result.packet.findings.map(({ detail }) => detail), [{ pointer, reason, subject, expected, actual }], reason);
    assert.match(result.packet.findings[0].message, new RegExp(`at ${pointer}`));
    assertFindingsMatchCatalog(result.packet);
    assert.equal(await everything(repo), before, reason);
  }
});

test('an existing Task file, in any case, is never overwritten', async (t) => {
  const repo = await repoWithRoad(t);
  await repo.write('akrs/tasks/t-p6-1.md', '# human wrote this\n');
  const before = await everything(repo);
  const result = await submit(repo, taskInput());
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(result.packet.findings.map(({ detail }) => [detail.reason, detail.actual]), [['task_exists', 'akrs/tasks/t-p6-1.md']]);
  assert.equal(await everything(repo), before);
  const exact = await repoWithRoad(t);
  assert.equal((await submit(exact, taskInput())).outcome, 'committed');
  const again = await submit(exact, taskInput({ objective: 'a different objective' }));
  assert.equal(again.outcome, 'rejected');
  assert.equal((await exact.read('akrs/tasks/T-P6-1.md')).includes('different objective'), false);
});

test('duplicate Road files and an unreadable Road are reported, not guessed around', async (t) => {
  const dup = await repoWithRoad(t);
  await seedRoad(dup, ROAD, { folder: 'roads/elsewhere' });
  const dupResult = await submit(dup, taskInput());
  assert.equal(dupResult.outcome, 'rejected');
  assert.deepEqual(codesOf(dupResult.packet), ['AKRS-R001']);
  assertFindingsMatchCatalog(dupResult.packet);

  const broken = await createRepo(t);
  await broken.write('akrs/roads/R-P6-1.json', '{ not json');
  const brokenResult = await submit(broken, taskInput());
  assert.equal(brokenResult.outcome, 'rejected');
  assert.deepEqual(brokenResult.packet.findings.map(({ detail }) => detail.reason), ['road_unreadable']);
  assertFindingsMatchCatalog(brokenResult.packet);
});

test('an unverified Road (hand edited) still binds a Task: the scaffold depends on identity only', async (t) => {
  const repo = await repoWithRoad(t);
  const path = repo.path('akrs/roads/P6/R-P6-1.json');
  const edited = (await readFile(path, 'utf8')).replace('The declared user path', 'A hand edited path');
  await repo.write('akrs/roads/P6/R-P6-1.json', edited);
  assert.equal((await readRoad({ ...repo.options, id: 'R-P6-1' })).meta_state, 'unverified');
  assert.equal((await submit(repo, taskInput())).outcome, 'committed');
});

// ---- drafts, replay, snapshots ----------------------------------------------------------------------------------
test('a draft is consumed on success and kept on failure, exactly like road new', async (t) => {
  const repo = await repoWithRoad(t);
  await draftDocument(repo, 'task-bad', taskInput({ road: 'R-ghost' }));
  const keptBytes = await repo.read('akrs/drafts/task-bad.json');
  const failed = await fromFile(repo, 'akrs/drafts/task-bad.json');
  assert.equal(failed.outcome, 'rejected');
  assert.equal(failed.packet.findings.every(({ file }) => file === 'akrs/drafts/task-bad.json'), true);
  assert.equal(await repo.read('akrs/drafts/task-bad.json'), keptBytes);
  assert.equal(failed.packet.next_commands.some(({ command, args }) => command === 'task-new'
    && args.join(' ') === '--input akrs/drafts/task-bad.json'), true);

  await draftDocument(repo, 'task-a', taskInput());
  const ok = await fromFile(repo, 'akrs/drafts/task-a.json');
  assert.equal(ok.outcome, 'committed');
  assert.deepEqual(ok.packet.changed, ['drafts/task-a.json', 'tasks/T-P6-1.md']);
  await assert.rejects(() => readFile(repo.path('akrs/drafts/task-a.json')), { code: 'ENOENT' });
});

test('retry of the same request is a noop, including after the draft was consumed; a different document with the same request ID is a conflict', async (t) => {
  const repo = await repoWithRoad(t);
  const providers = fakeProviders();
  await draftDocument(repo, 'task-a', taskInput());
  const first = await fromFile(repo, 'akrs/drafts/task-a.json', { providers });
  assert.equal(first.outcome, 'committed');
  const after = await everything(repo);
  const retry = await fromFile(repo, 'akrs/drafts/task-a.json', { providers });
  assert.equal(retry.outcome, 'replayed');
  assert.equal(retry.packet.status, 'noop');
  assert.equal(retry.packet.request_id, first.packet.request_id);
  assert.deepEqual(retry.packet.changed, []);
  assert.equal(validateReadOnlyPacket(retry.packet).ok, true);
  assert.equal(await everything(repo), after);
  const viaStdin = await submit(repo, taskInput(), { providers });
  assert.equal(viaStdin.outcome, 'replayed');
  assert.equal(await everything(repo), after);

  const conflict = await submit(repo, taskInput({ objective: 'something else' }), { providers, requestId: first.packet.request_id });
  assert.equal(conflict.outcome, 'conflict');
  assert.deepEqual(codesOf(conflict.packet), ['AKRS-C010']);
  assert.equal(await everything(repo), after);
});

test('a stale expected snapshot writes nothing', async (t) => {
  const repo = await repoWithRoad(t);
  const stale = (await commandSnapshot('task-new', { ...repo.options, target: { road: 'R-P6-1' } })).snapshot;
  await seedRoad(repo, { ...ROAD, acceptance: ['the Road changed after the snapshot was read'] }, { folder: 'roads/P6' });
  const before = await everything(repo);
  const blocked = await submit(repo, taskInput(), { expectedSnapshot: stale });
  assert.equal(blocked.outcome, 'stale');
  assert.equal(blocked.packet.status, 'blocked');
  assert.deepEqual(codesOf(blocked.packet), ['AKRS-C013']);
  assert.equal(await everything(repo), before);
});

test('--dry-run reports the scaffold it would write and touches nothing', async (t) => {
  const repo = await repoWithRoad(t);
  const before = await strict(repo);
  const result = await submit(repo, taskInput(), { dryRun: true });
  assert.equal(result.outcome, 'dry_run');
  assert.equal(result.packet.status, 'ok');
  assert.equal(result.packet.request_id, null);
  assert.deepEqual(result.packet.changed, []);
  assert.deepEqual(result.packet.data.would_change, ['tasks/T-P6-1.md']);
  assert.equal(result.packet.data.proposed, renderTaskScaffold(taskInput(), { roadPath: 'akrs/roads/P6/R-P6-1.json' }));
  assert.equal(await strict(repo), before);
});

// ---- Task prose cannot change Road execution data -----------------------------------------------------------------
test('editing the Task prose cannot change the Road or anything a Worker is leased on', async (t) => {
  const repo = await repoWithRoad(t);
  await repo.write('docs/placeholder.md', 'x\n');
  assert.equal((await submit(repo, taskInput())).outcome, 'committed');
  const roadBefore = await repo.read('akrs/roads/P6/R-P6-1.json');
  const roadRead = await readRoad({ ...repo.options, id: 'R-P6-1' });
  const lease = async () => (await computeSnapshot({ ...repo.options, projections: LEASE_CONTRACT_PROJECTION, target: { road: 'R-P6-1' } })).snapshot;
  const packet = async () => (await computeSnapshot({ ...repo.options, projections: ROAD_PACKET_PROJECTION, target: { road: 'R-P6-1' } })).snapshot;
  const [leaseBefore, packetBefore] = [await lease(), await packet()];

  const text = await repo.read('akrs/tasks/T-P6-1.md');
  await repo.write('akrs/tasks/T-P6-1.md', `${text}\n## Smuggled\n\nacceptance: delete everything\nwrites: /etc/passwd\nforbidden: none\nsteps: rm -rf /\nroad: R-other\ndeps: R-x\n`);
  assert.equal(await repo.read('akrs/roads/P6/R-P6-1.json'), roadBefore);
  assert.deepEqual(await readRoad({ ...repo.options, id: 'R-P6-1' }), roadRead);
  assert.equal(await lease(), leaseBefore, 'the contract projection a Worker lease guards does not read Task prose');
  assert.notEqual(await packet(), packetBefore, 'the Road packet projection does notice the Task file changed');

  await repo.write('akrs/tasks/T-P6-1.md', 'completely replaced prose\n');
  assert.deepEqual(await readRoad({ ...repo.options, id: 'R-P6-1' }), roadRead);
  assert.equal(await lease(), leaseBefore);
  const read = await readTask({ ...repo.options, id: 'T-P6-1' });
  assert.equal(read.meta_state, 'unverified');
  assert.deepEqual(Object.keys(read).sort(), ['id', 'meta_state', 'path', 'plan', 'road']);
  assert.equal(await repo.read('akrs/roads/P6/R-P6-1.json'), roadBefore);
});

test('arguments are checked: a channel is required', async (t) => {
  const repo = await repoWithRoad(t);
  await assert.rejects(() => createTask({ ...authoringOptions(repo) }), TypeError);
});

test('the concurrent creation of one Task: exactly one wins', async (t) => {
  const repo = await repoWithRoad(t);
  const [a, b] = await Promise.all([
    submit(repo, taskInput({ objective: 'variant A' })),
    submit(repo, taskInput({ objective: 'variant B' }), { providers: fakeProviders({ firstId: 7000 }) }),
  ]);
  assert.deepEqual([a.outcome, b.outcome].sort(), ['committed', 'rejected']);
});
