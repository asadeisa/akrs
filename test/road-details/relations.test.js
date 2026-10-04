// P2-W02: the relation projections of the Worker and Leader packets: collisions, conventions, recent closures, reuse
// candidates, and the Leader-only audit and stale views. All of them are derived from the canonical readers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closure } from '../log/support.js';
import { claimLease } from '../../lib/store/leases/index.js';
import { LEASE_CONTRACT_PROJECTION, computeSnapshot } from '../../lib/store/snapshots/index.js';
import { memoryRow, seedMemory } from '../memory/support.js';
import { request } from '../change/support.js';
import { assertFindingsMatchCatalog } from '../road/support.js';
import { details, fileWrite, packetWorld, readEntry, seedRoad, seedWithTask } from './support.js';

const writer = (id, writes, extra = {}) => ({ id, plan: 'P6', task: null, deps: [], reads: [], writes, forbidden: [], ...extra });
const readerOf = (id, reads) => writer(id, [fileWrite(`out/${id}.js`)], { reads });

async function crowdedWorld(t) {
  const world = await packetWorld(t);
  const { repo } = world;
  await seedRoad(repo, writer('R-P6-2', [fileWrite('src/admin.js', 'modify')]), { folder: 'roads/P6', status: 'ACTIVE' });
  await seedRoad(repo, readerOf('R-P6-3', [readEntry('src/admin.js', null, 'depends on the page')]), { folder: 'roads/P6', status: 'QUEUED' });
  await seedRoad(repo, writer('R-P6-4', [fileWrite('SOT/09-use-cases.md', 'modify')]), { folder: 'roads/P6', status: 'QUEUED' });
  await seedRoad(repo, writer('R-P6-9', [fileWrite('unrelated/zzz.js')]), { folder: 'roads/P6', status: 'ACTIVE' });
  await seedRoad(repo, writer('R-P6-8', [fileWrite('src/admin.js', 'modify')]), { folder: 'roads/P6', status: 'DONE' });
  return world;
}

test('collisions name write/write and write/read pairs with an exact overlap state, and skip finished or unrelated Roads', async (t) => {
  const { repo } = await crowdedWorld(t);
  const { packet } = await details(repo, 'R-P6-1');
  const collisions = packet.data.collisions;
  assert.deepEqual(collisions.map(({ road, kind }) => [road, kind]), [
    ['R-P6-2', 'write_write'], ['R-P6-3', 'my_write_their_read'], ['R-P6-4', 'their_write_my_read'],
  ]);
  assert.deepEqual(collisions[0], { road: 'R-P6-2', road_status: 'ACTIVE', kind: 'write_write', state: 'overlap', mine: 'src/admin.js', theirs: 'src/admin.js' });
  assert.equal(collisions.every(({ state }) => state === 'overlap'), true);
  assert.equal(JSON.stringify(packet.data).includes('R-P6-9'), false, 'an unrelated Road never reaches the Worker packet');
  assert.equal(JSON.stringify(packet.data).includes('R-P6-8'), false, 'a finished Road does not collide');
  assertFindingsMatchCatalog(packet);
});

test('a path whose case fold is not one-to-one is unknown_potential, never disjoint', async (t) => {
  const { repo } = await packetWorld(t);
  await seedRoad(repo, writer('R-P6-2', [fileWrite('src/straße.js')]), { folder: 'roads/P6', status: 'ACTIVE' });
  const { packet } = await details(repo, 'R-P6-1');
  assert.deepEqual([...new Set(packet.data.collisions.map(({ road, state }) => `${road}:${state}`))], ['R-P6-2:unknown_potential']);
  assert.equal(packet.data.collisions.length > 0 && packet.data.collisions.every(({ state }) => state !== 'disjoint'), true);
});

test('recent closures are only those of the dependencies and colliding Roads, newest first, never the whole ledger', async (t) => {
  const { repo } = await crowdedWorld(t);
  await closure(repo, { subject: 'R-P5-6', outcome: 'DONE', deviations: 'used the adapter' });
  await closure(repo, { subject: 'R-P6-8', outcome: 'DONE' });
  await closure(repo, { subject: 'R-P6-9', outcome: 'DONE' });
  await closure(repo, { subject: 'R-P6-2', outcome: 'BLOCKED', deviations: 'waiting' });
  const { packet } = await details(repo, 'R-P6-1');
  assert.deepEqual(packet.data.recent.map(({ subject, outcome }) => [subject, outcome]), [['R-P6-2', 'BLOCKED'], ['R-P5-6', 'DONE']]);
  assert.deepEqual(packet.data.recent[1], { id: packet.data.recent[1].id, ts: packet.data.recent[1].ts, kind: 'road', subject: 'R-P5-6', outcome: 'DONE', deviations: 'used the adapter', relation: 'dependency' });
  assert.equal(packet.data.recent[0].relation, 'collision');
});

