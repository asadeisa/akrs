// P2-W12: what lives and dies with a Road lease. The guard allowlist and the failed-done counter are CLI scratch under .ops/leases: the Leader's
// release, a reopen, a finish and a yield all remove them with the lease; a yield record in the scope ledger is verified like every other record.
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { readScope } from '../../lib/store/scope/index.js';
import { transition } from '../road-lifecycle/support.js';
import { FAILING, ROAD, done, edit, guardFileOf, intent, leaseOf, runCommand, work, workWorld, yieldRoad } from './support.js';

const leaseDirectory = async (repo) => (await readdir(repo.path('akrs/.ops/leases'))).sort();
const sidecars = async (repo) => (await leaseDirectory(repo)).filter((name) => name.startsWith(ROAD));

test('work leaves the lease and its allowlist side by side, in the places the lease policy fixed', async (t) => {
  const { repo } = await workWorld(t);
  assert.equal((await work(repo)).packet.status, 'ok');
  assert.deepEqual(await leaseDirectory(repo), ['R-P6-1.done.json', 'R-P6-1.guard.json', 'road']);
  assert.deepEqual(await readdir(repo.path('akrs/.ops/leases/road')), ['R-P6-1.lease.json']);
  assert.equal((await guardFileOf(repo)).road, ROAD);
});

test('the Leader\'s lease release removes the allowlist and the done counter with the lease', async (t) => {
  const { repo } = await workWorld(t, { checks: [FAILING] });
  assert.equal((await work(repo)).packet.status, 'ok');
  await edit(repo);
  assert.equal((await done(repo)).packet.data.attempts.failures, 1);
  assert.deepEqual(await sidecars(repo), ['R-P6-1.done.json', 'R-P6-1.guard.json']);
  const released = await runCommand(repo, ['lease', 'release', ROAD, '--json'], { providers: repo.providers });
  assert.equal(JSON.parse(released.stdout).data.released, true);
  assert.equal(await leaseOf(repo), null);
  assert.deepEqual(await sidecars(repo), []);
  // the guard follows the lease at once: the next write is no longer judged against a Road nobody holds
  assert.equal((await intent(repo, ['guard', 'src/other.js', '--executor', 'flash'])).packet.data.decision, 'allow');
});

test('a reopen and a yield also end the allowlist; a finish ends it with the closure', async (t) => {
  const { repo } = await workWorld(t);
  assert.equal((await work(repo)).packet.status, 'ok');
  const reopened = await transition(repo, 'reopen');
  assert.equal(reopened.packet.status, 'ok', reopened.stdout);
  assert.deepEqual(await sidecars(repo), []);
  assert.equal(await guardFileOf(repo), null);
  const second = await workWorld(t);
  assert.equal((await work(second.repo)).packet.status, 'ok');
  assert.equal((await yieldRoad(second.repo)).packet.status, 'ok');
  assert.deepEqual(await sidecars(second.repo), []);
});

test('a failed-done counter of a released lease never carries over to the next claim', async (t) => {
  const { repo } = await workWorld(t, { checks: [FAILING] });
  assert.equal((await work(repo)).packet.status, 'ok');
  await edit(repo);
  assert.equal((await done(repo)).packet.data.attempts.failures, 1);
  assert.equal((await done(repo)).packet.data.attempts.failures, 2);
  await runCommand(repo, ['lease', 'release', ROAD, '--json'], { providers: repo.providers });
  assert.equal((await work(repo)).packet.status, 'ok');
  assert.equal((await done(repo)).packet.data.attempts.failures, 1);
});

test('the yield record is verified like every ledger record: an edited one is not trusted and holds nothing', async (t) => {
  const { repo } = await workWorld(t);
  assert.equal((await work(repo)).packet.status, 'ok');
  assert.equal((await yieldRoad(repo)).packet.status, 'ok');
  assert.equal((await readScope({ ...repo.options, road: ROAD })).problem, null);
  assert.equal((await intent(repo, ['road-details', ROAD, '--role', 'leader'])).packet.data.needs_split, true);
  const text = await repo.read('akrs/scope/R-P6-1.jsonl');
  await writeFile(repo.path('akrs/scope/R-P6-1.jsonl'), text.replace('it needs the payment module as well', 'nothing at all'));
  const scope = await readScope({ ...repo.options, road: ROAD });
  assert.deepEqual(scope.records.map(({ value, state }) => [value.type, state]), [['yield', 'unverified']]);
  assert.equal((await intent(repo, ['road-details', ROAD, '--role', 'leader'])).packet.data.needs_split, false, 'an unverified yield holds nothing');
});
