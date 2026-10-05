// P2-W12 `work`: claim a lease on the next ACTIVE ready Road of the executor's class (or the named Road), write the guard allowlist and return
// the class-shaped Worker packet. It never activates a Road, repeating it is a noop claim, another holder is named and --takeover is explicit.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validateWork, validateWorkBlocked } from '../../lib/schemas/intents.js';
import { buildRoadDetails } from '../../lib/store/road-details/index.js';
import { assertFindingsMatchCatalog } from '../road/support.js';
import { setExec } from '../road-fit/support.js';
import { ROAD, addRoad, codesOf, everything, guardFileOf, intent, leaseOf, put, statusOf, strict, work, workWorld } from './support.js';

test('work claims the Road, writes the allowlist and returns the Worker packet, and nothing in the workflow changes but the lease', async (t) => {
  const { repo } = await workWorld(t);
  const before = await everything(repo);
  const result = await work(repo);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  const { packet } = result;
  assert.equal(packet.status, 'ok');
  assert.equal(validateWork(packet.data).ok, true, JSON.stringify(validateWork(packet.data).issues));
  assert.deepEqual([packet.data.executor, packet.data.road, packet.data.claim], [{ id: 'flash', class: 'weak', source: 'flag' }, ROAD, { action: 'claimed', previous_holder: null }]);
  assert.deepEqual(packet.data.done, { requires: ['--result', '--reach', '--expect'], failures_before_yield: 2 });
  assert.equal(packet.snapshot.before, packet.snapshot.after);
  const lease = await leaseOf(repo);
  assert.deepEqual([lease.holder, lease.snapshot], ['flash', packet.snapshot.after]);
  // the embedded packet is the one road-details gives this Worker: class-shaped (a weak Road inlines its windows) and fresh
  const { details } = packet.data;
  assert.deepEqual([details.kind, details.role, details.road.id, details.lease], ['road_details', 'worker', ROAD, { holder: 'flash', caller: 'flash', state: 'fresh' }]);
  assert.equal(details.delivery.reads, 'inlined');
  assert.ok(details.reads.every((read) => typeof read.text === 'string'));
  const direct = await buildRoadDetails({ ...repo.options, id: ROAD, role: 'worker', holder: 'flash' });
  assert.deepEqual(details, direct.data);
  assert.equal(await everything(repo), before, 'no workflow artifact was written (only .ops)');
  assert.deepEqual(packet.next_commands.map(({ command }) => command), ['verify']);
  assertFindingsMatchCatalog(packet);
});

test('the guard allowlist is the declared writes and forbidden of the Road, under .ops/leases', async (t) => {
  const { repo } = await workWorld(t);
  const { packet } = await work(repo);
  assert.deepEqual(packet.data.guard, { path: '.ops/leases/R-P6-1.guard.json', writes: 2, forbidden: 1 });
  assert.deepEqual(await guardFileOf(repo), {
    schema: 'akrs.guard/v1', road: ROAD, holder: 'flash', workflow: 'akrs',
    writes: [{ path: 'src/admin.js', class: 'file' }, { path: 'src/own.js', class: 'file' }], forbidden: ['server/**'],
  });
});

test('work resolves the holder: --executor, then AKRS_EXECUTOR, then the only Worker; otherwise it lists the choices', async (t) => {
  const { repo } = await workWorld(t);
  const none = await intent(repo, ['work']);
  assert.equal(none.exitCode, 1);
  assert.equal(none.packet.status, 'blocked');
  assert.deepEqual([none.packet.data.reason, none.packet.data.choices], ['holder_unresolved', ['flash', 'flash2', 'mid', 'top']]);
  assert.deepEqual(none.packet.next_commands.map(({ command, args }) => [command, args[1]]), [['work', 'flash'], ['work', 'flash2'], ['work', 'mid'], ['work', 'top']]);
  assert.deepEqual(codesOf(none.packet), ['AKRS-R026']);
  assert.equal(await leaseOf(repo), null);
  const unknown = await intent(repo, ['work', '--executor', 'ghost']);
  assert.deepEqual([unknown.packet.data.reason, unknown.packet.data.subject], ['holder_unresolved', 'ghost']);
  const wrongRole = await intent(repo, ['work', '--executor', 'lead']);
  assert.equal(wrongRole.packet.data.reason, 'holder_unresolved', 'the Leader is not a Worker');

  const previous = process.env.AKRS_EXECUTOR;
  process.env.AKRS_EXECUTOR = 'flash';
  try {
    const viaEnv = await intent(repo, ['work']);
    assert.equal(viaEnv.packet.status, 'ok', viaEnv.stdout);
    assert.equal(viaEnv.packet.data.executor.source, 'env');
  } finally {
    if (previous === undefined) delete process.env.AKRS_EXECUTOR;
    else process.env.AKRS_EXECUTOR = previous;
  }
});

