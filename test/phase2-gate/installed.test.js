// P2-W11 release gate, part 1: the PACKED tarball is installed into a clean project and the complete product runs from the installed code
// in separate processes: the Worker and Tester loops of the A1 agent-experience (AX) gate, the primitive Worker loop, the scope loop,
// the negative loops, JSONL, the MCP server in both protocol eras, the nine agent adapters, the pre-write guard and the offline board.
// One tarball is packed and installed for the whole file (EXECUTION-RULES section 6); the sandbox, the tarball and every project under it
// are removed afterwards and the repository status is compared before and after.
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runNode } from '../helpers/process.js';
import {
  createPackSandbox, describeFailure, gitStatus, installTarball, packTarball, repositoryTarballs,
} from '../package/pack-harness.js';
import {
  APP_SOURCE, SENTENCE, createProject, digestTree, freePort, hasPlaceholder, spawnInstalledServer,
} from './support.js';

const SLOW = { timeout: 900_000 };
const GOLDEN_AGENTS = fileURLToPath(new URL('../agents/golden/', import.meta.url));
const ALL_AGENTS = ['claude', 'codex', 'gemini', 'pi', 'opencode', 'kimi', 'qwen', 'cursor', 'freebuff'];
const MODERN = '2026-07-28';
const modernMeta = (version = MODERN) => ({ 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {} });

// A next command an agent is told to run carries no bookkeeping and no placeholder (A1 AX2 / AX4).
const assertRunnable = (packet) => {
  for (const { args } of packet.next_commands) {
    assert.ok(!args.includes('--if-snapshot') && !args.includes('--request-id') && !args.some((argument) => argument.startsWith('sha256:')),
      `${packet.command}: a next command carries bookkeeping: ${args.join(' ')}`);
    assert.ok(!args.some(hasPlaceholder), `${packet.command}: a next command carries a placeholder: ${args.join(' ')}`);
  }
};

// The Leader's setup of the packaged scaffold: classify, give the Road its class, optionally a live contract, then activate.
async function leaderSetup(project, { port, roadOverrides = {}, activate = true, scenario = null, evidence = ['log'] } = {}) {
  const scaffold = await project.run(['init', '--scaffold']);
  assert.equal(scaffold.packet.status, 'ok');
  const { tier, road_id: road, plan_id: plan } = scaffold.packet.data.scaffold;
  await project.setExecutors();
  await project.commit('baseline');
  const stored = await project.stored(`akrs/roads/${road}.json`);
  const roadDraft = await project.draft('road', { ...stored, executor_class: 'weak', ...roadOverrides });
  assert.equal((await project.guarded(['road', 'update', road, '--input', roadDraft, '--reason', 'weak Worker'])).packet.status, 'ok');
  if (port !== undefined) {
    const key = plan ?? road;
    const contract = await project.stored(`akrs/verifications/${key}/contract.json`);
    const contractDraft = await project.draft('contract', {
      ...contract,
      policy: 'live',
      launch: { argv: [process.execPath, 'server.js', String(port)], url: `http://127.0.0.1:${port}`, ready: { url: `http://127.0.0.1:${port}/health`, status: 200, timeout_ms: 15_000 } },
      evidence_types: evidence,
      scenario: scenario ?? [{ step: 'http', method: 'GET', url: '/health', headers: [], body: null, expect_status: 200, expect_json: { pointer: '/ok', equals: true }, soft: false }],
    });
    assert.equal((await project.guarded(['test', 'define', key, '--input', contractDraft])).packet.status, 'ok');
  }
  if (activate) assert.equal((await project.guarded(['road', 'activate', road])).packet.status, 'ok');
  return { tier, road, plan };
}

const finishWith = (project, road, extra = []) => project.agent(['done', road, '--result', 'README describes the project', '--reach', 'open README.md', '--expect', 'the sentence about HTTP', ...extra], { expect: [0, 1] });
const writeSentence = (project) => project.write('README.md', `# Demo\n\n${SENTENCE}\n`);
const scopeRequest = (road, writes, { blocking = true, reason = 'the Road needs one more file' } = {}) => ({
  schema: 'akrs.scope-request/v1', road, add_reads: [], add_writes: writes.map((path) => ({ path, class: 'file', action: 'create' })), reason, blocking,
});

