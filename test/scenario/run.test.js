// P2-W14: `test run` end to end with the real fixture app (HTTP-only scenarios need no browser): lease, evidence, run
// record, refusals, and the rule that nothing is written when nothing was tested.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validateRun } from '../../lib/schemas/verification.js';
import { readLease } from '../../lib/store/leases/index.js';
import { TESTER_LEASE_PROJECTION } from '../../lib/store/snapshots/projections.js';
import { commandSnapshot, computeSnapshot } from '../../lib/store/snapshots/index.js';
import { treeDigest } from '../road/support.js';
import { setExec } from '../road-details/support.js';
import { details } from '../test-details/support.js';
import { APP, ULID_RE, evidenceDir, freePort, runWorld, testRun } from './support.js';
import { define } from '../tester/support.js';

const reachable = (port) => fetch(`http://127.0.0.1:${port}/health`).then(() => true, () => false);
const files = async (repo, runId) => (await readdir(repo.path(evidenceDir(runId)))).sort();
const redefine = async (repo, overrides) => {
  const current = JSON.parse(await repo.read('akrs/verifications/P6/contract.json'));
  const { meta: _meta, ...input } = current;
  const snapshot = (await commandSnapshot('test-define', { ...repo.options, target: { plan: 'P6' } })).snapshot;
  const result = await define(repo, 'P6', { ...input, ...overrides }, { expectedSnapshot: snapshot });
  assert.equal(result.outcome, 'committed', JSON.stringify(result.packet?.findings));
};
const noFindings = (packet) => assert.deepEqual(packet.findings, [], JSON.stringify(packet.findings));

test('a passing HTTP scenario is ok, writes its evidence and run record, claims the Tester lease and leaves nothing running', async (t) => {
  const repo = await runWorld(t);
  const run = await testRun(repo);
  assert.equal(run.exitCode, 0, run.text);
  noFindings(run.packet);
  const { data } = run.packet;
  assert.deepEqual([run.packet.status, data.kind, data.plan, data.holder, data.run.status, data.summary], ['ok', 'test_run', 'P6', 'qa', 'passed', { passed: 2, failed: 0, soft_failed: 0, skipped: 0 }]);
  assert.match(data.run.id, ULID_RE);
  assert.equal(run.packet.request_id, data.run.id);
  assert.equal(data.run.path, `${evidenceDir(data.run.id)}/run.json`);
  assert.deepEqual(await files(repo, data.run.id), ['app.log', 'run.json']);
  assert.deepEqual(run.packet.changed, [`${evidenceDir(data.run.id)}/app.log`, data.run.path]);
  const stored = JSON.parse(await repo.read(data.run.path));
  assert.equal(validateRun(stored, { form: 'stored', workflowRoot: 'akrs' }).ok, true);
  assert.deepEqual([stored.id, stored.plan, stored.status, stored.steps.map(({ status }) => status)], [data.run.id, 'P6', 'passed', ['passed', 'passed']]);
  assert.deepEqual(stored.evidence.map(({ type }) => type), ['log']);
  assert.match(await repo.read(`${evidenceDir(data.run.id)}/app.log`), /fixture app listening/);
  assert.equal(await reachable(repo.port), false, 'the app is still running');
  const lease = await readLease({ ...repo.options, kind: 'plan', target: 'P6' });
  assert.deepEqual([lease.status, lease.lease.holder, data.lease], ['held', 'qa', { holder: 'qa', action: 'claimed' }]);
  const fresh = await computeSnapshot({ ...repo.options, projections: TESTER_LEASE_PROJECTION, target: { plan: 'P6' } });
  assert.equal(lease.lease.snapshot, fresh.snapshot, 'the run must not stale its own lease');
  assert.equal(data.run.snapshot, fresh.snapshot);
});

