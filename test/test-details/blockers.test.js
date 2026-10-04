// P2-W06: anything the Tester needs and the workflow does not have makes the packet `blocked` with named blockers; a
// partial ready packet is never returned. No-Plan Road mode, previous failures and the lease are read-only projections.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimLease } from '../../lib/store/leases/index.js';
import { LEASE_CONTRACT_PROJECTION, TESTER_LEASE_PROJECTION, computeSnapshot } from '../../lib/store/snapshots/index.js';
import { assertFindingsMatchCatalog } from '../road/support.js';
import { request, everything } from '../change/support.js';
import { fileWrite, setExec } from '../road-details/support.js';
import { validateTestDetails } from '../../lib/schemas/test-details.js';
import { blockerReasons, contractInput, define, details, handoff, seedResult, seedRoad, snapshotOf, testerWorld } from './support.js';

const codes = (packet) => [...new Set(packet.findings.map(({ code }) => code))].sort();

test('no contract: blocked with identity and the blocker only; an unknown key is a usage error', async (t) => {
  const none = await testerWorld(t);
  await none.write('akrs/verifications/P6/contract.json', '{"not":"a contract"}');
  const broken = await details(none);
  assert.equal(broken.packet.status, 'blocked');
  assert.equal(broken.packet.data.kind, 'test_details_blocked');
  assert.deepEqual(blockerReasons(broken.packet), ['contract_unverified']);
  assert.deepEqual(validateTestDetails(broken.packet.data).issues, []);
  assert.deepEqual(codes(broken.packet), ['AKRS-T003']);
  assertFindingsMatchCatalog(broken.packet);
  const unknown = await details(none, 'NOPE');
  assert.equal(unknown.exitCode, 2);
  assert.match(unknown.packet.findings[0].message, /no Plan or Road/);
});

test('a Plan with no contract yet is blocked as contract_missing and points at the template', async (t) => {
  const repo = await testerWorld(t, { handoffs: false });
  const { rm } = await import('node:fs/promises');
  await rm(repo.path('akrs/verifications/P6/contract.json'));
  const { packet } = await details(repo);
  assert.equal(packet.status, 'blocked');
  assert.deepEqual(blockerReasons(packet), ['contract_missing']);
  assert.deepEqual(packet.next_commands, [{ command: 'template', args: ['verification'] }]);
});

test('missing handoff, unresolved handoff, a Road that is not DONE and an unresolved read each block, and are all named at once', async (t) => {
  const repo = await testerWorld(t, { handoffs: false });
  await seedRoad(repo, { id: 'R-P6-2', plan: 'P6' }, { folder: 'roads/P6', status: 'ACTIVE' });
  await repo.write('SOT/10-budgets.md', 'x\n');
  const { rm } = await import('node:fs/promises');
  await rm(repo.path('SOT/10-budgets.md'));
  const { packet } = await details(repo);
  assert.equal(packet.status, 'blocked');
  assert.deepEqual(blockerReasons(packet).sort(), ['handoff_missing', 'handoff_missing', 'read_unresolved', 'road_not_done']);
  assert.deepEqual(packet.data.blockers.find(({ reason }) => reason === 'road_not_done'), { reason: 'road_not_done', subject: 'R-P6-2' });
  assert.deepEqual(validateTestDetails(packet.data).issues, []);
  assert.equal(packet.data.coverage.blockers, 4);
  assert.equal(packet.data.kind, 'test_details', 'the complete packet is still returned beside its blockers');
  assertFindingsMatchCatalog(packet);

  const resolved = await testerWorld(t);
  await seedRoad(resolved, { id: 'R-P6-1', plan: 'P6' }, { folder: 'roads/P6', status: 'ACTIVE' });
  await request(resolved, { road: 'R-P6-1', add_writes: [fileWrite('src/new.js')], reason: 'one more file' });
  await handoff(resolved, 'P6', { road: 'R-P6-1', result: 'Second attempt.', reach: ['Open /a'], expect: 'Same.' });
  await seedRoad(resolved, { id: 'R-P6-1', plan: 'P6' }, { folder: 'roads/P6', status: 'DONE' });
  const unresolved = (await details(resolved)).packet;
  assert.deepEqual(blockerReasons(unresolved), ['handoff_unresolved']);
  assert.equal(unresolved.status, 'blocked');
});

test('a contract without acceptance, or a Road that no longer verifies, blocks; policy none needs no Tester pass', async (t) => {
  const bare = await testerWorld(t, { contract: { acceptance: [] } });
  assert.deepEqual(blockerReasons((await details(bare)).packet), ['acceptance_missing']);
  const hand = await testerWorld(t);
  await hand.write('akrs/roads/P6/R-P6-1.json', '{"id":"R-P6-1"}');
  assert.ok(blockerReasons((await details(hand)).packet).includes('road_unverified'));
  const none = await testerWorld(t, { handoffs: false, contract: await contractInput('valid/policy-none', { plan: 'P6', roads: ['R-P6-1', 'R-P6-2'] }) });
  const { packet } = await details(none);
  assert.equal(packet.status, 'ok');
  assert.equal(packet.data.coverage.required, false);
  assert.deepEqual(packet.data.blockers, []);
});

