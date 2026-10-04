// P2-W07: every gate of `test result`. Each refusal names its reason (AKRS-T006), is blocked (a precondition that is not met),
// and writes nothing.
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { treeDigest } from '../road/support.js';
import { setExecutorFor } from '../test-details/support.js';
import { HTTP_SCENARIO } from '../scenario/support.js';
import { RESULTS, acceptance, flat, full, ledger, ranWorld, reasonsOf, redefine, result, runWorld, testRun, worldOptions } from './support.js';

const refused = async (repo, produce, reasons) => {
  const digest = await treeDigest(repo);
  const out = await produce();
  assert.equal(out.packet.status, 'blocked', out.text);
  assert.equal(out.exitCode, 1);
  for (const reason of reasons) assert.ok(reasonsOf(out.packet).includes(reason), `${reason} in ${JSON.stringify(reasonsOf(out.packet))}`);
  assert.deepEqual(await treeDigest(repo), digest, 'nothing was written');
  return out;
};
const evidenceOf = (repo) => ({ path: repo.run.path.replace(/run\.json$/, 'app.log'), type: 'log' });
const passing = (repo, extra = {}) => ({
  verdict: 'pass', checks: [{ name: 'unit', passed: true, exit_code: 0 }], measurements: [], evidence: [evidenceOf(repo)], findings: [], user_acceptance: acceptance('yes'), ...extra,
});
const failing = (extra = {}) => ({ verdict: 'fail', checks: [], measurements: [], evidence: [], findings: [{ id: 'F1', text: 'Save does nothing.', status: 'open' }], user_acceptance: acceptance('no'), ...extra });

test('a full pass that names every declared check, evidence type and acceptance is recorded', async (t) => {
  const repo = await ranWorld(t);
  const out = await full(repo, passing(repo));
  assert.equal(out.exitCode, 0, out.text);
  const [record] = await ledger(repo);
  assert.deepEqual(record.checks, [{ name: 'unit', passed: true, exit_code: 0 }]);
  assert.equal(record.evidence[0].path, evidenceOf(repo).path);
  assert.match(record.evidence[0].sha256, /^sha256:[0-9a-f]{64}$/, 'the CLI measures the evidence');
});

// ---- the run --------------------------------------------------------------------------------------------------------
test('a pass without any run of a contract that has a scenario is refused; a fail without a run is a legal Tester report', async (t) => {
  const repo = await runWorld(t, worldOptions());
  await refused(repo, () => flat(repo, 'pass'), ['run_missing']);
  const done = await flat(repo, 'fail', 'The product would not start for me.');
  assert.equal(done.exitCode, 0, done.text);
  assert.equal((await ledger(repo))[0].run, null);
});

test('a pass is refused when the referenced run has a failed hard expectation, and the failed run stays referenced by a fail', async (t) => {
  const repo = await runWorld(t, worldOptions({
    scenario: [{ ...HTTP_SCENARIO(0)[1], url: '/health', expect_status: 418 }],
  }));
  const run = await testRun(repo);
  assert.equal(run.packet.data.run.status, 'failed', run.text);
  repo.run = run.packet.data.run;
  await refused(repo, () => flat(repo, 'pass'), ['run_failed']);
  await refused(repo, () => full(repo, passing(repo)), ['run_failed']);
  const done = await flat(repo, 'fail', 'The health check does not answer 418.');
  assert.equal(done.exitCode, 0, done.text);
  assert.equal((await ledger(repo))[0].run, run.packet.data.run.id);
});

test('a pass is refused when the run could not run in full', async (t) => {
  const repo = await runWorld(t, worldOptions({
    launch: { argv: [process.execPath, '-e', 'process.exit(3)'], url: 'http://127.0.0.1:9', ready: { url: 'http://127.0.0.1:9/health', status: 200, timeout_ms: 1000 } },
  }));
  const run = await testRun(repo);
  assert.equal(run.packet.data.run.status, 'blocked', run.text);
  repo.run = run.packet.data.run;
  await refused(repo, () => flat(repo, 'pass'), ['run_blocked']);
});

test('a run of another snapshot cannot support a pass: a changed contract or a changed declared read makes it stale, and nothing is written', async (t) => {
  const repo = await ranWorld(t);
  await repo.write('SOT/10-budgets.md', 'frame budget 8ms\n');
  await refused(repo, () => flat(repo, 'pass'), ['run_stale']);
  const again = await ranWorld(t);
  await redefine(again, { acceptance: ['The flow is reachable end to end.', 'A new acceptance line.'] });
  await refused(again, () => flat(again, 'pass'), ['run_stale']);
});