test('with exactly one Worker executor it is the holder without any flag', async (t) => {
  const { repo } = await workWorld(t, { second: false });
  for (const id of ['mid', 'top']) {
    const removed = await intent(repo, ['executor', 'remove', id]);
    assert.equal(removed.exitCode, 0, removed.stdout);
  }
  const result = await intent(repo, ['work']);
  assert.equal(result.packet.status, 'ok', result.stdout);
  assert.deepEqual([result.packet.data.executor.id, result.packet.data.executor.source], ['flash', 'only_executor_of_role']);
});

test('work never activates a Road: a QUEUED Road is refused and nothing is claimed', async (t) => {
  const { repo } = await workWorld(t, { status: 'QUEUED' });
  const before = await strict(repo);
  const result = await work(repo, [ROAD]);
  assert.equal(result.exitCode, 1);
  assert.deepEqual([result.packet.status, result.packet.data.reason, result.packet.data.subject], ['blocked', 'not_active', 'QUEUED']);
  assert.equal(await statusOf(repo), 'QUEUED');
  assert.equal(await leaseOf(repo), null);
  assert.equal(await strict(repo), before);
  const auto = await work(repo);
  assert.equal(auto.packet.data.reason, 'no_ready_road', 'with no Road named and none ACTIVE nothing is chosen');
});

test('repeating work is a noop claim that still returns the packet; the holder\'s own edits do not stale the lease', async (t) => {
  const { repo } = await workWorld(t);
  const first = await work(repo);
  const lease = await leaseOf(repo);
  await put(repo, 'src/own.js', 'edited inside the declared writes\n');
  await put(repo, 'src/admin.js', 'new\n');
  const again = await work(repo);
  assert.equal(again.exitCode, 0);
  assert.equal(again.packet.status, 'noop');
  assert.deepEqual(again.packet.data.claim, { action: 'unchanged', previous_holder: null });
  assert.equal(again.packet.data.details.lease.state, 'fresh');
  assert.deepEqual(await leaseOf(repo), lease, 'the lease did not move');
  assert.equal(again.packet.snapshot.after, first.packet.snapshot.after);
});

test('a changed contract refreshes the same holder\'s lease to the new projection', async (t) => {
  const { repo } = await workWorld(t);
  const first = await work(repo);
  await put(repo, 'SOT/09-use-cases.md', `${Array.from({ length: 50 }, (_, index) => `changed line ${index + 1}`).join('\n')}\n`);
  const stale = await intent(repo, ['road-details', ROAD, '--role', 'worker']);
  assert.equal(stale.packet.data.lease.state, 'unknown', 'a plain query without a resolved holder cannot say');
  const again = await work(repo);
  assert.equal(again.packet.status, 'ok');
  assert.equal(again.packet.data.claim.action, 'refreshed');
  assert.notEqual(again.packet.snapshot.after, first.packet.snapshot.after);
  assert.equal((await leaseOf(repo)).snapshot, again.packet.snapshot.after);
  assert.equal(again.packet.data.details.lease.state, 'fresh');
});

test('another holder is blocked with the holder named; --takeover replaces it explicitly and the guard follows', async (t) => {
  const { repo } = await workWorld(t);
  assert.equal((await work(repo)).packet.status, 'ok');
  const blocked = await intent(repo, ['work', ROAD, '--executor', 'flash2']);
  assert.equal(blocked.exitCode, 1);
  assert.deepEqual([blocked.packet.status, blocked.packet.data.reason, blocked.packet.data.holder], ['blocked', 'lease_held', 'flash']);
  assert.deepEqual(codesOf(blocked.packet), ['AKRS-C012']);
  assert.equal(blocked.packet.findings[0].detail.requested_by, 'flash2');
  assert.equal((await leaseOf(repo)).holder, 'flash');
  const taken = await intent(repo, ['work', ROAD, '--executor', 'flash2', '--takeover']);
  assert.equal(taken.packet.status, 'ok');
  assert.deepEqual(taken.packet.data.claim, { action: 'taken_over', previous_holder: 'flash' });
  assert.equal((await leaseOf(repo)).holder, 'flash2');
  assert.equal((await guardFileOf(repo)).holder, 'flash2');
  assertFindingsMatchCatalog(blocked.packet);
});