test('conventions are the Decided Memory facts that point at a path the Road reads or writes', async (t) => {
  const { repo } = await packetWorld(t);
  await seedMemory(repo, 'payments', [
    memoryRow({ id: '01ARZ3NDEKTSV4RRFFQ69G5FA1', label: 'Decided', decided_by: 'P5', text: 'Paid state comes from the settlement event.', pointers: [{ path: 'SOT/09-use-cases.md', lines: [30, 31] }] }),
    memoryRow({ id: '01ARZ3NDEKTSV4RRFFQ69G5FA2', label: 'Decided', decided_by: 'P5', text: 'Unrelated rule.', pointers: [{ path: 'SOT/99-other.md', lines: null }] }),
    memoryRow({ id: '01ARZ3NDEKTSV4RRFFQ69G5FA3', label: 'Assumption High', text: 'An assumption is not a convention.', pointers: [{ path: 'SOT/09-use-cases.md', lines: [30, 31] }] }),
  ]);
  const { packet } = await details(repo, 'R-P6-1');
  assert.deepEqual(packet.data.conventions.map(({ id, topic, label }) => [id, topic, label]), [['01ARZ3NDEKTSV4RRFFQ69G5FA1', 'payments', 'Decided']]);
  assert.equal(packet.data.conventions[0].text, 'Paid state comes from the settlement event.');
});

test('the Worker packet carries no pending request of another Road, and the Leader sees every pending request on its own Road', async (t) => {
  const { repo } = await crowdedWorld(t);
  await request(repo, { road: 'R-P6-1', add_writes: [fileWrite('src/new.js')], reason: 'first' });
  await request(repo, { road: 'R-P6-1', add_reads: [readEntry('SOT/02-rules.md')], reason: 'second', blocking: false });
  await request(repo, { road: 'R-P6-2', add_writes: [fileWrite('src/other.js')], reason: 'not mine' });
  const worker = (await details(repo, 'R-P6-1')).packet.data;
  const leader = (await details(repo, 'R-P6-1', ['--role', 'leader'])).packet.data;
  assert.deepEqual(worker.scope_requests.map(({ reason }) => reason), ['first', 'second']);
  assert.deepEqual(leader.scope_requests.map(({ reason }) => reason), ['first', 'second']);
  assert.equal(JSON.stringify(worker).includes('not mine'), false);
});

test('the Leader packet adds the audit summary and the stale list; the Worker packet has neither', async (t) => {
  const { repo } = await crowdedWorld(t);
  const worker = (await details(repo, 'R-P6-1')).packet.data;
  const leader = (await details(repo, 'R-P6-1', ['--role', 'leader'])).packet.data;
  assert.equal('audit' in worker, false);
  assert.equal('stale' in worker, false);
  assert.deepEqual(Object.keys(leader.audit).sort(), ['counts', 'posture', 'reason', 'status']);
  assert.ok(['clean', 'findings', 'skipped'].includes(leader.audit.status));
  assert.deepEqual(leader.stale, []);
  assert.deepEqual(leader.collisions, worker.collisions, 'both roles see the same collisions');
  assert.equal(leader.readiness.blockers.some(({ reason }) => reason === 'dependency_not_done') || leader.readiness.ready, true);
});

test('a stale lease is listed as a stale packet in the Leader view', async (t) => {
  const { repo } = await packetWorld(t);
  const current = await computeSnapshot({ ...repo.options, projections: LEASE_CONTRACT_PROJECTION, target: { road: 'R-P6-1' } });
  await claimLease({ ...repo.options, providers: repo.providers, kind: 'road', target: 'R-P6-1', holder: 'flash', snapshot: current.snapshot, inventory: current.inventory });
  assert.deepEqual((await details(repo, 'R-P6-1', ['--role', 'leader'])).packet.data.stale, []);
  await seedWithTask(repo, { acceptance: ['Changed by the Leader.'] }, { status: 'ACTIVE' });
  const leader = (await details(repo, 'R-P6-1', ['--role', 'leader'])).packet.data;
  assert.deepEqual(leader.stale, [{ kind: 'road_lease', road: 'R-P6-1', holder: 'flash' }]);
});

test('reuse candidates are opt-in, labelled by source and never claim the same behaviour', async (t) => {
  const { repo } = await packetWorld(t);
  await repo.write('lib/helpers/admin.js', 'export const admin = 1;\n');
  await repo.write('node_modules/pkg/admin.js', 'ignored\n');
  const off = (await details(repo, 'R-P6-1')).packet.data;
  assert.deepEqual(off.reuse, []);
  const on = (await details(repo, 'R-P6-1', ['--reuse'])).packet.data;
  assert.deepEqual(on.reuse, [{ source: 'filename_match', kind: 'candidate', for_write: 'src/admin.js', path: 'lib/helpers/admin.js', label: 'same file name only; behaviour is not compared' }]);
  const leader = (await details(repo, 'R-P6-1', ['--role', 'leader', '--reuse'])).packet.data;
  assert.deepEqual(leader.reuse, on.reuse);
  assert.equal(/equivalent|same behaviou?r as|duplicate of/i.test(JSON.stringify(on.reuse)), false);
});

test('--full only expands declared detail: same keys, same permissions, and the budget still refuses', async (t) => {
  const { repo } = await crowdedWorld(t);
  const plain = (await details(repo, 'R-P6-1', ['--role', 'leader'])).packet.data;
  const full = (await details(repo, 'R-P6-1', ['--role', 'leader', '--full'])).packet.data;
  assert.deepEqual(Object.keys(full).sort(), Object.keys(plain).sort());
  assert.deepEqual(full.writes, plain.writes);
  assert.deepEqual(full.collisions, plain.collisions);
  const refused = await details(repo, 'R-P6-1', ['--role', 'leader', '--full', '--max-tokens', '5']);
  assert.equal(refused.packet.data.kind, 'road_details_refused');
  assert.equal(refused.packet.status, 'blocked');
});
