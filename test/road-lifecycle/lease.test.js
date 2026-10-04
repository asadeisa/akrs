// P2-W05 / A1: `lease release <road>` is the Leader's way to free a Road lease; finish and reopen release it themselves.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimLease, readLease } from '../../lib/store/leases/index.js';
import { LEASE_CONTRACT_PROJECTION, computeSnapshot } from '../../lib/store/snapshots/index.js';
import { assertFindingsMatchCatalog, runCommand } from '../road/support.js';
import { everything } from '../change/support.js';
import { lifecycleWorld } from './support.js';

const release = async (repo, args = ['R-P6-1']) => {
  const result = await runCommand(repo, ['lease', 'release', ...args, '--json'], { providers: repo.providers });
  return { exitCode: result.exitCode, stderr: result.stderr, packet: result.stdout === '' ? null : JSON.parse(result.stdout) };
};
async function claim(repo, holder = 'flash') {
  const current = await computeSnapshot({ ...repo.options, projections: LEASE_CONTRACT_PROJECTION, target: { road: 'R-P6-1' } });
  return claimLease({ ...repo.options, providers: repo.providers, kind: 'road', target: 'R-P6-1', holder, snapshot: current.snapshot, inventory: current.inventory });
}
const held = async (repo) => (await readLease({ ...repo.options, kind: 'road', target: 'R-P6-1' })).status === 'held';

test('the Leader releases a held Road lease; the journal records it and a repeat is a noop', async (t) => {
  const { repo } = await lifecycleWorld(t, { status: 'ACTIVE' });
  assert.equal((await claim(repo)).status, 'claimed');
  const result = await release(repo);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.packet.status, 'ok');
  assert.deepEqual([result.packet.data.kind, result.packet.data.road, result.packet.data.previous_holder, result.packet.data.released], ['lease_release', 'R-P6-1', 'flash', true]);
  assert.equal(await held(repo), false);
  const again = await release(repo);
  assert.equal(again.packet.status, 'noop');
  assert.equal(again.packet.data.released, false);
  assertFindingsMatchCatalog(result.packet);
});

test('a lease release dry run changes nothing, and releasing a Road that does not exist is a usage error', async (t) => {
  const { repo } = await lifecycleWorld(t, { status: 'ACTIVE' });
  await claim(repo);
  const before = await everything(repo);
  const dry = await release(repo, ['R-P6-1', '--dry-run']);
  assert.equal(dry.packet.data.dry_run, true);
  assert.equal(dry.packet.data.previous_holder, 'flash');
  assert.equal(await everything(repo), before);
  assert.equal(await held(repo), true);
  const missing = await release(repo, ['R-NOPE']);
  assert.equal(missing.exitCode, 2);
});
