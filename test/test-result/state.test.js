// P2-W07: the reusable current-result projection (unverified, ready_for_test, testing, failed, passed, stale) that status,
// next and plan finish build on. A pass is never carried forward: a relevant change exposes it as stale on its own.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { deriveTesterState, readTesterState } from '../../lib/store/test-result/projection.js';
import { treeDigest } from '../road/support.js';
import { details, flat, full, ranWorld, redefine, runWorld, testRun, worldOptions } from './support.js';

const stateOf = async (repo) => readTesterState({ ...repo.options, key: 'P6' });

test('a Plan without a verified contract is unverified; a ready packet without a run is ready_for_test', async (t) => {
  const repo = await runWorld(t, worldOptions());
  assert.equal((await stateOf(repo)).state, 'ready_for_test');
  await writeFile(repo.path('akrs/verifications/P6/contract.json'), '{}\n');
  assert.equal((await stateOf(repo)).state, 'unverified');
});

test('a held fresh Tester lease means testing; a pass makes the Plan passed; a fail makes it failed', async (t) => {
  const repo = await runWorld(t, worldOptions());
  await testRun(repo);
  assert.equal((await stateOf(repo)).state, 'testing');
  await flat(repo, 'pass');
  const passed = await stateOf(repo);
  assert.deepEqual([passed.state, passed.latest.verdict, passed.latest.current], ['passed', 'pass', true]);
  await flat(repo, 'fail', 'It broke after all.');
  assert.deepEqual([(await stateOf(repo)).state, (await stateOf(repo)).latest.verdict], ['failed', 'fail']);
});

test('a later product, workflow or SOT change exposes the pass as stale automatically, and the CLI never carries it forward', async (t) => {
  const repo = await ranWorld(t);
  await flat(repo, 'pass');
  assert.equal((await stateOf(repo)).state, 'passed');
  await repo.write('SOT/10-budgets.md', 'frame budget 8ms\n');
  const stale = await stateOf(repo);
  assert.deepEqual([stale.state, stale.latest.current], ['stale', false]);
  assert.equal(stale.latest.verdict, 'pass', 'the old result is still reported as what it was');
  const packet = (await details(repo)).packet;
  assert.equal(packet.data.result.state, 'stale');
});

test('a changed contract stales the pass; a stale fail is simply ready for a new test', async (t) => {
  const repo = await ranWorld(t);
  await flat(repo, 'pass');
  await redefine(repo, { acceptance: ['The flow is reachable end to end.', 'One more line.'] });
  assert.equal((await stateOf(repo)).state, 'stale');
  const other = await ranWorld(t);
  await flat(other, 'fail', 'Broken.');
  assert.equal((await stateOf(other)).state, 'failed');
  await other.write('SOT/10-budgets.md', 'frame budget 9ms\n');
  assert.equal((await stateOf(other)).state, 'ready_for_test');
});

test('unrelated changes do not stale a pass: a file no Road declares, no read names and no snapshot projection measures', async (t) => {
  const repo = await ranWorld(t);
  await flat(repo, 'pass');
  await repo.write('SOT/unrelated-notes.md', 'nothing the Plan depends on\n');
  await repo.write('akrs/.cache/scratch.txt', 'a disposable cache\n');
  assert.equal((await stateOf(repo)).state, 'passed');
});

test('writing the result, running again and reading the packet never change the pass they judge', async (t) => {
  const repo = await ranWorld(t);
  await flat(repo, 'pass');
  const digest = await treeDigest(repo, { exclude: ['akrs/.ops'] });
  await details(repo);
  await stateOf(repo);
  assert.deepEqual(await treeDigest(repo, { exclude: ['akrs/.ops'] }), digest, 'reading writes nothing');
  assert.equal((await stateOf(repo)).state, 'passed');
});

test('deriveTesterState is pure: the same facts give the same answer and policy none is not_required', () => {
  const base = { contract: { policy: 'live' }, hash: 'sha256:h', snapshot: 'sha256:s', results: [], runs: [], lease: { state: 'none' }, blocked: false };
  assert.deepEqual(deriveTesterState(base), { state: 'ready_for_test', required: true, latest: null });
  assert.equal(deriveTesterState({ ...base, contract: { policy: 'none' } }).state, 'not_required');
  assert.equal(deriveTesterState({ ...base, blocked: true }).state, 'unverified');
  assert.equal(deriveTesterState({ ...base, contract: null }).state, 'unverified');
  const record = (verdict, snapshot = 'sha256:s', hash = 'sha256:h') => ({ id: '01ARZ3NDEKTSV4RRFFQ6000001', ts: 't', verdict, tested_snapshot: snapshot, contract_hash: hash });
  assert.equal(deriveTesterState({ ...base, results: [record('pass')] }).state, 'passed');
  assert.equal(deriveTesterState({ ...base, results: [record('pass', 'sha256:other')] }).state, 'stale');
  assert.equal(deriveTesterState({ ...base, results: [record('pass', 'sha256:s', 'sha256:other')] }).state, 'stale');
  assert.equal(deriveTesterState({ ...base, results: [record('fail')] }).state, 'failed');
  assert.equal(deriveTesterState({ ...base, results: [record('blocked')] }).state, 'failed');
  assert.equal(deriveTesterState({ ...base, results: [record('pass'), record('fail')] }).state, 'failed', 'the latest result decides');
  assert.equal(deriveTesterState({ ...base, results: [record('fail'), record('pass')] }).state, 'passed');
  assert.equal(deriveTesterState({ ...base, lease: { state: 'fresh' } }).state, 'testing');
  assert.equal(deriveTesterState({ ...base, runs: [{ current: true }] }).state, 'testing');
  assert.equal(deriveTesterState({ ...base, results: [record('pass', 'sha256:other')], lease: { state: 'fresh' } }).state, 'stale', 'a stale pass is shown even while a new test is under way');
});