test('an execution is never deduplicated: two runs are two records and the lease is refreshed', async (t) => {
  const repo = await runWorld(t);
  const first = await testRun(repo);
  const second = await testRun(repo);
  assert.notEqual(first.packet.data.run.id, second.packet.data.run.id);
  assert.equal(second.packet.status, 'ok');
  assert.equal(second.packet.data.lease.action, 'refreshed');
  assert.equal((await readdir(repo.path('akrs/verifications/P6/evidence'))).length, 2);
});

test('a run changes only files under the evidence directory (and the lease in .ops); the Plan snapshot is the same before and after', async (t) => {
  const repo = await runWorld(t);
  const before = await computeSnapshot({ ...repo.options, projections: TESTER_LEASE_PROJECTION, target: { plan: 'P6' } });
  const run = await testRun(repo);
  const after = await computeSnapshot({ ...repo.options, projections: TESTER_LEASE_PROJECTION, target: { plan: 'P6' } });
  assert.equal(after.snapshot, before.snapshot);
  assert.ok(run.packet.changed.length > 0 && run.packet.changed.every((path) => path.startsWith('akrs/verifications/P6/evidence/')));
});

test('a failed hard step is an error packet with AKRS-T005, the later steps are skipped, and the failed run is still recorded', async (t) => {
  const repo = await runWorld(t, { contract: { scenario: [
    { step: 'http', method: 'GET', url: '/boom', headers: [], body: null, expect_status: 200, expect_json: null, soft: false },
    { step: 'http', method: 'GET', url: '/health', headers: [], body: null, expect_status: 200, expect_json: null, soft: false },
  ] } });
  const run = await testRun(repo);
  assert.deepEqual([run.exitCode, run.packet.status, run.packet.data.run.status], [1, 'error', 'failed']);
  assert.deepEqual(run.packet.data.steps.map(({ status }) => status), ['failed', 'skipped']);
  assert.equal(run.packet.data.steps[0].detail, 'GET /boom -> 500; expected status 200');
  assert.deepEqual(run.packet.findings.map(({ code, detail }) => [code, detail.reason, detail.step]), [['AKRS-T005', 'hard_step_failed', 0]]);
  assert.equal(existsSync(repo.path(run.packet.data.run.path)), true);
  assert.equal(JSON.parse(await repo.read(run.packet.data.run.path)).status, 'failed');
});

test('a soft failure is a warning; the run passes and the step says soft', async (t) => {
  const repo = await runWorld(t, { contract: { scenario: [
    { step: 'http', method: 'GET', url: '/boom', headers: [], body: null, expect_status: 200, expect_json: null, soft: true },
    { step: 'http', method: 'GET', url: '/health', headers: [], body: null, expect_status: 200, expect_json: null, soft: false },
  ] } });
  const run = await testRun(repo);
  assert.deepEqual([run.exitCode, run.packet.status, run.packet.data.run.status], [1, 'warning', 'passed']);
  assert.deepEqual(run.packet.findings.map(({ severity, detail }) => [severity, detail.reason]), [['warning', 'soft_step_failed']]);
  assert.equal(run.packet.data.summary.soft_failed, 1);
});

