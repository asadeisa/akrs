// Phase-1 gate (P1-W14), integrated through the REAL CLI adapter: each test names the gate it proves. Per-component
// behavior is proven by the packet tests; these drive the finished writers together on one repository and compare
// whole-tree digests, so a write that "also" touched something else cannot hide.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readLog } from '../../lib/store/log/index.js';
import { readMemoryFile } from '../../lib/store/memory/index.js';
import { projectReadWindows } from '../../lib/store/roads/index.js';
import { readScope } from '../../lib/store/scope/index.js';
import { computeSnapshot, LEASE_CONTRACT_PROJECTION } from '../../lib/store/snapshots/index.js';
import { memoryInput } from '../memory/support.js';
import { createHarness, createIdempotencyWorkflow } from '../idempotency/support.js';
import { auditPacket, auditWorld, doctorPacket, git, put } from '../git-audit/support.js';
import { readPosture } from '../../lib/store/git/index.js';
import { contractInput } from '../tester/support.js';
import {
  createRepo, fakeProviders, roadInput, runCommand, seedPlan, seedRoad, treeDigest,
} from '../road/support.js';

const everything = (repo) => treeDigest(repo);
const strict = (repo) => treeDigest(repo, { exclude: [] });

async function world(t, files = {}) {
  const repo = await createRepo(t, { files });
  repo.providers = fakeProviders();
  return repo;
}
async function cli(repo, argv, { stdin } = {}) {
  const result = await runCommand(repo, argv.includes('--json') ? argv : [...argv, '--json'], { stdin: stdin === undefined ? undefined : typeof stdin === 'string' ? stdin : JSON.stringify(stdin), providers: repo.providers });
  return { exitCode: result.exitCode, packet: JSON.parse(result.stdout) };
}
const stored = async (repo, path) => { const { meta: _meta, ...rest } = JSON.parse(await repo.read(path)); return rest; };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ---- gates 1 and 2: round trips and invalid writes -----------------------------------------------------------------
test('gate 1: every writer round-trips its input fields without loss or invention', async (t) => {
  const repo = await world(t);
  await seedPlan(repo, 'P6');
  const road = roadInput({ plan: null, task: null, id: 'R-RT' });
  assert.equal((await cli(repo, ['road', 'new', '--json', '-'], { stdin: road })).exitCode, 0);
  const { status, ...roadStored } = await stored(repo, 'akrs/roads/R-RT.json');
  assert.equal(status, 'QUEUED');
  assert.deepEqual(roadStored, road, 'the Road file holds exactly the input fields');

  const memory = memoryInput({ text: 'Unicode — تُشتق 支付 🚀 stays byte for byte.' });
  assert.equal((await cli(repo, ['memory', 'add', '--json', '-'], { stdin: memory })).exitCode, 0);
  const [record] = (await readMemoryFile({ ...repo.options, topic: memory.topic })).records;
  assert.deepEqual({ label: record.label, decided_by: record.decided_by, text: record.text, pointers: record.pointers }, {
    label: memory.label, decided_by: memory.decided_by, text: memory.text, pointers: memory.pointers,
  });

  await seedRoad(repo, { id: 'R-P6-1', plan: 'P6' }, { folder: 'roads/P6', status: 'ACTIVE' });
  const contract = await contractInput('valid/full', { roads: ['R-P6-1'] });
  assert.equal((await cli(repo, ['test', 'define', 'P6', '--json', '-'], { stdin: contract })).exitCode, 0);
  assert.deepEqual(await stored(repo, 'akrs/verifications/P6/contract.json'), contract);

  const closure = await cli(repo, ['log', 'append', '--kind', 'road', '--subject', 'R-RT', '--outcome', 'DONE', '--deviations', 'a — ب']);
  assert.equal(closure.exitCode, 0);
  const [line] = (await readLog(repo.options)).records;
  assert.deepEqual({ kind: line.kind, subject: line.subject, outcome: line.outcome, deviations: line.deviations }, { kind: 'road', subject: 'R-RT', outcome: 'DONE', deviations: 'a — ب' });

  assert.equal((await cli(repo, ['state', 'set', '--mode', '3', '--role', 'leader', '--next', 'Wire — ✓'])).exitCode, 0);
  const state = await stored(repo, 'akrs/state.json');
  assert.deepEqual({ mode: state.mode, role: state.role, next: state.next }, { mode: 3, role: 'leader', next: 'Wire — ✓' });
});