test('with no Road named, work takes the next free ACTIVE Road of its class: its own first, then Road ID order', async (t) => {
  const { repo } = await workWorld(t);
  await addRoad(repo, 'R-P6-2');
  await addRoad(repo, 'R-P6-3');
  const first = await work(repo);
  assert.equal(first.packet.data.road, ROAD);
  const second = await intent(repo, ['work', '--executor', 'flash2']);
  assert.equal(second.packet.data.road, 'R-P6-2', 'a held Road is skipped');
  const again = await work(repo);
  assert.equal(again.packet.data.road, ROAD, 'the holder resumes its own Road first');
  assert.equal(again.packet.data.claim.action, 'unchanged');
});

test('nothing ready is an explicit blocked packet that says why, Road by Road', async (t) => {
  const { repo } = await workWorld(t);
  assert.equal((await work(repo)).packet.status, 'ok');
  const result = await intent(repo, ['work', '--executor', 'flash2']);
  assert.equal(result.exitCode, 1);
  assert.equal(result.packet.status, 'blocked');
  assert.deepEqual(result.packet.data.candidates, [{ road: ROAD, reason: 'lease_held', subject: 'flash' }]);
  assert.equal(result.packet.data.reason, 'no_ready_road');
  assert.equal(validateWorkBlocked(result.packet.data).ok, true, JSON.stringify(validateWorkBlocked(result.packet.data).issues));
  assert.deepEqual(result.packet.next_commands.map(({ command }) => command), ['next']);
  assertFindingsMatchCatalog(result.packet);
});

test('a Road of another class is refused as class_mismatch when named, and never chosen when not', async (t) => {
  const { repo } = await workWorld(t);
  const named = await intent(repo, ['work', ROAD, '--executor', 'mid']);
  assert.deepEqual([named.packet.status, named.packet.data.reason, named.packet.data.subject], ['blocked', 'class_mismatch', 'weak']);
  const auto = await intent(repo, ['work', '--executor', 'mid']);
  assert.equal(auto.packet.data.reason, 'no_ready_road');
  assert.equal(await leaseOf(repo), null);
});

test('a Road whose Worker packet is blocked is not claimed: the blockers and their findings come back', async (t) => {
  const { repo } = await workWorld(t);
  await writeFile(repo.path('SOT/09-use-cases.md'), '');
  const gone = await work(repo, [ROAD]);
  assert.equal(gone.packet.status, 'blocked');
  assert.equal(gone.packet.data.reason, 'details_blocked');
  assert.ok(gone.packet.data.blockers.some(({ reason }) => reason === 'read_unresolved'));
  assert.ok(codesOf(gone.packet).includes('AKRS-R020'));
  assert.equal(await leaseOf(repo), null);
  assert.equal(await guardFileOf(repo), null);
});

test('an unknown Road is a usage error and a malformed ID is rejected', async (t) => {
  const { repo } = await workWorld(t);
  const missing = await work(repo, ['R-NOPE']);
  assert.equal(missing.exitCode, 2);
  const malformed = await work(repo, ['not an id']);
  assert.equal(malformed.exitCode, 2);
});

test('an unusable executors.json refuses with its path, and a Leader-only registry has no Worker to hold a lease', async (t) => {
  const { repo } = await workWorld(t);
  const text = await repo.read('akrs/executors.json');
  await writeFile(repo.path('akrs/executors.json'), text.replace('"user_answer": "weak"', '"user_answer": "weak!"'));
  const broken = await work(repo);
  assert.deepEqual([broken.packet.status, broken.packet.data.reason], ['blocked', 'executors_unusable']);
  await writeFile(repo.path('akrs/executors.json'), text);
  for (const id of ['flash', 'flash2', 'mid', 'top']) assert.equal((await intent(repo, ['executor', 'remove', id])).exitCode, 0);
  const none = await intent(repo, ['work']);
  assert.deepEqual([none.packet.data.reason, none.packet.data.choices], ['holder_unresolved', []]);
  assert.match(none.packet.findings[0].message, /No Worker executor is declared/);
  assert.ok(setExec);
});
