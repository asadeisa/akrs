// P2-W09: `status` composes the existing projections (Roads, Plans, Tester states, leases, scope, executors, closures); it never
// rebuilds state from prose and never writes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateStatus } from '../../lib/schemas/navigation.js';
import { treeDigest } from '../road/support.js';
import { claimRoad, closableWorld, finish, flat, navWorld, planOf, ranWorld, runCommand, runWorld, status, testRun, worldOptions, writePlan } from './support.js';

const ok = (out) => {
  assert.equal(out.exitCode, 0, out.text);
  assert.equal(validateStatus(out.packet.data).ok, true, JSON.stringify(validateStatus(out.packet.data).issues));
  return out.packet;
};

test('status counts the Roads by status, names the ready and blocked QUEUED ones and writes nothing', async (t) => {
  const repo = await navWorld(t);
  const digest = await treeDigest(repo);
  const packet = ok(await status(repo));
  assert.deepEqual([packet.command, packet.status, packet.data.kind, packet.data.packet_version], ['status', 'ok', 'status', 'akrs.status/v1']);
  assert.deepEqual(packet.data.roads.by_status, { ACTIVE: 1, DONE: 1, QUEUED: 2 });
  assert.equal(packet.data.roads.total, 4);
  assert.deepEqual([packet.data.roads.ready, packet.data.roads.blocked], [['R-P6-3'], ['R-P6-2']]);
  assert.deepEqual(await treeDigest(repo), digest, 'status is a query');
  assert.equal(packet.snapshot.before, packet.snapshot.after);
});

test('status exposes the executors by class, the active leases with their holder and state, and pending scope requests', async (t) => {
  const repo = await navWorld(t);
  assert.equal((await claimRoad(repo, 'R-P6-1', 'flash')).status, 'claimed');
  const packet = ok(await status(repo));
  assert.deepEqual(packet.data.executors.map(({ id, role, class: cls }) => [id, role, cls]), [['flash', 'worker', 'weak'], ['lead', 'leader', 'frontier'], ['mid', 'worker', 'medium'], ['top', 'worker', 'frontier']]);
  assert.deepEqual(packet.data.leases, [{ kind: 'road', target: 'R-P6-1', holder: 'flash', state: 'fresh' }]);
  assert.deepEqual(packet.data.scope, { pending: [], envelope_grants: 0 });
  await repo.write('src/own.js', 'changed after the lease\n');
  assert.equal(ok(await status(repo)).data.leases[0].state, 'fresh', 'a file the Road only writes is outside the lease contract');
  await repo.write('SOT/09-use-cases.md', `${'changed use-case line\n'.repeat(50)}`);
  assert.equal(ok(await status(repo)).data.leases[0].state, 'stale', 'a declared read that changed stales the lease');
});

test('status names the class-fit blockers and the Roads that need splitting', async (t) => {
  const repo = await navWorld(t);
  const packet = ok(await status(repo));
  assert.ok(Array.isArray(packet.data.roads.needs_split));
  assert.ok(Array.isArray(packet.data.roads.class_fit_blockers));
});

test('status exposes each Tester state of a Plan correctly: unverified, ready_for_test, testing, failed, passed, stale', async (t) => {
  const unverified = await navWorld(t);
  assert.equal(planOf(ok(await status(unverified))).tester.state, 'unverified');

  const ready = await runWorld(t, worldOptions());
  await writePlan(ready);
  assert.equal(planOf(ok(await status(ready))).tester.state, 'ready_for_test');

  const testing = await runWorld(t, worldOptions());
  await writePlan(testing);
  await testRun(testing);
  assert.equal(planOf(ok(await status(testing))).tester.state, 'testing');

  const failed = await ranWorld(t);
  await writePlan(failed);
  await flat(failed, 'fail', 'It broke.');
  const failedPlan = planOf(ok(await status(failed)));
  assert.deepEqual([failedPlan.tester.state, failedPlan.tester.latest.verdict, failedPlan.tester.latest.current], ['failed', 'fail', true]);

  const passed = await closableWorld(t);
  assert.equal(planOf(ok(await status(passed))).tester.state, 'passed');

  await passed.write('SOT/10-budgets.md', 'frame budget 8ms\n');
  const stale = planOf(ok(await status(passed)));
  assert.deepEqual([stale.tester.state, stale.tester.latest.current], ['stale', false]);
});