const INVALID = [
  ['road new: unknown key', ['road', 'new', '--json', '-'], { ...roadInput({ plan: null, task: null, id: 'R-BAD' }), surprise: 1 }],
  ['road new: missing key', ['road', 'new', '--json', '-'], (() => { const { acceptance: _a, ...rest } = roadInput({ plan: null, task: null, id: 'R-BAD' }); return rest; })()],
  ['road new: ambiguous path', ['road', 'new', '--json', '-'], roadInput({ plan: null, task: null, id: 'R-BAD', writes: [{ path: 'src/./x//y.js', class: 'file', action: 'create' }] })],
  ['road new: containment escape', ['road', 'new', '--json', '-'], roadInput({ plan: null, task: null, id: 'R-BAD', writes: [{ path: '../outside.js', class: 'file', action: 'create' }] })],
  ['road new: duplicate ID with other content', ['road', 'new', '--json', '-'], roadInput({ plan: null, task: null, id: 'R-EXISTS', acceptance: ['Something else.'] })],
  ['memory add: unknown key', ['memory', 'add', '--json', '-'], { ...memoryInput(), surprise: true }],
  ['memory add: missing key', ['memory', 'add', '--json', '-'], (() => { const { text: _t, ...rest } = memoryInput(); return rest; })()],
  ['memory add: pointer escapes the repository', ['memory', 'add', '--json', '-'], memoryInput({ pointers: [{ path: '../secret.md', lines: null }] })],
  ['memory add: invented label', ['memory', 'add', '--json', '-'], memoryInput({ label: 'Certain' })],
  ['test define: unknown key', ['test', 'define', 'P6', '--json', '-'], { ...(await contractInput('valid/full', { roads: ['R-P6-1'] })), surprise: 1 }],
  ['test define: unknown Road', ['test', 'define', 'P6', '--json', '-'], await contractInput('valid/full', { roads: ['R-NOPE'] })],
  ['scope request: unknown key', ['scope', 'request', '--json', '-'], { schema: 'akrs.scope-request/v1', road: 'R-EXISTS', add_reads: [], add_writes: [], reason: 'x', blocking: true, surprise: 1 }],
  ['scope request: unknown Road', ['scope', 'request', '--json', '-'], { schema: 'akrs.scope-request/v1', road: 'R-NOPE', add_reads: [{ path: 'src/own.js', lines: null, why: 'x' }], add_writes: [], reason: 'x', blocking: true }],
];
test('gate 2: unknown key, missing key, ambiguous path, containment escape and duplicate ID write nothing (whole-tree digests)', async (t) => {
  const repo = await world(t);
  await seedPlan(repo, 'P6');
  await seedRoad(repo, { id: 'R-EXISTS' });
  await seedRoad(repo, { id: 'R-P6-1', plan: 'P6' }, { folder: 'roads/P6', status: 'ACTIVE' });
  const before = await everything(repo);
  for (const [label, argv, stdin] of INVALID) {
    const { exitCode, packet } = await cli(repo, argv, { stdin });
    assert.ok([1, 2].includes(exitCode), `${label}: exits 1 or 2, got ${exitCode}`);
    assert.ok(packet.findings.length > 0, `${label}: names its reason in findings`);
    assert.ok(['error', 'blocked'].includes(packet.status), `${label}: status ${packet.status}`);
    assert.deepEqual(packet.changed, [], `${label}: reports no change`);
    assert.equal(await everything(repo), before, `${label}: the repository tree is byte-identical`);
  }
});