test('v2.0.0 release gate: the packed tarball, installed, runs every loop of the product', SLOW, async (t) => {
  const statusBefore = await gitStatus();
  const tarballsBefore = await repositoryTarballs();
  const sandbox = await createPackSandbox(t);
  const tarball = await packTarball(sandbox);
  t.diagnostic(`tarball ${tarball.filename}`);
  t.diagnostic(`sha256 ${tarball.sha256}`);
  const installed = await installTarball(sandbox, tarball);
  assert.equal(installed.install.exitCode, 0, describeFailure('npm install <tarball>', installed.install));
  const installedVersion = JSON.parse(await readFile(join(installed.packageRoot, 'package.json'), 'utf8')).version;
  const loops = {};

  await t.test('the tarball carries the runtime, the doctrine, the skills and the example, and nothing local', async () => {
    const has = (prefix) => tarball.files.some((path) => path === prefix || path.startsWith(prefix));
    for (const required of ['bin/akrs.js', 'bin/akrs-guard.js', 'lib/core/index.js', 'docs/framework/skills/akrs-work-loop.md', 'examples/minimal/akrs/roads/R1.json', 'GETTING_STARTED.md', 'LICENSE']) {
      assert.ok(tarball.files.includes(required), `the tarball contains ${required}`);
    }
    for (const forbidden of ['plans/', 'test/', 'scratch/', 'docs/research/', 'docs/validation/', 'docs/guides/', '.github/', 'node_modules/', 'templates/']) {
      assert.equal(has(forbidden), false, `the tarball must not contain ${forbidden}`);
    }
    assert.equal(tarball.files.some((path) => path.endsWith('.tgz')), false);
  });

  await t.test('AX gates 1-4: the Worker is two calls (work, done) and the Tester three (test-details, test run, test result), with no bookkeeping', async () => {
    const port = await freePort();
    const project = await createProject(sandbox, installed, 'ax-loops', { 'server.js': APP_SOURCE });
    const { tier, road } = await leaderSetup(project, { port });
    loops.project = project;
    loops.road = road;
    assert.equal(tier, 'no_plan');
    assert.equal(project.agentCalls.length, 0, 'the Leader setup is not counted as agent calls');

    const claimed = await project.agent(['work']);
    assert.equal(claimed.packet.status, 'ok', JSON.stringify(claimed.packet.findings));
    assertRunnable(claimed.packet);
    await writeSentence(project);
    const finished = await finishWith(project, road);
    assert.equal(finished.packet.status, 'ok', JSON.stringify(finished.packet.findings));
    assertRunnable(finished.packet);
    assert.deepEqual(finished.packet.next_commands.map(({ command }) => command), ['next'], 'a finished Worker is pointed at next, never at Leader housekeeping');
    assert.equal(project.agentCalls.length, 2, 'AX gate 1: the Worker happy path is at most 3 calls');
    assert.deepEqual(finished.packet.changed, ['log/0001.jsonl', 'roads/R1.json', 'verifications/R1/handoff.jsonl']);
    loops.cliChanged = finished.packet.changed;

    const before = project.agentCalls.length;
    const details = await project.agent(['test-details', road]);
    assert.equal(details.packet.status, 'ok', JSON.stringify(details.packet.findings));
    assertRunnable(details.packet);
    assert.deepEqual(details.packet.next_commands.map(({ command }) => command), ['test-run']);
    const run = await project.agent(['test', 'run', road]);
    assert.equal(run.packet.status, 'ok', JSON.stringify(run.packet.findings));
    assert.equal(run.packet.data.run.status, 'passed');
    assertRunnable(run.packet);
    const result = await project.agent(['test', 'result', road, '--verdict', 'pass', '--because', 'the health check answered {"ok":true}']);
    assert.equal(result.packet.status, 'ok', JSON.stringify(result.packet.findings));
    assertRunnable(result.packet);
    assert.equal(project.agentCalls.length - before, 3, 'AX gate 2: the Tester happy path is at most 3 calls');

    // the Leader's close: derived State, then a clean validate
    assert.equal((await project.run(['state', 'render'])).packet.status, 'ok');
    const validated = await project.run(['validate']);
    assert.deepEqual([validated.packet.status, validated.packet.findings], ['ok', []]);
    assert.equal(validated.packet.data.coverage.skipped, 0);
    assert.equal((await project.run(['status'])).packet.data.roads.by_status.DONE, 1);
    assert.deepEqual((await project.run(['next'])).packet.next_commands, []);
    assert.equal((await project.run(['audit', '--git', '--road', road])).packet.status, 'ok');
    assert.ok((await project.read('README.md')).includes(SENTENCE));
  });

  await t.test('the Plan tier: the scaffold names the Plan and the Road, and the Tester packet is keyed by the Plan', async () => {
    const project = await createProject(sandbox, installed, 'plan-tier');
    const scaffold = await project.run(['init', '--scaffold', '--plan', 'P1']);
    const { tier, plan_id: plan, road_id: road } = scaffold.packet.data.scaffold;
    assert.deepEqual([tier, plan, road], ['plan', 'P1', 'R-P1-1']);
    await project.setExecutors();
    assert.equal((await project.run(['road-details', road, '--role', 'worker'])).packet.status, 'ok');
    const details = await project.run(['test-details', plan]);
    assert.deepEqual([details.packet.status, details.packet.data.plan, details.packet.data.mode], ['ok', 'P1', 'plan']);
    const closing = await project.run(['plan', 'finish', plan, '--dry-run'], { expect: [0, 1] });
    assert.equal(closing.packet.status, 'blocked', 'a Plan with an unfinished Road cannot close');
  });

  await t.test('AX gate 3: the Leader makes a Road from a draft in one call (a scope decision is one call, see the scope loop)', async () => {
    const project = await createProject(sandbox, installed, 'leader-calls');
    const { road } = await leaderSetup(project, { activate: false });
    const stored = await project.stored(`akrs/roads/${road}.json`);
    const { status: _status, ...input } = stored;
    const second = await project.draft('second', { ...input, id: 'R2', task: null, writes: [{ path: 'second.md', class: 'file', action: 'create' }], boundaries: ['Change no file other than second.md.'], acceptance: ['second.md exists.'] });
    const created = await project.run(['road', 'new', '--input', second]);
    assert.equal(created.packet.status, 'ok', JSON.stringify(created.packet.findings));
    assert.equal((await project.stored('akrs/roads/R2.json')).id, 'R2');
    await assert.rejects(stat(project.path(second)), { code: 'ENOENT' }, 'a consumed draft is removed');
  });

  await t.test('gate 1: the primitive Worker loop next -> road-details -> verify --road -> audit --git --road -> road finish closes the Road once', async () => {
    const project = await createProject(sandbox, installed, 'primitive');
    const { road } = await leaderSetup(project);
    const next = await project.run(['next', '--executor', 'worker']);
    assert.equal(next.packet.status, 'ok');
    assert.ok(JSON.stringify(next.packet.next_commands).includes(road), 'next names the ACTIVE Road');
    assertRunnable(next.packet);
    const details = await project.run(['road-details', road, '--role', 'worker']);
    assert.equal(details.packet.status, 'ok');
    assert.equal(details.packet.data.road.status, 'ACTIVE');
    await writeSentence(project);

    // gate 5: the streamed verify is ordered facts that end in exactly one complete event carrying a packet
    const streamed = await project.run(['verify', '--road', road, '--jsonl']);
    const events = streamed.stdout.trimEnd().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(events.map(({ sequence }) => sequence), events.map((_event, index) => index + 1));
    assert.deepEqual(events.map(({ type }) => type).filter((type) => type === 'complete'), ['complete']);
    assert.equal(events.at(-1).type, 'complete', 'the complete event is last');
    assert.equal(events.at(-1).data.packet.command, 'verify');
    const verified = await project.run(['verify', '--road', road]);
    assert.equal(verified.packet.status, 'ok');
    assert.equal(verified.packet.data.outcome, events.at(-1).data.packet.data.outcome, 'the streamed packet and --json agree');
    assert.equal(verified.packet.data.summary.passed, events.at(-1).data.packet.data.summary.passed);

    assert.equal((await project.run(['audit', '--git', '--road', road])).packet.status, 'ok');
    const finished = await project.guarded(['road', 'finish', road]);
    assert.equal(finished.packet.status, 'ok', JSON.stringify(finished.packet.findings));
    assert.equal(finished.packet.data.road.to, 'DONE');
    assert.equal(finished.packet.data.closure.action, 'appended');
    assert.equal((await project.stored(`akrs/roads/${road}.json`)).status, 'DONE');
    assert.equal((await project.run(['log', '--subject', road])).packet.status, 'ok');
  });

  await t.test('gate 2: scope request -> blocked Worker -> scope approve -> work (a fresh packet) -> done', async () => {
    const project = await createProject(sandbox, installed, 'scope-approve');
    const { road } = await leaderSetup(project);
    assert.equal((await project.agent(['work'])).packet.status, 'ok');
    const request = await project.draft('request', scopeRequest(road, ['helper.js']));
    const asked = await project.agent(['scope', 'request', '--input', request], { expect: [0, 1] });
    assert.equal(asked.packet.status, 'warning', 'a request grants nothing by itself');
    assert.equal(asked.packet.data.request.state, 'pending');
    assert.equal(asked.packet.data.worker, 'stop', 'the Worker is told to stop');
    assert.equal(asked.packet.data.envelope.granted, false);
    assert.equal((await project.stored(`akrs/roads/${road}.json`)).writes.length, 1, 'the Road still has its one declared write');

    await writeSentence(project);
    await project.write('helper.js', 'export {};\n');
    const blocked = await finishWith(project, road);
    assert.equal(blocked.packet.status, 'blocked');
    assert.ok(blocked.packet.data.blockers.some(({ reason }) => reason === 'scope_request_pending'), 'done names the pending blocking request');
    assert.equal((await project.stored(`akrs/roads/${road}.json`)).status, 'ACTIVE', 'a blocked done finishes nothing');

    const leaderCalls = [];
    const approved = await project.run(['scope', 'approve', road, '--reason', 'the helper is needed']);
    leaderCalls.push(approved);
    assert.equal(approved.packet.status, 'ok', JSON.stringify(approved.packet.findings));
    assert.equal(leaderCalls.length, 1, 'AX gate 3: one call per scope approval');
    assert.deepEqual((await project.stored(`akrs/roads/${road}.json`)).writes.map(({ path }) => path), ['README.md', 'helper.js']);

    const fresh = await project.agent(['work']);
    assert.equal(fresh.packet.status, 'ok');
    assert.equal(fresh.packet.data.claim.action, 'refreshed', 'the same holder gets a fresh claim over the changed Road');
    assert.deepEqual(fresh.packet.data.details.writes.map(({ path }) => path), ['README.md', 'helper.js']);
    const finished = await finishWith(project, road);
    assert.equal(finished.packet.status, 'ok', JSON.stringify(finished.packet.findings));
  });

  await t.test('gate 2: scope reject grants nothing and the Worker finishes inside the original scope', async () => {
    const project = await createProject(sandbox, installed, 'scope-reject');
    const { road } = await leaderSetup(project);
    assert.equal((await project.agent(['work'])).packet.status, 'ok');
    const request = await project.draft('request', scopeRequest(road, ['helper.js']));
    assert.equal((await project.agent(['scope', 'request', '--input', request], { expect: [0, 1] })).packet.status, 'warning');
    const rejected = await project.run(['scope', 'reject', road, '--reason', 'not needed for a README']);
    assert.equal(rejected.packet.status, 'ok');
    assert.equal((await project.stored(`akrs/roads/${road}.json`)).writes.length, 1, 'nothing was granted');
    await writeSentence(project);
    const stale = await finishWith(project, road);
    assert.equal(stale.packet.status, 'blocked', 'the decision changed what the Worker read');
    assert.deepEqual(stale.packet.next_commands.map(({ command }) => command), ['work']);
    assert.equal((await project.agent(['work'])).packet.status, 'ok');
    assert.equal((await finishWith(project, road)).packet.status, 'ok');
  });

  await t.test('gate 2: a request inside the Leader-authored envelope is granted by the CLI with no Leader call; one outside it waits', async () => {
    const project = await createProject(sandbox, installed, 'scope-envelope');
    await project.run(['init', '--scaffold']);
    await project.setExecutors();
    assert.equal((await project.run(['executor', 'set', 'mid', '--role', 'worker', '--class', 'medium', '--label', 'mid', '--answer', 'medium'])).packet.status, 'ok');
    await project.commit('baseline');
    const stored = await project.stored('akrs/roads/R1.json');
    const draft = await project.draft('road', { ...stored, executor_class: 'medium', scope_policy: { auto_reads: [], auto_writes: ['gen/*.js'] } });
    assert.equal((await project.guarded(['road', 'update', 'R1', '--input', draft, '--reason', 'envelope'])).packet.status, 'ok');
    assert.equal((await project.guarded(['road', 'activate', 'R1'])).packet.status, 'ok');
    assert.equal((await project.agent(['work', '--executor', 'mid'])).packet.status, 'ok');
    const inside = await project.draft('inside', scopeRequest('R1', ['gen/a.js']));
    const granted = await project.agent(['scope', 'request', '--input', inside], { expect: [0, 1] });
    assert.equal(granted.packet.status, 'ok', JSON.stringify(granted.packet.findings));
    assert.deepEqual([granted.packet.data.envelope.granted, granted.packet.data.resolution.granted_by, granted.packet.data.request.state], [true, 'envelope', 'approved']);
    assert.ok((await project.stored('akrs/roads/R1.json')).writes.some(({ path }) => path === 'gen/a.js'));
    const outside = await project.draft('outside', scopeRequest('R1', ['app/b.js']));
    const waiting = await project.agent(['scope', 'request', '--input', outside], { expect: [0, 1] });
    assert.deepEqual([waiting.packet.status, waiting.packet.data.envelope.granted, waiting.packet.data.request.state], ['warning', false, 'pending']);
  });

  await t.test('gate 4: a failed check, an over-budget packet, a stale snapshot and a changed contract each refuse in the open and write nothing', async () => {
    const project = await createProject(sandbox, installed, 'negatives');
    const { road } = await leaderSetup(project, {
      roadOverrides: { checks: [{ name: 'readme-sentence', argv: [process.execPath, '-e', `process.exit(require('fs').readFileSync('README.md','utf8').includes('${SENTENCE}')?0:1)`], timeout_ms: 30_000 }] },
    });
    assert.equal((await project.agent(['work'])).packet.status, 'ok');

    // a failed declared check finishes nothing and names the check and its fix
    await project.write('README.md', '# Demo\n\nnothing yet\n');
    const roadBefore = await project.read(`akrs/roads/${road}.json`);
    const failed = await finishWith(project, road);
    assert.equal(failed.packet.status, 'blocked');
    assert.ok(failed.packet.findings.some(({ code }) => code === 'AKRS-R023'), 'the failed check is a finding');
    assertRunnable(failed.packet);
    assert.equal(await project.read(`akrs/roads/${road}.json`), roadBefore, 'a refused done writes nothing');
    assert.ok(failed.packet.next_commands.length > 0, 'a refusal names what to run next');

    // an over-budget packet is refused whole: the numbers are named and nothing is shortened
    const refused = await project.run(['road-details', road, '--role', 'worker', '--max-tokens', '50'], { expect: [0, 1] });
    assert.equal(refused.packet.status, 'blocked');
    assert.ok(refused.packet.findings.some(({ code }) => code === 'AKRS-R021'));
    assert.equal(refused.packet.data.kind, 'road_details_refused');
    assert.ok(refused.packet.data.refusal.packet_tokens > 50);

    // a stale snapshot writes nothing
    const staleSnapshot = await project.snapshotFor(['road', 'update', road, '--input', await project.draft('again', { ...(await project.stored(`akrs/roads/${road}.json`)), boundaries: ['Change no file other than README.md.', 'Be brief.'] }), '--reason', 'brief']);
    const patch = await project.draft('patch', { schema: 'akrs.road-patch/v1', ops: [{ op: 'replace_boundaries', boundaries: ['Change no file other than README.md.', 'Keep it short.'] }] });
    assert.equal((await project.run(['road', 'update', road, '--patch', '--input', patch])).packet.status, 'ok');
    const bytes = await digestTree(project.path('akrs'));
    const stale = await project.run(['road', 'update', road, '--input', 'akrs/drafts/again.json', '--reason', 'brief', '--if-snapshot', staleSnapshot], { expect: [0, 1] });
    assert.equal(stale.packet.status, 'blocked');
    assert.deepEqual(stale.packet.findings.map(({ code }) => code), ['AKRS-C013']);
    assert.equal(await digestTree(project.path('akrs')), bytes, 'a stale update writes no byte');

    // the Leader changed the contract while the Worker held the lease: done is blocked with the delta and a way forward
    await writeSentence(project);
    const changed = await finishWith(project, road);
    assert.equal(changed.packet.status, 'blocked');
    assert.equal(changed.packet.data.reason, 'lease_stale');
    assert.ok(changed.packet.data.delta.changed.includes(`road:akrs/roads/${road}.json`), 'the delta names the changed Road');
    assert.deepEqual(changed.packet.next_commands.map(({ command }) => command), ['work']);
    assert.equal((await project.agent(['work'])).packet.status, 'ok');
    assert.equal((await finishWith(project, road)).packet.status, 'ok');
  });

  await t.test('gate 3 and 4: a Tester pass needs a run and its evidence, and a change after a pass makes the pass stale', async () => {
    const port = await freePort();
    const project = await createProject(sandbox, installed, 'tester-negatives', { 'server.js': APP_SOURCE });
    const { road } = await leaderSetup(project, { port });
    assert.equal((await project.agent(['work'])).packet.status, 'ok');
    await writeSentence(project);
    assert.equal((await finishWith(project, road)).packet.status, 'ok');

    // no run, no evidence: the pass is refused and nothing is recorded
    const early = await project.agent(['test', 'result', road, '--verdict', 'pass', '--because', 'looks fine'], { expect: [0, 1] });
    assert.equal(early.packet.status, 'blocked');
    assert.ok(early.packet.findings.every(({ code }) => code === 'AKRS-T006'));
    assert.deepEqual(early.packet.next_commands.map(({ command }) => command), ['test-run']);
    await assert.rejects(stat(project.path(`akrs/verifications/${road}/results.jsonl`)), { code: 'ENOENT' }, 'a refused result writes no ledger');

    assert.equal((await project.agent(['test', 'run', road])).packet.data.run.status, 'passed');
    const passed = await project.agent(['test', 'result', road, '--verdict', 'pass', '--because', 'the health check answered']);
    assert.equal(passed.packet.status, 'ok', JSON.stringify(passed.packet.findings));
    assert.equal((await project.run(['test-details', road])).packet.data.result.state, 'passed');

    // the product changes after the pass: the pass is stale and the next command is a new run
    await project.write('README.md', `# Demo\n\n${SENTENCE}\nA line added after the pass.\n`);
    const after = await project.run(['test-details', road]);
    assert.equal(after.packet.data.result.state, 'stale');
    assert.deepEqual(after.packet.next_commands.map(({ command }) => command), ['test-run']);
    const late = await project.agent(['test', 'result', road, '--verdict', 'pass', '--because', 'looks fine'], { expect: [0, 1] });
    assert.equal(late.packet.status, 'blocked', 'a stale run cannot support a new pass');
  });

  await t.test('no browser: page and a browser scenario are blocked with AKRS-C018 and a remediation, never passed', async () => {
    const port = await freePort();
    const project = await createProject(sandbox, installed, 'no-browser', { 'server.js': APP_SOURCE });
    const { road } = await leaderSetup(project, {
      port,
      evidence: ['log'],
      scenario: [
        { step: 'http', method: 'GET', url: '/health', headers: [], body: null, expect_status: 200, expect_json: { pointer: '/ok', equals: true }, soft: false },
        { step: 'goto', url: '/', soft: false },
        { step: 'expect_text', text: 'hello', soft: false },
      ],
    });
    const env = { AKRS_BROWSER_PATH: join(project.root, 'no-such-browser'), CHROME_PATH: '' };
    const page = await project.run(['page', `http://127.0.0.1:${port}/`], { expect: [1], env });
    assert.equal(page.packet.status, 'blocked');
    assert.equal(page.packet.findings[0].code, 'AKRS-C018');
    assert.equal(page.packet.data.reason, 'configured_browser_missing');
    assert.match(page.packet.data.remediation, /AKRS_BROWSER_PATH/);

    assert.equal((await project.agent(['work'])).packet.status, 'ok');
    await writeSentence(project);
    assert.equal((await finishWith(project, road)).packet.status, 'ok');
    const run = await project.agent(['test', 'run', road], { expect: [1], env });
    assert.equal(run.packet.status, 'blocked');
    assert.ok(run.packet.findings.some(({ code }) => code === 'AKRS-C018'));
    assert.equal(run.packet.data.run.status, 'blocked');
    const steps = run.packet.data.steps.map(({ status }) => status);
    assert.equal(steps[0], 'passed', 'the HTTP step still ran');
    assert.ok(!steps.slice(1).includes('passed'), 'a browser step never passes without a browser');
    const refused = await project.agent(['test', 'result', road, '--verdict', 'pass', '--because', 'looks fine'], { expect: [0, 1], env });
    assert.equal(refused.packet.status, 'blocked', 'a blocked run cannot support a pass');
  });

  await t.test('MCP dual era from the installed package: both protocol eras, seven flat tools, and the Worker and Tester loops through tools', async () => {
    const port = await freePort();
    const project = await createProject(sandbox, installed, 'mcp-loop', { 'server.js': APP_SOURCE });
    const { road } = await leaderSetup(project, { port });
    const server = spawnInstalledServer(installed.binPath, project.root);

    // legacy era
    const init = await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gate', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.result.serverInfo, { name: 'akrs', version: installedVersion });
    assert.ok(init.result.instructions.slice(0, 512).includes('akrs'), 'the essentials are in the first 512 characters');
    server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const listed = await server.request('tools/list');
    const tools = listed.result.tools;
    assert.ok(tools.length <= 7, 'AX gate 6: at most seven tools');
    assert.deepEqual(tools.map(({ name }) => name).sort(), ['akrs_page', 'akrs_road', 'akrs_scope', 'akrs_status', 'akrs_test', 'akrs_work', 'akrs_write']);
    for (const tool of tools) {
      assert.match(tool.name, /^[a-z][a-z0-9_]{0,29}$/);
      assert.ok(tool.description.length <= 200, `${tool.name}: one short sentence`);
      assert.equal(tool.inputSchema.type, 'object');
      for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
        assert.match(name, /^[a-z][a-z0-9_]{0,63}$/);
        assert.ok(['string', 'integer', 'boolean', 'array'].includes(schema.type), `${tool.name}.${name} is flat`);
        if (schema.type === 'array') assert.equal(schema.items.type, 'string');
        for (const keyword of ['$ref', 'oneOf', 'anyOf', 'allOf', 'const', 'default', 'format', 'not']) assert.equal(Object.hasOwn(schema, keyword), false, `${tool.name}.${name} has no ${keyword}`);
      }
    }
    const call = async (name, args) => {
      const response = await server.request('tools/call', { name, arguments: args });
      assert.ok(response.result, JSON.stringify(response));
      assert.ok(Buffer.byteLength(response.result.content[0].text) <= 16_384, 'AX gate 6: a result stays under 16 KiB');
      return response.result;
    };

    // the Worker loop through tools: two calls
    const claimed = await call('akrs_work', { action: 'work' });
    assert.deepEqual([claimed.isError, claimed.structuredContent.status], [false, 'ok']);
    await writeSentence(project);
    const done = await call('akrs_work', { action: 'done', road, result: 'README describes the project', reach: ['open README.md'], expect: 'the sentence about HTTP' });
    assert.equal(done.structuredContent.status, 'ok', JSON.stringify(done.structuredContent.findings));
    assert.deepEqual(done.structuredContent.changed, loops.cliChanged, 'the same files change as through the CLI loop');
    assert.equal(done.content[0].type, 'text');

    // the Tester loop through tools: three calls
    const details = await call('akrs_test', { action: 'details', plan: road });
    assert.equal(details.structuredContent.status, 'ok');
    const run = await call('akrs_test', { action: 'run', plan: road });
    assert.equal(run.structuredContent.data.run.status, 'passed');
    const result = await call('akrs_test', { action: 'result', plan: road, verdict: 'pass', because: 'the health check answered' });
    assert.equal(result.structuredContent.status, 'ok', JSON.stringify(result.structuredContent.findings));

    // modern era on the same process: stateless, versioned per request
    const discover = await server.request('server/discover', { _meta: modernMeta() });
    assert.deepEqual(discover.result.supportedVersions, [MODERN]);
    assert.equal(discover.result.resultType, 'complete');
    const modernList = await server.request('tools/list', { _meta: modernMeta() });
    assert.equal(modernList.result.tools.length, tools.length);
    const modernCall = await server.request('tools/call', { name: 'akrs_status', arguments: { action: 'status' }, _meta: modernMeta() });
    assert.equal(modernCall.result.resultType, 'complete');
    assert.equal(modernCall.result.structuredContent.data.roads.by_status.DONE, 1);
    const wrong = await server.request('tools/list', { _meta: modernMeta('2025-06-18') });
    assert.equal(wrong.error.code, -32022);
    assert.deepEqual(wrong.error.data.supported, [MODERN]);

    const finished = await server.finish();
    assert.equal(finished.code, 0, finished.stderr);
    for (const line of finished.lines) assert.equal(JSON.parse(line).jsonrpc, '2.0', 'stdout carries protocol messages only');
    assert.match(finished.stderr, /akrs mcp/);

    // a modern-only process: no initialize at all
    const modern = spawnInstalledServer(installed.binPath, project.root);
    const found = await modern.request('server/discover', { _meta: modernMeta() });
    assert.deepEqual(found.result.supportedVersions, [MODERN]);
    const template = await modern.request('tools/call', { name: 'akrs_road', arguments: { action: 'template', kind: 'road' }, _meta: modernMeta() });
    assert.equal(template.result.structuredContent.command, 'template');
    assert.equal((await modern.request('tools/list')).error.code, -32022, 'neither an initialize nor a version: the modern error names what to send');
    assert.equal((await modern.finish()).code, 0);

    // the MCP loops left a workflow that validates like the CLI loops
    assert.equal((await project.run(['state', 'render'])).packet.status, 'ok');
    const validated = await project.run(['validate']);
    assert.deepEqual([validated.packet.status, validated.packet.findings], ['ok', []]);
  });

  await t.test('the nine agent adapters: setup --dry-run lists the golden files for each agent, changes no byte, and the written configs point at the installed package', async () => {
    const project = await createProject(sandbox, installed, 'agents');
    await project.run(['init', '--scaffold']);
    await project.commit('baseline');
    const skills = (await readdir(join(installed.packageRoot, 'docs', 'framework', 'skills'))).filter((name) => name.endsWith('.md') && name !== 'README.md').map((name) => name.slice(0, -3)).sort();
    assert.ok(skills.length >= 6, 'the six packaged skills are installed');
    const goldenFiles = async (agent) => {
      const found = [];
      const walk = async (directory, prefix) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isDirectory()) await walk(join(directory, entry.name), `${prefix}${entry.name}/`);
          else found.push(`${prefix}${entry.name}`);
        }
      };
      await walk(join(GOLDEN_AGENTS, agent), '');
      return found;
    };
    // the committed golden tree uses two fixture skills; the installed package has all of its skills
    const expectedFor = async (agent) => {
      const names = await goldenFiles(agent);
      const out = new Set();
      for (const path of names) {
        const match = /^(.*\/)akrs-(?:close-out|live-verify)\/SKILL\.md$/.exec(path);
        if (match) for (const skill of skills) out.add(`${match[1]}${skill}/SKILL.md`);
        else out.add(path);
      }
      return [...out].sort();
    };
    const before = await digestTree(project.root);
    for (const agent of ALL_AGENTS) {
      const dry = await project.run(['agents', 'setup', '--agent', agent, '--dry-run']);
      assert.deepEqual([dry.packet.status, dry.packet.data.dry_run, dry.packet.data.applied], ['ok', true, false], agent);
      assert.deepEqual(dry.packet.data.files.map(({ path }) => path).sort(), await expectedFor(agent), `${agent}: the files setup would write`);
      assert.equal(await digestTree(project.root), before, `${agent}: a dry run changes no byte`);
    }
    const all = await project.run(['agents', 'setup']);
    assert.equal(all.packet.status, 'ok', JSON.stringify(all.packet.findings));
    assert.deepEqual(all.packet.data.agents, ALL_AGENTS);
    const doctor = await project.run(['agents', 'doctor']);
    assert.deepEqual([doctor.packet.status, doctor.packet.findings], ['ok', []]);
    assert.equal((await project.run(['agents', 'setup'])).packet.status, 'noop', 'a second setup is a noop');

    const mcp = await project.readJson('.mcp.json');
    const entry = mcp.mcpServers.akrs;
    assert.equal(entry.command, 'node');
    assert.equal(entry.args[0].replaceAll('\\', '/'), installed.binPath.replaceAll('\\', '/'), 'the MCP entry launches the installed bin');
    assert.ok((await stat(entry.args[0])).isFile());
    const hook = JSON.stringify(await project.readJson('.claude/settings.local.json'));
    assert.ok(hook.includes('akrs-guard.js'), 'Claude Code gets the pre-write guard hook');
    const guard = join(installed.packageRoot, 'bin', 'akrs-guard.js').replaceAll('\\', '/');
    assert.ok(hook.replaceAll('\\\\', '/').includes(guard), 'the hook runs the installed guard');
  });

  await t.test('the pre-write guard from the installed package denies outside the lease and CLI-owned state, and allows the declared write', async () => {
    const project = await createProject(sandbox, installed, 'guard');
    await leaderSetup(project);
    assert.equal((await project.agent(['work'])).packet.status, 'ok');
    const guard = (path) => runNode([join(installed.packageRoot, 'bin', 'akrs-guard.js'), path, '--executor', 'worker'], { cwd: project.root, timeoutMs: 30_000 });
    const allowed = await guard('README.md');
    assert.deepEqual([allowed.exitCode, JSON.parse(allowed.stdout.trim().split('\n').at(-1)).decision ?? 'allow'], [0, 'allow']);
    const outside = await guard('src/other.js');
    assert.equal(outside.exitCode, 2);
    assert.match(outside.stderr, /outside the declared writes/);
    const owned = await guard('akrs/roads/R1.json');
    assert.equal(owned.exitCode, 2);
    assert.match(owned.stderr, /CLI-owned/);
    assert.equal((await guard('akrs/drafts/note.json')).exitCode, 0, 'drafts are the agent\'s to write');
  });

  await t.test('the offline board from the installed package: one self-contained page with a CSP, no network reference, written only to the cache', async () => {
    const project = loops.project;
    const treeBefore = await digestTree(project.root, { skip: ['.git', 'akrs/.cache'] });
    const view = await project.run(['view']);
    assert.equal(view.packet.status, 'ok', JSON.stringify(view.packet.findings));
    assert.deepEqual(view.packet.changed, ['akrs/.cache/view/index.html']);
    const html = await project.read('akrs/.cache/view/index.html');
    assert.match(html, /<meta http-equiv="Content-Security-Policy"/);
    assert.match(html, /default-src 'none'/);
    assert.equal(/<(?:script|link|img|iframe|object|embed|source|video|audio)\b[^>]*(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i.test(html), false, 'no external reference');
    assert.equal(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/.test(html), false, 'no network call in the page code');
    assert.equal(/innerHTML|outerHTML|document\.write|eval\(/.test(html), false, 'the page code writes text only');
    assert.ok(html.includes(loops.road), 'the board shows the Road');
    assert.equal(await digestTree(project.root, { skip: ['.git', 'akrs/.cache'] }), treeBefore, 'view writes nothing but its cache');
  });

  sandbox.assertAllInside();
  await sandbox.cleanup();
  await assert.rejects(stat(sandbox.root), { code: 'ENOENT' });
  assert.deepEqual(await repositoryTarballs(), tarballsBefore, 'no .tgz may be left in the repository');
  const statusAfter = await gitStatus();
  if (statusBefore !== null && statusAfter !== null) assert.equal(statusAfter, statusBefore, 'git status --short changed during the gate');
});