test('no-Plan Road mode follows the same schema with the single Road as the key', async (t) => {
  const repo = await testerWorld(t);
  await seedRoad(repo, { id: 'R-ALONE', plan: null }, { folder: 'roads', status: 'DONE' });
  const base = await contractInput('valid/full', { plan: 'R-ALONE', roads: ['R-ALONE'], policy: 'checks', launch: null, measurements: [], scenario: [] });
  assert.equal((await define(repo, 'R-ALONE', base)).outcome, 'committed');
  await handoff(repo, 'R-ALONE', { road: 'R-ALONE', result: 'Reachable.', reach: ['Open /'], expect: 'Fine.' });
  const { packet } = await details(repo, 'R-ALONE');
  assert.equal(packet.data.mode, 'road');
  assert.deepEqual(packet.data.roads.map(({ id }) => id), ['R-ALONE']);
  assert.equal(packet.status, 'ok', JSON.stringify(packet.data.blockers));
  assert.deepEqual(validateTestDetails(packet.data).issues, []);
});

test('previous failed and blocked results are listed with whether they are current, and never as a pass', async (t) => {
  const repo = await testerWorld(t);
  const current = (await details(repo)).packet.data;
  await seedResult(repo, 'P6', { n: 1, tested_snapshot: `sha256:${'1'.repeat(64)}`, contract_hash: current.contract.hash, verdict: 'fail', findings: [{ id: 'F1', text: 'Save does nothing.', status: 'open' }, { id: 'F2', text: 'Fixed typo.', status: 'resolved' }] });
  await seedResult(repo, 'P6', { n: 2, tested_snapshot: current.tested_snapshot, contract_hash: current.contract.hash, verdict: 'blocked', findings: [] });
  await seedResult(repo, 'P6', { n: 3, tested_snapshot: current.tested_snapshot, contract_hash: current.contract.hash, verdict: 'pass', user_acceptance: { answer: 'yes', because: 'All good.' } });
  const after = (await details(repo)).packet.data;
  assert.deepEqual(validateTestDetails(after).issues, []);
  assert.deepEqual(after.previous_failures.map(({ verdict, current: isCurrent, counts_as_pass: pass, open_findings: open }) => [verdict, isCurrent, pass, open.length]), [['fail', false, false, 1], ['blocked', true, false, 0]],
    'the pass is not listed as a failure; the fail was recorded for another snapshot, the blocked one for this exact snapshot and contract');
  assert.equal(after.previous_failures[0].open_findings[0].text, 'Save does nothing.');
});

test('the Tester lease is read, never created: none, fresh and stale', async (t) => {
  const repo = await testerWorld(t);
  assert.deepEqual((await details(repo)).packet.data.lease, { holder: null, state: 'none' });
  const current = await computeSnapshot({ ...repo.options, projections: TESTER_LEASE_PROJECTION, target: { plan: 'P6' } });
  const claimed = await claimLease({ ...repo.options, providers: repo.providers, kind: 'plan', target: 'P6', holder: 'top', snapshot: current.snapshot, inventory: current.inventory });
  assert.equal(claimed.status, 'claimed');
  const before = await everything(repo);
  assert.deepEqual((await details(repo)).packet.data.lease, { holder: 'top', state: 'fresh' });
  assert.equal(await everything(repo), before);
  await repo.write('SOT/10-budgets.md', 'frame budget 12ms\n');
  assert.deepEqual((await details(repo)).packet.data.lease, { holder: 'top', state: 'stale' });
  assert.notEqual(LEASE_CONTRACT_PROJECTION, undefined);
});

test('a weak Tester class makes test run mandatory before test result; other classes carry no such note', async (t) => {
  const repo = await testerWorld(t);
  assert.deepEqual((await details(repo)).packet.data.tester, { holder: null, class: null, run_required: false });
  await setExec(repo, { id: 'qa', role: 'tester', class: 'weak', label: 'QA bot', user_answer: 'weak' });
  assert.deepEqual((await details(repo)).packet.data.tester, { holder: 'qa', class: 'weak', run_required: true });
  const strong = await testerWorld(t);
  await setExec(strong, { id: 'qa', role: 'tester', class: 'frontier', label: 'QA', user_answer: 'frontier' });
  assert.deepEqual((await details(strong)).packet.data.tester, { holder: 'qa', class: 'frontier', run_required: false });
});

test('a workflow that changes while the packet is read is blocked as changed_during_query', async (t) => {
  const repo = await testerWorld(t);
  const { buildTesterPacket } = await import('../../lib/store/test-details/index.js');
  const result = await buildTesterPacket({ ...repo.options, key: 'P6', hooks: { afterRead: () => repo.write('SOT/10-budgets.md', 'moved under the reader\n') } });
  assert.equal(result.status, 'blocked');
  assert.ok(result.data.blockers.some(({ reason }) => reason === 'changed_during_query'));
  assert.notEqual(result.data.tested_snapshot, await snapshotOf(repo), 'the pinned snapshot is the one the read began with');
});