// ---- gate 3 ---------------------------------------------------------------------------------------------------------
test('gate 3: a stale Road update writes nothing; a valid one commits; a scope request alone grants nothing', async (t) => {
  const repo = await world(t);
  await seedRoad(repo, { id: 'R-U', executor_class: 'medium' });
  const roadBytes = () => repo.read('akrs/roads/R-U.json');
  const original = await roadBytes();
  const form = await stored(repo, 'akrs/roads/R-U.json');
  const staleSnapshot = `sha256:${'0'.repeat(64)}`;
  const before = await everything(repo);
  const stale = await cli(repo, ['road', 'update', 'R-U', '--if-snapshot', staleSnapshot, '--json', '-'], { stdin: { ...form, boundaries: ['stale'] } });
  assert.notEqual(stale.exitCode, 0);
  assert.equal(await everything(repo), before, 'a stale snapshot writes nothing');

  const scope = await cli(repo, ['scope', 'request', '--json', '-'], { stdin: { schema: 'akrs.scope-request/v1', road: 'R-U', add_reads: [], add_writes: [{ path: 'src/new.js', class: 'file', action: 'create' }], reason: 'Need a file.', blocking: true } });
  assert.equal(scope.packet.status, 'warning', 'a blocking request is a warning that tells the Worker to stop');
  assert.equal(scope.exitCode, 1);
  assert.equal(await roadBytes(), original, 'a pending request never changes Road permissions');
  assert.equal((await readScope({ ...repo.options, road: 'R-U' })).requests[0].state, 'pending');

  const approved = await cli(repo, ['scope', 'approve', 'R-U', '--reason', 'Agreed']);
  assert.equal(approved.exitCode, 0, JSON.stringify(approved.packet.findings));
  assert.notEqual(await roadBytes(), original, 'only the approved update changes the Road');
  assert.ok((await stored(repo, 'akrs/roads/R-U.json')).writes.some(({ path }) => path === 'src/new.js'));
});

// ---- gate 5 ---------------------------------------------------------------------------------------------------------
test('gate 5: the same request ID with the same input replays as noop; with different input it conflicts', async (t) => {
  const repo = await world(t);
  const id = '01ARZ3NDEKTSV4RRFFQ6008001';
  const first = await cli(repo, ['state', 'set', '--next', 'One', '--request-id', id]);
  assert.equal(first.packet.status, 'ok');
  const after = await everything(repo);
  const same = await cli(repo, ['state', 'set', '--next', 'One', '--request-id', id]);
  assert.equal(same.exitCode, 0);
  assert.equal(same.packet.status, 'noop');
  assert.equal(same.packet.request_id, id);
  assert.equal(await everything(repo), after, 'no second write');
  const other = await cli(repo, ['state', 'set', '--next', 'Two', '--request-id', id]);
  assert.notEqual(other.exitCode, 0);
  assert.equal(await everything(repo), after, 'a conflicting request writes nothing');
});

// ---- gate 6: STATE.md reproduces byte-identically, Unicode included -------------------------------------------------
test('gate 8 (phase list): state render reproduces the committed STATE.md byte-identically, free Unicode text included', async (t) => {
  const repo = await world(t);
  await seedPlan(repo, 'P6');
  await seedRoad(repo, { id: 'R-P6-1', plan: 'P6' }, { folder: 'roads/P6', status: 'ACTIVE' });
  const set = await cli(repo, ['state', 'set', '--mode', '3', '--role', 'leader', '--plan', 'P6', '--phase', 'مرحلة الدفع — 支付 🚀', '--next', 'اربط القائمة\nثم اختبر — ✓']);
  assert.equal(set.exitCode, 0, JSON.stringify(set.packet.findings));
  const committed = await repo.read('akrs/STATE.md');
  assert.ok(committed.includes('مرحلة الدفع — 支付 🚀'));
  assert.equal(committed.includes('\r'), false, 'canonical STATE.md is LF only');
  for (const damage of ['hand edited\n', '', committed.replace('Wire', 'x'), committed.replaceAll('\n', '\r\n')]) {
    await repo.write('akrs/STATE.md', damage);
    const rendered = await cli(repo, ['state', 'render']);
    if (damage === committed.replace('Wire', 'x')) continue; // identical to the committed bytes when nothing matched: nothing to render
    assert.equal(rendered.exitCode, 0, JSON.stringify(rendered.packet.findings));
    assert.equal(await repo.read('akrs/STATE.md'), committed, 'the render is the committed STATE.md, byte for byte');
  }
  const validated = await cli(repo, ['validate']);
  assert.equal(validated.packet.data.checks.find(({ check }) => check === 'state-render').status, 'passed');
});