test('a lease that is gone cannot support a pass; a Plan changed since the lease makes it stale', async (t) => {
  const repo = await ranWorld(t);
  await rm(repo.path('akrs/.ops/leases/plan/P6.lease.json'));
  await refused(repo, () => flat(repo, 'pass'), ['lease_missing']);
  const stale = await ranWorld(t);
  await stale.write('SOT/10-budgets.md', 'frame budget 4ms\n');
  await refused(stale, () => flat(stale, 'pass'), ['lease_stale']);
});

test('a weak Tester must run the scenario before any result, a stronger one may report a failure without a run', async (t) => {
  const repo = await runWorld(t, worldOptions());
  await setExecutorFor(repo, 'weak');
  await refused(repo, () => flat(repo, 'fail', 'It looked broken.'), ['run_required']);
  const run = await testRun(repo);
  assert.equal(run.packet.data.run.status, 'passed', run.text);
  const done = await flat(repo, 'fail', 'It looked broken.');
  assert.equal(done.exitCode, 0, done.text);
});

test('a Tester packet that is blocked cannot take a pass', async (t) => {
  const repo = await ranWorld(t);
  await redefine(repo, { acceptance: [] });
  await refused(repo, () => flat(repo, 'pass'), ['packet_blocked']);
});

// ---- checks ---------------------------------------------------------------------------------------------------------
test('a reported check must be declared by a Road of the Plan and passed for a pass; checks are optional', async (t) => {
  const repo = await ranWorld(t);
  await refused(repo, () => full(repo, passing(repo, { checks: [{ name: 'unit', passed: true, exit_code: 0 }, { name: 'made-up', passed: true, exit_code: 0 }] })), ['check_undeclared']);
  const none = await full(repo, passing(repo, { checks: [] }));
  assert.equal(none.exitCode, 0, none.text);
  await refused(repo, () => full(repo, passing(repo, { checks: [{ name: 'unit', passed: false, exit_code: 1 }] })), ['check_failed']);
  const fail = await full(repo, failing({ checks: [{ name: 'unit', passed: false, exit_code: 1 }] }));
  assert.equal(fail.exitCode, 0, 'a failed check is a legal fail result');
});

// ---- measurements ---------------------------------------------------------------------------------------------------
const measured = (extra = {}) => worldOptions({ policy: 'measured', measurements: [{ name: 'frame_time', unit: 'ms', budget: 16, direction: 'max' }], ...extra });
const measuredWorld = async (t) => {
  const repo = await runWorld(t, measured());
  const run = await testRun(repo);
  assert.equal(run.packet.data.run.status, 'passed', run.text);
  repo.run = run.packet.data.run;
  return repo;
};
const sample = (value, extra = {}) => ({ name: 'frame_time', value, unit: 'ms', within_budget: value <= 16, ...extra });

test('a measured pass needs every declared measurement, in its declared unit, within budget as the CLI computes it', async (t) => {
  const repo = await measuredWorld(t);
  await refused(repo, () => full(repo, passing(repo, { measurements: [] })), ['measurement_missing']);
  await refused(repo, () => full(repo, passing(repo, { measurements: [sample(12), sample(5, { name: 'made_up' })] })), ['measurement_undeclared']);
  await refused(repo, () => full(repo, passing(repo, { measurements: [sample(12, { unit: 's' })] })), ['measurement_inconsistent']);
  await refused(repo, () => full(repo, passing(repo, { measurements: [sample(20, { within_budget: true })] })), ['measurement_inconsistent']);
  await refused(repo, () => full(repo, passing(repo, { measurements: [sample(20)] })), ['measurement_over_budget']);
  const ok = await full(repo, passing(repo, { measurements: [sample(12)] }));
  assert.equal(ok.exitCode, 0, ok.text);
});

