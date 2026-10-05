// P2-W12 `yield`: the Worker's one-call exit. It releases the lease, records a yield in the Road's scope ledger so the Road `needs_split` until
// the Leader changes it, and raises a question for the Leader; it never waits on a stale lease.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateYield, validateYieldBlocked } from '../../lib/schemas/intents.js';
import { readScope, openYield } from '../../lib/store/scope/index.js';
import { assertFindingsMatchCatalog } from '../road/support.js';
import { snapshotOf, update, updateForm } from '../change/support.js';
import { ROAD, codesOf, edit, everything, guardFileOf, intent, leaseOf, put, statusOf, strict, work, workWorld, yieldRoad } from './support.js';

test('yield releases the lease, records the yield and leaves the Road ACTIVE but needing a split', async (t) => {
  const { repo } = await workWorld(t);
  assert.equal((await work(repo)).packet.status, 'ok');
  await edit(repo);
  const result = await yieldRoad(repo);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  const { packet } = result;
  assert.equal(packet.status, 'ok');
  assert.equal(validateYield(packet.data).ok, true, JSON.stringify(validateYield(packet.data).issues));
  assert.deepEqual([packet.data.road, packet.data.holder, packet.data.reason, packet.data.needs_split, packet.data.lease], [ROAD, 'flash', 'it needs the payment module as well', true, { holder: 'flash', released: true }]);
  assert.equal(packet.data.question_for_leader.kind, 'yielded_road');
  assert.equal(await leaseOf(repo), null);
  assert.equal(await guardFileOf(repo), null);
  assert.equal(await statusOf(repo), 'ACTIVE', 'a yield is a readiness flag, not a lifecycle change');
  const scope = await readScope({ ...repo.options, road: ROAD });
  assert.equal(scope.problem, null);
  const record = scope.records.find(({ value }) => value.type === 'yield').value;
  assert.deepEqual([record.holder, record.reason, record.id], ['flash', 'it needs the payment module as well', packet.data.yielded.id]);
  assert.equal(record.hash, packet.data.yielded.hash);
  assert.equal(scope.requests.length, 0, 'a yield is not a scope request');
  assert.deepEqual(packet.next_commands.map(({ command }) => command), ['work']);
  assertFindingsMatchCatalog(packet);
});

test('a yielded Road needs_split in every view and is never worked until the Leader changes it', async (t) => {
  const { repo } = await workWorld(t);
  assert.equal((await work(repo)).packet.status, 'ok');
  assert.equal((await yieldRoad(repo)).packet.status, 'ok');
  const leader = await intent(repo, ['road-details', ROAD, '--role', 'leader']);
  assert.equal(leader.packet.data.needs_split, true);
  const status = await intent(repo, ['status']);
  assert.deepEqual(status.packet.data.roads.needs_split, [ROAD]);
  const named = await work(repo, [ROAD]);
  assert.deepEqual([named.packet.status, named.packet.data.reason, named.packet.data.subject], ['blocked', 'needs_split', 'flash']);
  assert.match(named.packet.findings[0].message, /yielded by flash/);
  const auto = await work(repo);
  assert.deepEqual(auto.packet.data.candidates, [{ road: ROAD, reason: 'needs_split', subject: 'flash' }]);
  assert.equal(await leaseOf(repo), null);
});

test('the Leader\'s change of the Road answers the yield: the Road can be worked again', async (t) => {
  const { repo } = await workWorld(t);
  assert.equal((await work(repo)).packet.status, 'ok');
  assert.equal((await yieldRoad(repo)).packet.status, 'ok');
  const document = await updateForm(repo, ROAD, { boundaries: ['No backend route change.', 'Only the admin page: the payment module is another Road.'] }, 'roads/P6');
  const changed = await update(repo, ROAD, document, { expectedSnapshot: await snapshotOf(repo, 'road-update', ROAD) });
  assert.equal(changed.outcome, 'committed', JSON.stringify(changed.packet.findings));
  const scope = await readScope({ ...repo.options, road: ROAD });
  assert.equal(openYield(scope.records, 'sha256:' + '0'.repeat(64)), null);
  assert.equal((await intent(repo, ['road-details', ROAD, '--role', 'leader'])).packet.data.needs_split, false);
  const again = await work(repo);
  assert.equal(again.packet.status, 'ok', again.stdout);
  assert.equal(again.packet.data.claim.action, 'claimed');
});

