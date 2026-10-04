// P2-W05: the closed data schemas accept exactly what the lifecycle commands return, and nothing else.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateLeaseRelease, validateRoadCheck, validateRoadLifecycle } from '../../lib/schemas/lifecycle.js';
import { LEASE_CONTRACT_PROJECTION, computeSnapshot } from '../../lib/store/snapshots/index.js';
import { claimLease } from '../../lib/store/leases/index.js';
import { runCommand } from '../road/support.js';
import { lifecycle, lifecycleWorld, transition } from './support.js';

const codes = (verdict) => verdict.issues.map(({ code }) => code);

test('the real packets conform: check, dry run, activate, finish, reopen and lease release', async (t) => {
  const { repo } = await lifecycleWorld(t, { status: 'QUEUED' });
  for (const [name, packet] of [
    ['check', (await lifecycle(repo, 'check', ['R-P6-1'])).packet],
    ['dry', (await lifecycle(repo, 'activate', ['R-P6-1', '--dry-run'])).packet],
    ['activate', (await transition(repo, 'activate')).packet],
  ]) {
    const verdict = name === 'check' ? validateRoadCheck(packet.data) : validateRoadLifecycle(packet.data);
    assert.deepEqual(verdict.issues, [], name);
  }
  const current = await computeSnapshot({ ...repo.options, projections: LEASE_CONTRACT_PROJECTION, target: { road: 'R-P6-1' } });
  await claimLease({ ...repo.options, providers: repo.providers, kind: 'road', target: 'R-P6-1', holder: 'flash', snapshot: current.snapshot, inventory: current.inventory });
  assert.deepEqual(validateRoadLifecycle((await transition(repo, 'finish')).packet.data).issues, []);
  assert.deepEqual(validateRoadLifecycle((await transition(repo, 'reopen')).packet.data).issues, []);
  const released = await runCommand(repo, ['lease', 'release', 'R-P6-1', '--dry-run', '--json'], { providers: repo.providers });
  const parsed = JSON.parse(released.stdout);
  assert.deepEqual(validateLeaseRelease(parsed.data).issues, []);
});

test('unknown keys, a bad status and inconsistent shapes are refused', async (t) => {
  const { repo } = await lifecycleWorld(t, { status: 'QUEUED' });
  const check = (await lifecycle(repo, 'check', ['R-P6-1'])).packet.data;
  assert.deepEqual(codes(validateRoadCheck({ ...check, extra: 1 })), ['unknown_key']);
  assert.equal(validateRoadCheck({ ...check, road: { ...check.road, status: 'BLOCKED' } }).ok, false);
  assert.equal(validateRoadCheck({ ...check, readiness: { ready: true, blockers: [{ reason: 'x', subject: null }] } }).ok, false);
  const done = (await lifecycle(repo, 'activate', ['R-P6-1', '--dry-run'])).packet.data;
  assert.deepEqual(codes(validateRoadLifecycle({ ...done, closure: { action: 'appended', id: null, segment: null } })), ['invalid_value']);
  assert.equal(validateRoadLifecycle({ ...done, readiness: null }).ok, false);
  assert.equal(validateRoadLifecycle({ ...done, transition: 'close' }).ok, false);
  assert.equal(validateLeaseRelease({ kind: 'lease_release', dry_run: false, road: 'R-1', released: true }).ok, false);
});