test('an over-budget measurement is a legal fail result; a min budget is judged the other way', async (t) => {
  const repo = await measuredWorld(t);
  const done = await full(repo, failing({ measurements: [sample(20)] }));
  assert.equal(done.exitCode, 0, done.text);
  const low = await runWorld(t, measured({ measurements: [{ name: 'fps', unit: 'fps', budget: 30, direction: 'min' }] }));
  const run = await testRun(low);
  low.run = run.packet.data.run;
  await refused(low, () => full(low, passing(low, { measurements: [{ name: 'fps', value: 20, unit: 'fps', within_budget: false }] })), ['measurement_over_budget']);
  const ok = await full(low, passing(low, { measurements: [{ name: 'fps', value: 60, unit: 'fps', within_budget: true }] }));
  assert.equal(ok.exitCode, 0, ok.text);
});

// ---- evidence -------------------------------------------------------------------------------------------------------
test('evidence must be of a declared type and name an existing file; a pass needs every declared type', async (t) => {
  const repo = await ranWorld(t);
  await refused(repo, () => full(repo, passing(repo, { evidence: [{ ...evidenceOf(repo), type: 'screenshot' }] })), ['evidence_undeclared']);
  await refused(repo, () => full(repo, passing(repo, { evidence: [{ path: 'akrs/verifications/P6/evidence/nope.log', type: 'log' }] })), ['evidence_missing']);
  await refused(repo, () => full(repo, passing(repo, { evidence: [{ path: repo.run.path.replace(/\/run\.json$/, ''), type: 'log' }] })), ['evidence_missing']);
  await refused(repo, () => full(repo, passing(repo, { evidence: [] })), ['evidence_type_missing']);
});

test('evidence of another Plan, outside the evidence folder, escaping it or embedded as data is a usage error', async (t) => {
  const repo = await ranWorld(t);
  const digest = await treeDigest(repo);
  for (const path of [
    'akrs/verifications/P7/evidence/x.log', 'akrs/roads/R-P6-1.json', 'akrs/verifications/P6/evidence/../results.jsonl', '/etc/passwd', 'data:image/png;base64,AAAA', 'akrs/verifications/P6/contract.json',
  ]) {
    const out = await full(repo, failing({ evidence: [{ path, type: 'log' }] }));
    assert.equal(out.exitCode, 2, path);
  }
  assert.deepEqual(await treeDigest(repo), digest);
});

test('the CLI measures the evidence bytes and sha256 itself; the Tester cannot type them', async (t) => {
  const repo = await ranWorld(t);
  const out = await full(repo, failing({ evidence: [{ ...evidenceOf(repo), bytes: 1, sha256: `sha256:${'a'.repeat(64)}` }] }));
  assert.equal(out.exitCode, 2);
  const ok = await full(repo, failing({ evidence: [evidenceOf(repo)] }));
  assert.equal(ok.exitCode, 0, ok.text);
  assert.equal((await ledger(repo))[0].evidence[0].bytes > 0, true);
});

// ---- acceptance and findings ----------------------------------------------------------------------------------------
test('the acceptance answer and the verdict must agree, and a pass carries no open finding', async (t) => {
  const repo = await ranWorld(t);
  await refused(repo, () => full(repo, passing(repo, { user_acceptance: acceptance('no') })), ['acceptance_contradicts']);
  await refused(repo, () => full(repo, failing({ user_acceptance: acceptance('yes') })), ['acceptance_contradicts']);
  await refused(repo, () => full(repo, passing(repo, { findings: [{ id: 'F1', text: 'A typo remains.', status: 'open' }] })), ['finding_open']);
  const ok = await full(repo, passing(repo, { findings: [{ id: 'F1', text: 'A typo was fixed.', status: 'resolved' }] }));
  assert.equal(ok.exitCode, 0, ok.text);
});

// ---- the ledger -----------------------------------------------------------------------------------------------------
test('a ledger that cannot be read back takes no record', async (t) => {
  const repo = await ranWorld(t);
  await writeFile(repo.path(RESULTS), 'this is not a record\n');
  await refused(repo, () => flat(repo, 'pass'), ['ledger_unusable']);
});

test('a missing or hand-edited contract refuses with the reason', async (t) => {
  const repo = await ranWorld(t);
  await rm(repo.path('akrs/verifications/P6/contract.json'));
  await refused(repo, () => flat(repo, 'fail', 'No contract.'), ['contract_missing']);
  const hand = await ranWorld(t);
  await writeFile(hand.path('akrs/verifications/P6/contract.json'), '{"schema":"akrs.verification/v1"}\n');
  await refused(hand, () => flat(hand, 'fail', 'Hand edited.'), ['contract_unverified']);
});