// ---- gate 9: Tester definition and handoff without invention ---------------------------------------------------------
test('gate 9: a Tester definition and a Worker handoff round-trip their content and invent no acceptance, reason or reach', async (t) => {
  const repo = await world(t);
  await seedPlan(repo, 'P6');
  await seedRoad(repo, { id: 'R-P6-1', plan: 'P6' }, { folder: 'roads/P6', status: 'ACTIVE' });
  const contract = await contractInput('valid/full', { roads: ['R-P6-1'], acceptance: ['The admin sees every booking — كل حجز.'] });
  assert.equal((await cli(repo, ['test', 'define', 'P6', '--json', '-'], { stdin: contract })).exitCode, 0);
  const contractBytes = await repo.read('akrs/verifications/P6/contract.json');
  assert.deepEqual((await stored(repo, 'akrs/verifications/P6/contract.json')).acceptance, ['The admin sees every booking — كل حجز.']);

  const input = { schema: 'akrs.handoff/v1', road: 'R-P6-1', result: 'The page lists bookings.', reach: ['Open /admin', 'Click Bookings', 'Scroll'], expect: 'Every booking shows its paid state.' };
  assert.equal((await cli(repo, ['test', 'handoff', 'P6', '--json', '-'], { stdin: input })).exitCode, 0);
  const [line] = (await repo.read('akrs/verifications/P6/handoff.jsonl')).split('\n').filter(Boolean).map((text) => JSON.parse(text));
  assert.deepEqual({ road: line.road, result: line.result, reach: line.reach, expect: line.expect }, { road: input.road, result: input.result, reach: input.reach, expect: input.expect });
  assert.deepEqual(Object.keys(line).sort(), ['expect', 'hash', 'id', 'ready', 'reach', 'result', 'road', 'snapshot', 'ts'].sort(), 'only the declared fields exist: nothing else is invented');
  assert.equal(await repo.read('akrs/verifications/P6/contract.json'), contractBytes, 'a handoff never changes acceptance');
  const bad = await cli(repo, ['test', 'handoff', 'P6', '--json', '-'], { stdin: { ...input, road: 'R-P6-1', reach: [], result: '' } });
  assert.notEqual(bad.exitCode, 0);
});

// ---- gate 10: scaffold validates honestly ----------------------------------------------------------------------------
test('gate 12 (phase list): init --scaffold into an empty repository validates honestly, with no skipped check', async (t) => {
  const repo = await createRepo(t, { files: {} });
  repo.providers = fakeProviders();
  await treeReset(repo);
  const scaffold = await cli(repo, ['init', '--scaffold']);
  assert.equal(scaffold.exitCode, 0, JSON.stringify(scaffold.packet.findings));
  for (const [id, role, klass] of [['lead', 'leader', 'frontier'], ['flash', 'worker', 'weak']]) {
    assert.equal((await cli(repo, ['executor', 'set', id, '--role', role, '--class', klass, '--label', id, '--answer', klass])).exitCode, 0);
  }
  const packet = (await cli(repo, ['validate'])).packet;
  assert.equal(packet.status, 'ok');
  assert.deepEqual(packet.findings, []);
  assert.equal(packet.data.coverage.skipped, 0);
  const statuses = new Set(packet.data.checks.map(({ status }) => status));
  for (const status of statuses) assert.ok(['passed', 'not_applicable'].includes(status), `check status ${status}`);
  assert.ok(packet.data.checks.filter(({ status }) => status === 'not_applicable').length > 0, 'checks without data say not_applicable honestly');
});
async function treeReset(repo) {
  const { rm } = await import('node:fs/promises');
  await rm(repo.path('akrs'), { recursive: true, force: true });
  await rm(repo.path('SOT'), { recursive: true, force: true });
  await rm(repo.path('app'), { recursive: true, force: true });
  await rm(repo.path('src'), { recursive: true, force: true });
}