test('yield is the escape hatch: a stale lease does not stop it', async (t) => {
  const { repo } = await workWorld(t);
  assert.equal((await work(repo)).packet.status, 'ok');
  await put(repo, 'SOT/09-use-cases.md', `${Array.from({ length: 50 }, (_, index) => `changed line ${index + 1}`).join('\n')}\n`);
  const result = await yieldRoad(repo);
  assert.equal(result.packet.status, 'ok', result.stdout);
  assert.equal(await leaseOf(repo), null);
});

test('yield refuses without a lease, with another holder\'s lease and for a Road that is not ACTIVE, writing nothing', async (t) => {
  const { repo } = await workWorld(t);
  const before = await strict(repo);
  const none = await yieldRoad(repo);
  assert.deepEqual([none.exitCode, none.packet.status, none.packet.data.reason], [1, 'blocked', 'lease_missing']);
  assert.equal(validateYieldBlocked(none.packet.data).ok, true, JSON.stringify(validateYieldBlocked(none.packet.data).issues));
  assert.equal(await strict(repo), before);
  assert.equal((await work(repo)).packet.status, 'ok');
  const other = await intent(repo, ['yield', ROAD, '--executor', 'flash2', '--reason', 'not mine']);
  assert.deepEqual([other.packet.data.reason, other.packet.data.holder, codesOf(other.packet)], ['lease_held', 'flash', ['AKRS-C012']]);
  assert.equal((await leaseOf(repo)).holder, 'flash');
  const unknown = await intent(repo, ['yield', 'R-NOPE', '--executor', 'flash', '--reason', 'x']);
  assert.equal(unknown.exitCode, 2);
  assertFindingsMatchCatalog(other.packet);
});

test('yield needs its reason: a missing flag and a blank one are usage errors that name it', async (t) => {
  const { repo } = await workWorld(t);
  assert.equal((await work(repo)).packet.status, 'ok');
  const missing = await intent(repo, ['yield', ROAD, '--executor', 'flash']);
  assert.equal(missing.exitCode, 2);
  const blank = await intent(repo, ['yield', ROAD, '--executor', 'flash', '--reason', '']);
  assert.equal(blank.exitCode, 2);
  assert.deepEqual(blank.packet.data.missing_inputs, ['--reason']);
  assert.equal((await leaseOf(repo)).holder, 'flash');
});

test('a yield dry run writes nothing and names the ledger it would append to', async (t) => {
  const { repo } = await workWorld(t);
  assert.equal((await work(repo)).packet.status, 'ok');
  const before = await strict(repo);
  const result = await yieldRoad(repo, ['--dry-run']);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.equal(result.packet.data.dry_run, true);
  assert.deepEqual(result.packet.data.would_change, ['scope/R-P6-1.jsonl']);
  assert.equal(validateYield(result.packet.data).ok, true, JSON.stringify(validateYield(result.packet.data).issues));
  assert.equal(await strict(repo), before);
  assert.equal((await leaseOf(repo)).holder, 'flash');
});

test('a second yield of the same Road has nothing to release and adds no record', async (t) => {
  const { repo } = await workWorld(t);
  assert.equal((await work(repo)).packet.status, 'ok');
  assert.equal((await yieldRoad(repo)).packet.status, 'ok');
  const again = await yieldRoad(repo);
  assert.equal(again.packet.data.reason, 'lease_missing', 'the lease is gone: there is nothing left to yield');
  assert.equal((await readScope({ ...repo.options, road: ROAD })).records.filter(({ value }) => value.type === 'yield').length, 1);
  assert.ok(await everything(repo));
});