test('status reads the Plan closure first: a closed Plan stays passed and its closure is closed', async (t) => {
  const repo = await closableWorld(t);
  assert.deepEqual([planOf(ok(await status(repo))).closure, planOf(ok(await status(repo))).tester.state], ['open', 'passed']);
  const closed = await finish(repo);
  assert.equal(closed.exitCode, 0, closed.text);
  const plan = planOf(ok(await status(repo)));
  assert.deepEqual([plan.closure, plan.tester.state, plan.roads], ['closed', 'passed', { total: 2, done: 2 }]);
});

test('status reports the closure ledger and what did not verify, without hiding it', async (t) => {
  const repo = await closableWorld(t);
  await finish(repo);
  const packet = ok(await status(repo));
  assert.equal(packet.data.closures.total, 1);
  assert.deepEqual([packet.data.closures.last.kind, packet.data.closures.last.subject, packet.data.closures.last.outcome], ['plan', 'P6', 'DONE']);
  await repo.write('akrs/roads/P6/R-P6-1.json', '{"hand":"edited"}\n');
  const after = ok(await status(repo));
  assert.ok(after.data.roads.unverified >= 1, 'a hand-edited Road is counted as unverified, not dropped');
});

test('the output is sorted and stable: the same workflow gives byte-identical packets apart from the run identity', async (t) => {
  const repo = await navWorld(t);
  const strip = ({ packet }) => JSON.stringify({ ...packet, run_id: null, timestamp: null });
  assert.equal(strip(await status(repo)), strip(await status(repo)));
});

test('the prompt and human views are projections of the packet and state the next command', async (t) => {
  const repo = await navWorld(t);
  const json = (await status(repo)).packet;
  const prompt = await status(repo, ['--prompt']);
  const human = await runCommand(repo, ['status'], { providers: repo.providers });
  assert.equal(prompt.exitCode, 0, prompt.text);
  for (const needle of ['R-P6-3', 'R-P6-2', 'P6', 'flash']) assert.ok(prompt.stdout.includes(needle), `the prompt names ${needle}`);
  assert.ok(json.next_commands.some(({ command }) => command === 'next'));
  assert.match(human.stdout, /^AKRS status/m);
  assert.ok(human.stdout.includes('R-P6-3'));
});

test('an empty workflow gives a definitive empty packet from every navigation query', async (t) => {
  const { createRepo } = await import('../road/support.js');
  const { fakeProviders } = await import('../idempotency/support.js');
  const { validateGraph, validateLog, validateNext, validateStale, validateStatus, validateWhere } = await import('../../lib/schemas/navigation.js');
  const { query } = await import('./support.js');
  const repo = await createRepo(t);
  repo.providers = fakeProviders({ firstId: 7000 });
  const run = async (argv, validate) => {
    const out = await query(repo, argv);
    assert.equal(out.exitCode, 0, `${argv.join(' ')}: ${out.text}`);
    assert.equal(validate(out.packet.data).ok, true, JSON.stringify(validate(out.packet.data).issues));
    return out.packet.data;
  };
  const empty = await run(['status'], validateStatus);
  assert.deepEqual([empty.roads.total, empty.plans, empty.executors, empty.leases, empty.closures.total, empty.state], [0, [], [], [], 0, null]);
  assert.deepEqual((await run(['next'], validateNext)).empty, { reason: 'nothing_to_do' });
  assert.deepEqual((await run(['where', 'src/own.js'], validateWhere)).relations, { closures: [], readers: [], scope_requests: [], writers: [] });
  const graph = await run(['graph'], validateGraph);
  assert.deepEqual([graph.nodes, graph.edges], [[], []]);
  assert.equal((await run(['stale'], validateStale)).empty, true);
  assert.equal((await run(['log'], validateLog)).empty, true);
});