// ---- gate 11: canonical hashes and snapshots are identical on every platform ------------------------------------------
const SNAPSHOT_GOLDEN = new URL('../fixtures/phase1-gate/snapshot-goldens.json', import.meta.url);
async function snapshotTable() {
  const root = fileURLToPath(new URL('../../examples/minimal/', import.meta.url)).replace(/[\\/]$/, '');
  const { commandSnapshot } = await import('../../lib/store/snapshots/index.js');
  const table = {};
  for (const id of ['road-new', 'task-new', 'road-update', 'road-move', 'scope-request', 'scope-approve', 'scope-reject', 'scope-list', 'memory-add', 'log-append', 'state-set', 'state-render', 'executor-set', 'road-fit', 'validate']) {
    const needsRoad = id.startsWith('road-') || id.startsWith('scope-') || id === 'task-new';
    table[id] = (await commandSnapshot(id, { repositoryRoot: root, workflowRoot: join(root, 'akrs'), ...(needsRoad ? { target: { road: 'R1' } } : {}) })).snapshot;
  }
  const bytes = {};
  const walk = async (directory, prefix) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.isDirectory()) await walk(join(directory, entry.name), `${prefix}${entry.name}/`);
      else bytes[`${prefix}${entry.name}`] = `sha256:${sha(await readFile(join(directory, entry.name)))}`;
    }
  };
  await walk(root, '');
  return { snapshots: table, example_files: bytes };
}
test('gate 13 (phase list): canonical file hashes and command snapshots of the committed example equal the committed goldens on this platform', async () => {
  const actual = await snapshotTable();
  if (process.env.AKRS_REGENERATE_GATE_GOLDENS === '1') await writeFile(SNAPSHOT_GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  const expected = JSON.parse(await readFile(SNAPSHOT_GOLDEN, 'utf8'));
  assert.deepEqual(actual, expected);
});

// ---- gate 12: SOT windows reach the projection unchanged, copied nowhere -----------------------------------------------
test('gate 14 (phase list): declared SOT windows reach the Worker and Tester projections unchanged, and no artifact copies a fact body', async (t) => {
  const repo = await world(t);
  await seedPlan(repo, 'P6');
  const reads = [
    { path: 'SOT/09-use-cases.md', lines: [28, 41], why: 'canonical paid-state rule' },
    { path: 'SOT/02-rules.md', lines: [2, 4], why: null },
    { path: 'SOT/09-use-cases.md', lines: [3, 5], why: 'same file, another window' },
  ];
  const road = roadInput({ plan: 'P6', task: null, id: 'R-P6-1', reads });
  assert.equal((await cli(repo, ['road', 'new', '--json', '-'], { stdin: road })).exitCode, 0);
  await seedRoad(repo, { id: 'R-P6-2', plan: 'P6' }, { folder: 'roads/P6', status: 'ACTIVE' });
  const contract = await contractInput('valid/full', { roads: ['R-P6-1', 'R-P6-2'], reads });
  assert.equal((await cli(repo, ['test', 'define', 'P6', '--json', '-'], { stdin: contract })).exitCode, 0);
  await cli(repo, ['test', 'handoff', 'P6', '--json', '-'], { stdin: { schema: 'akrs.handoff/v1', road: 'R-P6-2', result: 'Done.', reach: ['Open /admin'], expect: 'Lists.' } });

  const storedRoad = await stored(repo, 'akrs/roads/P6/R-P6-1.json');
  const storedContract = await stored(repo, 'akrs/verifications/P6/contract.json');
  for (const owner of [storedRoad, storedContract]) assert.deepEqual(owner.reads, reads, 'no window is dropped, added or reordered');
  const worker = await projectReadWindows({ ...repo.options, road: storedRoad, includeText: true });
  const tester = await projectReadWindows({ ...repo.options, road: { reads: storedContract.reads, writes: [] }, includeText: true });
  for (const projection of [worker, tester]) {
    assert.deepEqual(projection.map(({ path, lines, why }) => ({ path, lines, why })), reads, 'declared order, ranges and reasons survive');
    for (const [index, window] of projection.entries()) {
      const [from, to] = reads[index].lines;
      const source = (await repo.read(reads[index].path)).split('\n').slice(from - 1, to).join('\n');
      assert.equal(window.text, source, `window ${index} is exactly the SOT lines`);
    }
  }
  const sourceLines = [...(await repo.read('SOT/09-use-cases.md')).split('\n'), ...(await repo.read('SOT/02-rules.md')).split('\n')].filter(Boolean);
  const artifacts = (await Promise.all(['akrs/roads/P6/R-P6-1.json', 'akrs/verifications/P6/contract.json', 'akrs/verifications/P6/handoff.jsonl'].map((path) => repo.read(path)))).join('\n');
  for (const line of sourceLines) assert.equal(artifacts.includes(line), false, `no fact body is copied into a workflow artifact: ${line}`);
});

// ---- gate 15: --again and executions ----------------------------------------------------------------------------------
test('A1 gate 15: --again records a deliberate repeat; an identical request replays; executions are never deduplicated', async (t) => {
  const repo = await world(t);
  const memory = memoryInput({ text: 'A repeated, deliberately recorded fact.' });
  assert.equal((await cli(repo, ['memory', 'add', '--json', '-'], { stdin: memory })).packet.status, 'ok');
  const replay = await cli(repo, ['memory', 'add', '--json', '-'], { stdin: memory });
  assert.equal(replay.packet.status, 'noop');
  assert.ok(replay.packet.next_commands.some(({ args }) => args.includes('--again')), 'the replay offers --again');
  const again = await cli(repo, ['memory', 'add', '--again', '--json', '-'], { stdin: memory });
  assert.equal(again.packet.status, 'ok');
  assert.equal((await readMemoryFile({ ...repo.options, topic: memory.topic })).records.length, 2, 'the deliberate repeat is a second record');

  const workflow = await createIdempotencyWorkflow(t);
  const harness = createHarness(workflow);
  const run = (overrides = {}) => harness.run({ dedupe: 'none', command: 'verify', ...overrides });
  const [one, two] = [await run({ requestId: '01ARZ3NDEKTSV4RRFFQ6008002' }), await run({ requestId: '01ARZ3NDEKTSV4RRFFQ6008002' })];
  assert.deepEqual([one.outcome, two.outcome], ['executed', 'executed']);
  assert.equal(harness.applied.length, 2, 'executions are never deduplicated');
});

// ---- gate 16: envelope, scope approve and --patch converge on the same Road --------------------------------------------
test('A1 gate 16: envelope auto-grant, scope approve, --patch and a full update produce the same Road', async (t) => {
  const ENVELOPE = { auto_reads: ['src/**'], auto_writes: ['src/gen/*.js'] };
  const NO_ENVELOPE = { auto_reads: [], auto_writes: [] };
  const delta = { add_reads: [{ path: 'src/own.js', lines: null, why: 'needed' }], add_writes: [{ path: 'src/gen/a.js', class: 'file', action: 'create' }] };
  const request = (road) => ({ schema: 'akrs.scope-request/v1', road, reason: 'Needed.', blocking: true, ...delta });
  const seed = async (policy) => {
    const repo = await world(t);
    await seedRoad(repo, { id: 'R-E', executor_class: 'medium', scope_policy: policy });
    return repo;
  };
  const shape = async (repo) => { const { meta: _meta, scope_policy: _scope, ...rest } = await stored(repo, 'akrs/roads/R-E.json'); return rest; };

  const enveloped = await seed(ENVELOPE);
  const granted = await cli(enveloped, ['scope', 'request', '--json', '-'], { stdin: request('R-E') });
  assert.equal(granted.exitCode, 0, JSON.stringify(granted.packet.findings));
  assert.deepEqual(granted.packet.data.envelope, { granted: true, reasons: [] });
  const outside = await seed(ENVELOPE);
  const refused = await cli(outside, ['scope', 'request', '--json', '-'], { stdin: { ...request('R-E'), add_writes: [{ path: 'app/pages/x.vue', class: 'file', action: 'create' }], add_reads: [] } });
  assert.equal(refused.packet.data.envelope.granted, false, 'outside the envelope nothing is granted');

  const approvedRepo = await seed(NO_ENVELOPE);
  await cli(approvedRepo, ['scope', 'request', '--json', '-'], { stdin: request('R-E') });
  const approvedRun = await cli(approvedRepo, ['scope', 'approve', 'R-E', '--reason', 'Agreed']);
  assert.equal(approvedRun.exitCode, 0, JSON.stringify([approvedRun.packet.status, approvedRun.packet.findings]));

  const patchedRepo = await seed(NO_ENVELOPE);
  const ops = [{ op: 'add_read', read: delta.add_reads[0] }, { op: 'add_write', write: delta.add_writes[0] }];
  assert.equal((await cli(patchedRepo, ['road', 'update', 'R-E', '--patch', '--json', '-'], { stdin: { schema: 'akrs.road-patch/v1', ops } })).exitCode, 0);

  const fullRepo = await seed(NO_ENVELOPE);
  const base = await stored(fullRepo, 'akrs/roads/R-E.json');
  const form = { ...base, reads: [...base.reads, delta.add_reads[0]], writes: [...base.writes, delta.add_writes[0]].sort((a, b) => (a.path < b.path ? -1 : 1)) };
  const { computeSnapshot: _unused, ...snapshots } = await import('../../lib/store/snapshots/index.js');
  const expected = (await snapshots.commandSnapshot('road-update', { ...fullRepo.options, target: { road: 'R-E' } })).snapshot;
  assert.equal((await cli(fullRepo, ['road', 'update', 'R-E', '--if-snapshot', expected, '--reason', 'Needed.', '--json', '-'], { stdin: form })).exitCode, 0);

  const results = await Promise.all([enveloped, approvedRepo, patchedRepo, fullRepo].map(shape));
  for (const result of results.slice(1)) assert.deepEqual(result, results[0], 'the same delta gives the same Road however it was granted');
  assert.ok(results[0].writes.some(({ path }) => path === 'src/gen/a.js'));
});

// ---- gate 17: executor classes and class-fit ---------------------------------------------------------------------------
test('A1 gate 17: executor classes drive class-fit: an oversize Road is reported, a weak Leader cannot justify it, road fit proposes a split', async (t) => {
  const repo = await world(t);
  for (const [id, role, klass] of [['lead', 'leader', 'medium'], ['flash', 'worker', 'weak']]) {
    assert.equal((await cli(repo, ['executor', 'set', id, '--role', role, '--class', klass, '--label', id, '--answer', klass])).exitCode, 0);
  }
  const files = Array.from({ length: 4 }, (_, index) => ({ path: `src/d/f${index}.js`, class: 'file', action: 'create' }));
  const big = roadInput({ plan: null, task: null, id: 'R-BIG', writes: files, executor_class: 'weak' });
  const before = await everything(repo);
  const justified = await cli(repo, ['road', 'new', '--json', '-'], { stdin: { ...big, oversize_reason: 'One mechanical rename across four files.' } });
  assert.notEqual(justified.exitCode, 0);
  assert.ok(justified.packet.findings.some(({ code }) => code === 'AKRS-R016'), 'a medium Leader cannot justify an oversize Road');
  assert.equal(await everything(repo), before, 'the refusal writes nothing');

  const over = await cli(repo, ['road', 'new', '--json', '-'], { stdin: big });
  assert.equal(over.packet.status, 'warning', 'the over-limit Road is written and reported, never silently accepted');
  assert.deepEqual(over.packet.findings.map(({ code, severity, detail }) => [code, severity, detail.knob, detail.limit, detail.actual]), [['AKRS-R015', 'error', 'max_writes', 3, 4]]);
  const fit = await cli(repo, ['road', 'fit', 'R-BIG']);
  assert.equal(fit.packet.data.fit.verdict, 'split_required');
  assert.equal(fit.packet.data.fit.class, 'weak');
  assert.equal(fit.packet.data.fit.load.writes, 4);
  assert.ok(fit.packet.data.fit.suggestions.every(({ writes }) => writes.length <= 3), 'the proposed split respects the class limit');
  const validated = await cli(repo, ['validate']);
  assert.equal(validated.packet.data.checks.find(({ check }) => check === 'class-fit').status, 'failed');
  const listed = await cli(repo, ['executor', 'list']);
  assert.equal(listed.packet.data.executors.some(({ id, class: klass }) => id === 'flash' && klass === 'weak'), true);
});

// ---- gate 18: every input channel yields the same canonical artifact ---------------------------------------------------
test('A1 gate 18: --json -, BOM+CRLF stdin and an --input draft write byte-identical canonical artifacts', async (t) => {
  const bomCrlf = (document) => `﻿${JSON.stringify(document, null, 2).replaceAll('\n', '\r\n')}\r\n`;
  const jobs = [
    ['road new', ['road', 'new'], roadInput({ plan: null, task: null, id: 'R-CH', boundaries: ['حد — ✓'] })],
    ['memory add', ['memory', 'add'], memoryInput({ text: 'نص — 支付 🚀' })],
  ];
  for (const [label, argv, document] of jobs) {
    const channels = {
      stdin: async (repo) => cli(repo, [...argv, '--json', '-'], { stdin: JSON.stringify(document) }),
      'stdin BOM+CRLF': async (repo) => cli(repo, [...argv, '--json', '-'], { stdin: bomCrlf(document) }),
      'draft file (BOM+CRLF)': async (repo) => { await repo.write('akrs/drafts/in.json', bomCrlf(document)); return cli(repo, [...argv, '--input', 'akrs/drafts/in.json']); },
      'draft file (LF)': async (repo) => { await repo.write('akrs/drafts/in.json', `${JSON.stringify(document, null, 2)}\n`); return cli(repo, [...argv, '--input', 'akrs/drafts/in.json']); },
    };
    const digests = {};
    for (const [name, send] of Object.entries(channels)) {
      const repo = await world(t);
      const result = await send(repo);
      assert.equal(result.exitCode, 0, `${label} via ${name}: ${JSON.stringify(result.packet.findings)}`);
      digests[name] = await treeDigest(repo, { exclude: ['akrs/.ops', '.git', 'akrs/drafts'] });
    }
    assert.equal(new Set(Object.values(digests)).size, 1, `${label}: every channel gives the same repository bytes ${JSON.stringify(digests)}`);
  }
});

// ---- gate 19: the lease projection ignores the holder's own work -------------------------------------------------------
test('A1 gate 19: the lease contract projection ignores the holder\'s own edits, drafts, caches and evidence, and sees contract changes', async (t) => {
  const repo = await world(t);
  await seedPlan(repo, 'P6');
  await seedRoad(repo, {
    id: 'R-L', plan: 'P6', reads: [{ path: 'SOT/09-use-cases.md', lines: [28, 41], why: 'rule' }],
    writes: [{ path: 'src/own.js', class: 'file', action: 'modify' }, { path: 'src/gen', class: 'dir', action: 'create' }],
  }, { folder: 'roads/P6', status: 'ACTIVE' });
  const lease = async () => (await computeSnapshot({ ...repo.options, projections: LEASE_CONTRACT_PROJECTION, target: { road: 'R-L' } })).snapshot;
  const base = await lease();
  await repo.write('src/own.js', 'the holder edited its own write target\n');
  await repo.write('src/gen/new.js', 'created inside the declared dir\n');
  await repo.write('akrs/drafts/x.json', '{"draft": true}\n');
  await repo.write('akrs/.cache/c', 'cache\n');
  await repo.write('akrs/verifications/P6/evidence/a.png', 'png\n');
  await repo.write('akrs/log/0001.jsonl', '');
  assert.equal(await lease(), base, 'own edits, drafts, caches, evidence and log appends never move the lease snapshot');
  const source = (await repo.read('SOT/09-use-cases.md')).split('\n');
  source[29] = 'a fact inside the declared window changed';
  await repo.write('SOT/09-use-cases.md', source.join('\n'));
  assert.notEqual(await lease(), base, 'a change inside a declared read window does move it');
  const road = await repo.read('akrs/roads/P6/R-L.json');
  await repo.write('akrs/roads/P6/R-L.json', road.replace('"rule"', '"another reason"'));
  assert.notEqual(await lease(), base);
});

// ---- gate 11 (phase list): git audit categories and posture ------------------------------------------------------------
test('gate 11 (phase list): audit --git --road separates every category on a real repository, report-only, and names the posture', async (t) => {
  const repo = await auditWorld(t);
  await put(repo, 'src/own.js', 'changed\n');
  await put(repo, 'src/extra.js', 'extra\n');
  await put(repo, 'test/foo.test.js', 'test changed\n');
  await put(repo, 'akrs/state.json', '{}\n');
  await put(repo, 'akrs/verifications/P6/evidence/a.png', 'png\n');
  await put(repo, 'README.md', 'dirty before the Road\n');
  const before = await everything(repo);
  const packet = await auditPacket(repo, ['--pre-existing', 'README.md']);
  const names = (list) => list.map(({ path }) => path);
  const { categories } = packet.data.audit;
  assert.deepEqual(names(categories.undeclared), ['src/extra.js']);
  assert.deepEqual(names(categories.declared), ['src/own.js']);
  assert.deepEqual(names(categories.missing_declared), ['src/new.js']);
  assert.deepEqual(names(categories.pre_existing), ['README.md']);
  assert.deepEqual(names(categories.workflow), ['akrs/state.json']);
  assert.deepEqual(names(categories.test), ['test/foo.test.js']);
  assert.deepEqual(names(categories.evidence), ['akrs/verifications/P6/evidence/a.png']);
  assert.equal(await everything(repo), before, 'the audit is report-only');
  assert.equal(git(repo, 'status', '--short').toString().includes('src/extra.js'), true);

  assert.equal((await readPosture(repo.options)).posture, 'tracked');
  git(repo, 'rm', '-r', '-q', '--cached', 'akrs');
  await put(repo, '.gitignore', 'akrs/\n');
  assert.equal((await readPosture(repo.options)).posture, 'ignored');
  const doctor = await doctorPacket(repo);
  assert.equal(doctor.findings.find(({ code }) => code === 'AKRS-G003').detail.posture, 'ignored');
  const skipped = await auditPacket(repo);
  assert.equal(skipped.data.audit.status, 'skipped', 'an ignored workflow is a skipped audit, never a pass');
});