test('a ready Tester packet is required: a missing handoff blocks the run, launches nothing and writes nothing', async (t) => {
  const marker = (await import('node:path')).join((await import('node:os')).tmpdir(), `akrs-marker-${Date.now()}`);
  const repo = await runWorld(t, { contract: { setup: [{ name: 'mark', argv: ['node', '-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`] }] } });
  await writeFile(repo.path('akrs/verifications/P6/handoff.jsonl'), '');
  const digest = await treeDigest(repo);
  const run = await testRun(repo);
  assert.deepEqual([run.exitCode, run.packet.status, run.packet.data.kind, run.packet.data.reason], [1, 'blocked', 'test_run_blocked', 'tester_blocked']);
  assert.ok(run.packet.data.blockers.some(({ reason }) => reason === 'handoff_missing'));
  assert.ok(run.packet.findings.some(({ code }) => code === 'AKRS-T003'));
  assert.equal(existsSync(marker), false, 'a setup command ran although the packet was blocked');
  assert.deepEqual(await treeDigest(repo), digest);
  assert.equal((await readLease({ ...repo.options, kind: 'plan', target: 'P6' })).status, 'none');
});

test('a policy without a scenario or an empty scenario is refused before anything starts', async (t) => {
  const none = await runWorld(t, { contract: { scenario: [] } });
  const empty = await testRun(none);
  assert.deepEqual([empty.packet.status, empty.packet.data.reason, empty.packet.findings[0].code], ['blocked', 'scenario_missing', 'AKRS-T004']);
  const checks = await runWorld(t);
  await redefine(checks, { policy: 'checks', launch: null, scenario: [], measurements: [] });
  const run = await testRun(checks);
  assert.deepEqual([run.packet.data.reason, run.packet.findings[0].detail.reason], ['policy_not_live', 'policy_not_live']);
});

test('a hand-edited scenario with a step outside the vocabulary is refused before any process starts', async (t) => {
  const repo = await runWorld(t);
  const path = repo.path('akrs/verifications/P6/contract.json');
  const contract = JSON.parse(await readFile(path, 'utf8'));
  contract.scenario.push({ step: 'eval', script: 'process.exit(0)' });
  await writeFile(path, `${JSON.stringify(contract, null, 2)}\n`);
  const run = await testRun(repo);
  assert.equal(run.packet.status, 'blocked');
  assert.ok(['tester_blocked', 'scenario_invalid'].includes(run.packet.data.reason));
  assert.equal(await reachable(repo.port), false);
  assert.equal(existsSync(repo.path('akrs/verifications/P6/evidence')), false);
});

test('an unresolved Tester names the choices; --executor picks one', async (t) => {
  const repo = await runWorld(t, { executor: false });
  const none = await testRun(repo);
  assert.deepEqual([none.packet.status, none.packet.data.reason, none.packet.data.choices], ['blocked', 'holder_unresolved', []]);
  await setExec(repo, { id: 'qa', role: 'tester', class: 'medium', label: 'QA', user_answer: 'medium' });
  await setExec(repo, { id: 'qb', role: 'tester', class: 'weak', label: 'QB', user_answer: 'weak' });
  const two = await testRun(repo);
  assert.deepEqual(two.packet.data.choices, ['qa', 'qb']);
  assert.deepEqual(two.packet.next_commands.map(({ args }) => args.slice(0, 3)), [['P6', '--executor', 'qa'], ['P6', '--executor', 'qb']]);
  const picked = await testRun(repo, ['P6', '--executor', 'qb']);
  assert.equal(picked.packet.data.holder, 'qb');
  assert.equal(picked.packet.status, 'ok');
});

test('a Plan leased by another Tester is blocked with AKRS-C012 and nothing is launched', async (t) => {
  const repo = await runWorld(t);
  await setExec(repo, { id: 'qb', role: 'tester', class: 'weak', label: 'QB', user_answer: 'weak' });
  assert.equal((await testRun(repo, ['P6', '--executor', 'qa'])).packet.status, 'ok');
  const digest = await treeDigest(repo);
  const blocked = await testRun(repo, ['P6', '--executor', 'qb']);
  assert.deepEqual([blocked.packet.status, blocked.packet.data.reason, blocked.packet.findings.map(({ code }) => code)], ['blocked', 'lease_held', ['AKRS-C012']]);
  assert.equal(blocked.packet.findings[0].detail.holder, 'qa');
  assert.deepEqual(await treeDigest(repo), digest);
});

test('a workflow that changed while the run was running writes nothing and says changed_during_run', async (t) => {
  const repo = await runWorld(t);
  const run = await testRun(repo, ['P6'], { deps: { hooks: { beforeWrite: async () => { await repo.write('SOT/10-budgets.md', 'frame budget 99ms\n'); } } } });
  assert.deepEqual([run.packet.status, run.packet.data.reason, run.packet.findings[0].detail.reason], ['blocked', 'changed_during_run', 'changed_during_run']);
  assert.equal(existsSync(repo.path('akrs/verifications/P6/evidence')), false);
});

test('a failed setup command blocks the run: nothing is launched and the blocked run is recorded', async (t) => {
  const repo = await runWorld(t, { contract: { setup: [{ name: 'prepare', argv: ['node', '-e', 'process.exit(7)'] }] } });
  const run = await testRun(repo);
  assert.deepEqual([run.packet.status, run.packet.data.run.status, run.packet.data.run.block], ['blocked', 'blocked', 'setup_failed']);
  assert.deepEqual(run.packet.data.steps.map(({ status }) => status), ['skipped', 'skipped']);
  assert.equal(run.packet.data.setup[0].exit_code, 7);
  assert.equal(await reachable(repo.port), false);
  assert.ok(run.packet.findings.some(({ code, detail }) => code === 'AKRS-T005' && detail.reason === 'run_blocked'));
});

test('an app that cannot be started or never becomes ready blocks the run and is gone afterwards', async (t) => {
  const missing = await runWorld(t, { contract: { launch: { argv: ['akrs-no-such-program'], url: 'http://127.0.0.1:9', ready: null } } });
  assert.equal((await testRun(missing)).packet.data.run.block, 'launch_failed');
  const port = await freePort();
  const slow = await runWorld(t, { port, contract: { launch: { argv: [process.execPath, APP, String(port)], url: `http://127.0.0.1:${port}`, ready: { url: `http://127.0.0.1:${port}/health`, status: 204, timeout_ms: 1000 } } } });
  const run = await testRun(slow);
  assert.equal(run.packet.data.run.block, 'ready_timeout');
  assert.equal(await reachable(port), false);
});

test('teardown runs after the app is stopped; a failing teardown is a warning and the run keeps its status', async (t) => {
  const repo = await runWorld(t, { contract: { teardown: [{ name: 'clean', argv: ['node', '-e', 'process.exit(2)'] }] } });
  const run = await testRun(repo);
  assert.deepEqual([run.packet.status, run.packet.data.run.status, run.packet.data.teardown.map(({ name, status }) => [name, status])], ['warning', 'passed', [['clean', 'failed']]]);
  assert.deepEqual(run.packet.findings.map(({ detail }) => detail.reason), ['teardown_failed']);
});

test('browser steps without a browser are skipped, the HTTP steps still run, and the run is blocked with AKRS-C018', async (t) => {
  const repo = await runWorld(t, { contract: { scenario: [
    { step: 'http', method: 'GET', url: '/health', headers: [], body: null, expect_status: 200, expect_json: null, soft: false },
    { step: 'goto', url: '/', soft: false },
    { step: 'http', method: 'GET', url: '/api/reservations', headers: [], body: null, expect_status: 200, expect_json: null, soft: false },
  ] } });
  const run = await testRun(repo, ['P6'], { deps: { discoverBrowser: () => ({ ok: false, reason: 'browser_not_found', tried: [], remediation: 'Install Chrome.' }) } });
  assert.deepEqual([run.packet.status, run.packet.data.run.status, run.packet.data.run.block], ['blocked', 'blocked', 'no_browser']);
  assert.deepEqual(run.packet.data.steps.map(({ status }) => status), ['passed', 'skipped', 'passed']);
  assert.ok(run.packet.findings.some(({ code }) => code === 'AKRS-C018'));
  assert.equal(JSON.parse(await repo.read(run.packet.data.run.path)).status, 'blocked');
});

test('browser steps run through the driver; screenshots and the console and network texts become evidence files with measured refs', async (t) => {
  const repo = await runWorld(t, { contract: { evidence_types: ['screenshot', 'console', 'network', 'a11y', 'timing', 'log'], scenario: [
    { step: 'goto', url: '/', soft: false },
    { step: 'expect_text', text: 'Reservations', soft: false },
    { step: 'screenshot', name: 'home', soft: false },
  ] } });
  const driver = {
    async goto() {}, async expectText() { return true; }, async screenshot() { return Buffer.from('PNGBYTES'); }, async consoleLog() { return 'no console errors\n'; },
    async networkLog() { return '{"failed":[],"total_requests":1}\n'; }, async a11yText() { return 'RootWebArea "Demo"\n'; }, async timings() { return { ttfb_ms: 5, dom_content_loaded_ms: 9, load_ms: 12 }; },
  };
  const run = await testRun(repo, ['P6'], { deps: { discoverBrowser: () => ({ ok: true, path: 'fake' }), openDriver: async () => ({ ok: true, driver, browser: 'Fake/1', close: async () => {} }) } });
  assert.equal(run.packet.status, 'ok', run.text);
  const id = run.packet.data.run.id;
  assert.deepEqual(await files(repo, id), ['a11y.txt', 'app.log', 'console.log', 'home.png', 'network.json', 'run.json', 'timing.json']);
  assert.equal(await readFile(repo.path(`${evidenceDir(id)}/home.png`), 'utf8'), 'PNGBYTES');
  const record = JSON.parse(await repo.read(run.packet.data.run.path));
  assert.deepEqual(record.evidence.map(({ type }) => type).sort(), ['a11y', 'console', 'log', 'network', 'screenshot', 'timing']);
  assert.ok(record.evidence.every(({ bytes, sha256 }) => bytes > 0 && /^sha256:/.test(sha256)));
  assert.deepEqual(record.steps[2].evidence.map(({ path }) => path.split('/').pop()), ['home.png']);
  assert.equal(run.packet.data.browser, 'Fake/1');
});

test('only the evidence types the contract lists are written', async (t) => {
  const repo = await runWorld(t, { contract: { evidence_types: ['screenshot'] } });
  const run = await testRun(repo);
  assert.deepEqual(await files(repo, run.packet.data.run.id), ['run.json']);
});

test('an interruption ends the app and writes nothing', async (t) => {
  const port = await freePort();
  const repo = await runWorld(t, { port, contract: { launch: { argv: [process.execPath, APP, String(port)], url: `http://127.0.0.1:${port}`, ready: { url: `http://127.0.0.1:${port}/health`, status: 201, timeout_ms: 20000 } } } });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 400);
  const run = await testRun(repo, ['P6'], { deps: { signal: controller.signal } });
  assert.deepEqual([run.exitCode, run.packet.status, run.packet.data.reason], [1, 'error', 'interrupted']);
  assert.equal(existsSync(repo.path('akrs/verifications/P6/evidence')), false);
  assert.equal(await reachable(port), false);
});

test('test-details shows the latest runs in its runs slot, and a run is no longer current after the Plan changes', async (t) => {
  const repo = await runWorld(t);
  const first = await testRun(repo);
  const shown = await details(repo, 'P6');
  assert.deepEqual(shown.packet.data.runs.map(({ id, status, current, path }) => [id, status, current, path]), [[first.packet.data.run.id, 'passed', true, first.packet.data.run.path]]);
  const second = await testRun(repo);
  assert.deepEqual((await details(repo, 'P6')).packet.data.runs.map(({ id }) => id), [second.packet.data.run.id, first.packet.data.run.id]);
  await repo.write('SOT/10-budgets.md', 'frame budget 15ms\n');
  assert.equal((await details(repo, 'P6')).packet.data.runs[0].current, false);
});

test('a workflow with an unreadable run directory still gives a packet, with the problem named', async (t) => {
  const repo = await runWorld(t);
  await mkdir(repo.path('akrs/verifications/P6/evidence/01ARZ3NDEKTSV4RRFFQ69G5FB1'), { recursive: true });
  const shown = await details(repo, 'P6');
  assert.deepEqual(shown.packet.data.runs, []);
  assert.deepEqual(shown.packet.data.run_problems.map(({ id, reason }) => [id, reason]), [['01ARZ3NDEKTSV4RRFFQ69G5FB1', 'incomplete']]);
});
