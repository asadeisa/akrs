// P2-W06: the complete Plan-level Tester packet: every field named by the plan, pinned to one snapshot, read-only, with
// the Tester's permissions spelled out and nothing copied from the sources.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateTestDetails } from '../../lib/schemas/test-details.js';
import { assertFindingsMatchCatalog } from '../road/support.js';
import { everything } from '../change/support.js';
import { details, snapshotOf, testerWorld } from './support.js';

test('a complete Plan packet names every part of the Tester contract, pinned to the snapshot of the command row', async (t) => {
  const repo = await testerWorld(t);
  const before = await everything(repo);
  const { exitCode, packet } = await details(repo);
  assert.equal(exitCode, 0, packet?.findings?.map(({ message }) => message).join('; '));
  assert.equal(packet.status, 'ok');
  assert.deepEqual(validateTestDetails(packet.data).issues, []);
  const { data } = packet;
  assert.deepEqual([data.kind, data.plan, data.mode, data.policy], ['test_details', 'P6', 'plan', 'measured']);
  assert.equal(data.tested_snapshot, await snapshotOf(repo));
  assert.equal(packet.snapshot.before, data.tested_snapshot);
  assert.equal(packet.snapshot.after, data.tested_snapshot);
  assert.match(data.contract.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(data.contract.meta_state, 'declared');
  assert.deepEqual(data.roads.map(({ id, status, contract }) => [id, status, contract]), [['R-P6-1', 'DONE', 'declared'], ['R-P6-2', 'DONE', 'declared']]);
  assert.deepEqual(data.reads.map(({ index, path, status }) => [index, path, status]), [[0, 'SOT/09-use-cases.md', 'ok'], [1, 'SOT/10-budgets.md', 'ok']], 'reads keep the Leader order');
  assert.deepEqual(data.acceptance, ['The admin flow is reachable end to end.', 'The user can save without errors.']);
  assert.deepEqual(data.launch.argv, ['npm', 'run', 'dev']);
  assert.equal(data.launch.url, 'http://localhost:3000');
  assert.deepEqual(data.setup.map(({ name }) => name), ['install', 'seed']);
  assert.deepEqual(data.teardown.map(({ name }) => name), ['stop', 'clean']);
  assert.deepEqual(data.measurements.map(({ name, unit, budget, direction }) => [name, unit, budget, direction]), [['frame_time', 'ms', 16, 'max'], ['fps', 'fps', 30, 'min']]);
  assert.deepEqual(data.evidence_slots.map(({ type }) => type), ['a11y', 'console', 'screenshot', 'timing']);
  assert.ok(data.evidence_slots.every(({ directory, filled }) => directory === 'verifications/P6/evidence' && filled === false));
  assert.deepEqual(data.handoffs.map(({ road, ready }) => [road, ready]), [['R-P6-1', true], ['R-P6-2', true]]);
  assert.deepEqual(data.handoffs[0].reach, ['Open /R-P6-1', 'Click Save']);
  assert.deepEqual(data.checks.map(({ road, name, last_result: last }) => [road, name, last]), [['R-P6-1', 'unit', null], ['R-P6-2', 'unit', null]]);
  assert.deepEqual(data.reachability, ['Every Performance bullet is reachable at runtime.', 'LEVEL_WON has a subscriber.']);
  assert.deepEqual(data.previous_failures, []);
  assert.deepEqual(data.runs, [], 'the run slot stays empty until the run records exist (P2-W14)');
  assert.equal(data.timeout_ms, 600000);
  assert.deepEqual(data.coverage.blockers, 0);
  assert.deepEqual(data.blockers, []);
  assert.equal(await everything(repo), before, 'test-details writes nothing: no lease, no cache, no journal');
  assertFindingsMatchCatalog(packet);
});

test('the pinned diff is exactly the declared product writes of the Plan with the hashes of the snapshot projection', async (t) => {
  const repo = await testerWorld(t);
  await repo.write('app/pages/admin.vue', '<template>admin</template>\n');
  const { packet } = await details(repo);
  const { diff } = packet.data;
  assert.equal(diff.pinned_to, packet.data.tested_snapshot);
  assert.deepEqual(diff.files.map(({ path }) => path), ['app/pages/admin.vue']);
  assert.match(diff.files[0].sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(packet.data).includes('<template>admin</template>'), false, 'no source body is copied');
  await repo.write('app/pages/admin.vue', '<template>changed</template>\n');
  const next = (await details(repo)).packet.data;
  assert.notEqual(next.tested_snapshot, packet.data.tested_snapshot, 'a change to a diffed product file moves the snapshot');
  assert.notEqual(next.diff.files[0].sha256, diff.files[0].sha256);
});

test('the Tester has no product-code write permission; only evidence and the result are named, and the boundary leads', async (t) => {
  const repo = await testerWorld(t);
  const { data } = (await details(repo)).packet;
  assert.deepEqual(data.permissions, {
    product_code_write: false,
    may_write: [{ what: 'evidence', where: 'verifications/P6/evidence' }, { what: 'result', where: 'akrs test result P6' }],
  });
  assert.deepEqual(data.boundaries, ['Never edit product code.', 'Never change the launch command.']);
  const bare = await testerWorld(t, { contract: { boundaries: [] } });
  assert.deepEqual((await details(bare)).packet.data.boundaries, ['Never edit product code.']);
});

test('the Tester source files are unchanged by repeated reads and the packet is deterministic', async (t) => {
  const repo = await testerWorld(t);
  const first = await details(repo);
  const second = await details(repo);
  const strip = ({ run_id: _run, timestamp: _ts, ...rest }) => rest;
  assert.deepEqual(strip(second.packet), strip(first.packet));
});

test('the closed schema refuses unknown keys, a product write permission, a pass listed as a failure and a wrong blocker count', async (t) => {
  const repo = await testerWorld(t);
  const { data } = (await details(repo)).packet;
  const codes = (value) => validateTestDetails(value).issues.map(({ code }) => code);
  assert.deepEqual(codes({ ...data, verdict: 'pass' }), ['unknown_key']);
  assert.equal(validateTestDetails({ ...data, permissions: { ...data.permissions, product_code_write: true } }).ok, false);
  assert.equal(validateTestDetails({ ...data, coverage: { ...data.coverage, blockers: 3 } }).ok, false);
  assert.equal(validateTestDetails({ ...data, previous_failures: [{ id: 'x', ts: 't', verdict: 'pass', tested_snapshot: data.tested_snapshot, contract_hash: data.contract.hash, current: true, counts_as_pass: true, open_findings: [] }] }).ok, false);
  assert.equal(validateTestDetails({ ...data, blockers: [{ reason: 'ready_enough', subject: null }] }).ok, false);
  assert.equal(validateTestDetails({ kind: 'test_details_blocked', packet_version: data.packet_version, plan: 'P6', mode: 'plan', blockers: [] }).ok, true);
});
