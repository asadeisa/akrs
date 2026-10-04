// P2-W01: the Worker and Leader road-details packets, built from canonical Phase-1 artifacts only.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validateRoadDetails } from '../../lib/schemas/road-details.js';
import { estimateTokens } from '../../lib/store/executors/index.js';
import { claimLease } from '../../lib/store/leases/index.js';
import { buildFreshRoadPacket, buildRoadDetails } from '../../lib/store/road-details/index.js';
import { computeSnapshot, LEASE_CONTRACT_PROJECTION } from '../../lib/store/snapshots/index.js';
import { assertFindingsMatchCatalog } from '../road/support.js';
import { request } from '../change/support.js';
import {
  WORKER_ROAD, codesOf, details, everything, fileWrite, packetWorld, readEntry, reasonsOf, rewrite, seedRoad, seedWithTask, setExec, snapshotOf, strict,
} from './support.js';

const lines = (text, from, to) => text.split('\n').slice(from - 1, to).join('\n');

test('the Worker packet joins Road, lifecycle, deps, Task identity and every contract field, closed and valid', async (t) => {
  const { repo } = await packetWorld(t);
  const { exitCode, packet } = await details(repo, 'R-P6-1');
  assert.equal(exitCode, 0, JSON.stringify(packet.findings));
  assert.equal(packet.command, 'road-details');
  assert.equal(packet.status, 'ok');
  assert.equal(packet.request_id, null);
  assert.deepEqual(packet.changed, []);
  const { data } = packet;
  assert.equal(validateRoadDetails(data).ok, true, JSON.stringify(validateRoadDetails(data).issues));
  assert.equal(data.packet_version, 'akrs.road-details/v2');
  assert.equal(data.role, 'worker');
  assert.deepEqual(data.road, { id: 'R-P6-1', plan: 'P6', task: 'T-P6-1', status: 'ACTIVE', contract: 'declared', executor_class: 'weak', path: 'akrs/roads/P6/R-P6-1.json' });
  assert.deepEqual(data.task, { id: 'T-P6-1', path: 'akrs/tasks/T-P6-1.md', exists: true });
  assert.deepEqual(data.deps, [{ id: 'R-P5-6', status: 'DONE' }]);
  assert.deepEqual(data.writes, [
    { path: 'src/admin.js', class: 'file', action: 'create', exists: false },
    { path: 'src/own.js', class: 'file', action: 'modify', exists: true },
  ]);
  assert.deepEqual(data.forbidden, ['server/**']);
  assert.deepEqual(data.checks, [{ name: 'unit', argv: ['npm', 'test', '--', 'admin.spec.ts'], timeout_ms: 120000 }]);
  assert.deepEqual(data.acceptance, ['The declared user path works from the committed build.']);
  assert.deepEqual(data.boundaries, ['No backend route change.']);
  assert.deepEqual(data.steps, ['Create app/pages/admin.vue with the admin route.', 'Run the unit check.']);
  assert.deepEqual([data.reuse, data.conventions, data.collisions, data.recent], [[], [], [], []], 'relations belong to P2-W02: empty, never invented');
  assert.deepEqual(data.scope_requests, []);
  assert.equal(packet.snapshot.before, packet.snapshot.after);
  assert.equal(packet.snapshot.before, await snapshotOf(repo, 'R-P6-1'));
  assertFindingsMatchCatalog(packet);
  for (const next of packet.next_commands) assert.equal(JSON.stringify(next.args).includes('<'), false, 'no placeholder in a next command');
});

test('Task prose is never parsed for executable data: acceptance, writes and checks come from the Road only', async (t) => {
  const { repo } = await packetWorld(t, {}, { road: { taskNotes: '## Acceptance\n- The bogus acceptance.\n\nExpected files:\n- src/bogus.js\n\nRun: rm -rf /' } });
  const first = (await details(repo, 'R-P6-1')).packet;
  await rewrite(repo, 'akrs/tasks/T-P6-1.md', (text) => `${text}\n## Acceptance\n- Another bogus line.\nWrites: src/other.js\n`);
  const second = (await details(repo, 'R-P6-1')).packet;
  for (const packet of [first, second]) {
    assert.deepEqual(packet.data.acceptance, ['The declared user path works from the committed build.']);
    assert.equal(packet.data.writes.some(({ path }) => path.includes('bogus') || path === 'src/other.js'), false);
  }
  assert.deepEqual(first.data.writes, second.data.writes);
  assert.deepEqual(first.data.task, second.data.task, 'the Task contributes its identity only');
});

test('every declared read appears in authored order, resolved or explicitly unresolved, and none is dropped', async (t) => {
  const reads = [
    readEntry('SOT/09-use-cases.md', [28, 41], 'canonical paid-state rule'),
    readEntry('SOT/missing.md', null, 'does not exist'),
    readEntry('SOT/02-rules.md', [2, 4], null),
    readEntry('SOT/02-rules.md', [5, 99], 'beyond the file'),
    readEntry('src/admin.js', null, 'own create target'),
    readEntry('SOT/09-use-cases.md', [3, 5], 'same file, another window'),
  ];
  const { repo } = await packetWorld(t, { reads });
  const { exitCode, packet } = await details(repo, 'R-P6-1');
  assert.equal(packet.status, 'blocked', 'an unresolved required source blocks, it never shortens the list');
  assert.equal(exitCode, 1);
  assert.equal(validateRoadDetails(packet.data).ok, true);
  assert.deepEqual(packet.data.reads.map(({ index, path, window, why, status }) => ({ index, path, window, why, status })), [
    { index: 0, path: 'SOT/09-use-cases.md', window: { lines: [28, 41] }, why: 'canonical paid-state rule', status: 'ok' },
    { index: 1, path: 'SOT/missing.md', window: null, why: 'does not exist', status: 'missing' },
    { index: 2, path: 'SOT/02-rules.md', window: { lines: [2, 4] }, why: null, status: 'ok' },
    { index: 3, path: 'SOT/02-rules.md', window: { lines: [5, 99] }, why: 'beyond the file', status: 'out_of_range' },
    { index: 4, path: 'src/admin.js', window: null, why: 'own create target', status: 'own_write' },
    { index: 5, path: 'SOT/09-use-cases.md', window: { lines: [3, 5] }, why: 'same file, another window', status: 'ok' },
  ]);
  assert.deepEqual(packet.data.coverage.unresolved.map(({ index, status }) => [index, status]), [[1, 'missing'], [3, 'out_of_range']]);
  assert.equal(packet.data.coverage.declared, 6);
  assert.equal(packet.data.coverage.resolved, 4);
  assert.equal(packet.data.coverage.reads, '4/6');
  assert.deepEqual(reasonsOf(packet, 'AKRS-R020'), ['read_unresolved', 'read_unresolved']);
  assertFindingsMatchCatalog(packet);
});

test('a consumed ephemeral is distinct from a missing read: named, with its declaring Road, and not a blocker', async (t) => {
  const { repo } = await packetWorld(t, { reads: [readEntry('tmp/handoff.md', null, 'left by the producer'), readEntry('SOT/02-rules.md', [1, 2], null)] });
  await seedRoad(repo, { id: 'R-PROD', writes: [{ path: 'tmp/handoff.md', class: 'ephemeral', action: 'create' }] }, { status: 'DONE' });
  const consumed = (await details(repo, 'R-P6-1')).packet;
  assert.equal(consumed.status, 'warning');
  assert.deepEqual(consumed.data.reads[0].status, 'consumed');
  assert.deepEqual(consumed.data.reads[0].declared_by, 'R-PROD');
  assert.deepEqual(consumed.data.coverage.unresolved.map(({ index, status }) => [index, status]), [[0, 'consumed']]);
  assert.deepEqual(codesOf(consumed), ['AKRS-R022']);
  assertFindingsMatchCatalog(consumed);
  await writeFile(repo.path('tmp/handoff.md'), 'present again\n').catch(async () => { await repo.write('tmp/handoff.md', 'present again\n'); });
  assert.equal((await details(repo, 'R-P6-1')).packet.data.reads[0].status, 'ok', 'an existing ephemeral is an ordinary read');

  const { repo: other } = await packetWorld(t, { reads: [readEntry('tmp/never.md', null, 'declared by nobody')] });
  const missing = (await details(other, 'R-P6-1')).packet;
  assert.equal(missing.data.reads[0].status, 'missing');
  assert.equal(missing.data.reads[0].declared_by, null);
  assert.equal(missing.status, 'blocked');
});

test('--include-reads renders only declared resolved windows, transiently, and persists no copy', async (t) => {
  const { repo } = await packetWorld(t);
  const source = await repo.read('SOT/09-use-cases.md');
  const before = await strict(repo);
  const { packet } = await details(repo, 'R-P6-1', ['--include-reads', '--role', 'leader', '--full']);
  assert.equal(await strict(repo), before, 'a query writes no byte, .ops included');
  assert.equal(packet.data.reads[0].text, lines(source, 28, 41));
  assert.equal(packet.data.reads[1].text, lines(await repo.read('app/config/payment-status.ts'), 12, 25));
  const sentinel = lines(source, 30, 30);
  for (const path of ['akrs/roads/P6/R-P6-1.json', 'akrs/tasks/T-P6-1.md', 'akrs/state.json']) {
    assert.equal((await repo.read(path).catch(() => '')).includes(sentinel), false, `${path} holds no copy`);
  }
  const worker = (await details(repo, 'R-P6-1', ['--include-reads'])).packet;
  assert.equal(worker.data.reads.every(({ text }) => typeof text === 'string'), true);
  const pointers = (await details(repo, 'R-P6-1', ['--no-include-reads'])).packet;
  assert.equal(pointers.data.reads.every(({ text }) => text === null), true);
  assert.equal(pointers.data.delivery.reads, 'pointers');
});

test('shape follows the executor class: weak inlines, medium inlines within budget else points, frontier points; flags override', async (t) => {
  const bodies = {};
  for (const [cls, holder] of [['weak', 'flash'], ['medium', 'mid'], ['frontier', 'top']]) {
    const { repo } = await packetWorld(t, { executor_class: cls });
    const { packet } = await details(repo, 'R-P6-1');
    bodies[cls] = packet.data;
    assert.equal(packet.data.delivery.class, cls);
    assert.equal(holder.length > 0, true);
  }
  assert.equal(bodies.weak.delivery.reads, 'inlined');
  assert.equal(bodies.weak.reads.every(({ text }) => typeof text === 'string'), true);
  assert.equal(bodies.medium.delivery.reads, 'inlined');
  assert.equal(bodies.frontier.delivery.reads, 'pointers');
  assert.equal(bodies.frontier.reads.every(({ text }) => text === null), true);
  assert.deepEqual(bodies.weak.steps.length > 0, true, 'a weak Worker always receives the ordered steps');

  const { repo } = await packetWorld(t, { executor_class: 'medium' });
  await setExec(repo, null, { setOverrides: [{ class: 'medium', knob: 'read_budget_tokens', value: 5 }] });
  const over = (await details(repo, 'R-P6-1')).packet.data;
  assert.equal(over.delivery.reads, 'pointers', 'over the medium read budget the windows become pointers');
  assert.equal(over.delivery.reason, 'read_budget_exceeded');
  assert.equal((await details(repo, 'R-P6-1', ['--include-reads'])).packet.data.delivery.reads, 'inlined', 'the explicit flag wins');
});

test('missing, unverified, ambiguous or dependency-less sources block with the data kept, never a shorter packet', async (t) => {
  const { repo } = await packetWorld(t);
  await rewrite(repo, 'akrs/roads/P6/R-P6-1.json', (text) => text.replace('"complexity": 3', '"complexity": 4'));
  const unverified = (await details(repo, 'R-P6-1')).packet;
  assert.equal(unverified.status, 'blocked');
  assert.deepEqual(reasonsOf(unverified, 'AKRS-R020'), ['road_unverified']);
  assert.equal(unverified.data.road.contract, 'unverified');
  assert.equal(validateRoadDetails(unverified.data).ok, true);
  assertFindingsMatchCatalog(unverified);

  const { repo: dup } = await packetWorld(t);
  await seedRoad(dup, { id: 'R-P6-1', plan: null }, { folder: 'roads/elsewhere' });
  const ambiguous = (await details(dup, 'R-P6-1')).packet;
  assert.equal(ambiguous.status, 'blocked');
  assert.deepEqual(reasonsOf(ambiguous, 'AKRS-R020'), ['road_ambiguous']);

  const { repo: lonely } = await packetWorld(t, { deps: ['R-NOPE'] });
  const missingDep = (await details(lonely, 'R-P6-1')).packet;
  assert.equal(missingDep.status, 'blocked');
  assert.deepEqual(missingDep.data.deps, [{ id: 'R-NOPE', status: 'missing' }]);
  assert.deepEqual(reasonsOf(missingDep, 'AKRS-R020'), ['dependency_missing']);

  const absent = await details(repo, 'R-NOPE');
  assert.equal(absent.exitCode, 2, 'a Road that does not exist is a usage error, not a packet about nothing');
});

test('the Worker packet grants no undeclared path and exposes pending scope requests without granting them', async (t) => {
  const { repo } = await packetWorld(t);
  const requested = await request(repo, { road: 'R-P6-1', add_writes: [fileWrite('src/new.js')], add_reads: [readEntry('SOT/02-rules.md', [1, 3], 'rules')] });
  assert.equal(requested.outcome, 'committed');
  const { packet } = await details(repo, 'R-P6-1');
  assert.deepEqual(packet.data.writes.map(({ path }) => path), ['src/admin.js', 'src/own.js'], 'a pending request grants nothing');
  assert.equal(packet.data.reads.length, 2);
  assert.equal(packet.data.scope_requests.length, 1);
  assert.deepEqual({ state: packet.data.scope_requests[0].state, blocking: packet.data.scope_requests[0].blocking }, { state: 'pending', blocking: true });
  assert.deepEqual(packet.data.scope_requests[0].add_writes, [fileWrite('src/new.js')]);
  assert.equal(packet.data.scope_requests[0].resolution, null);
  const keys = Object.keys(packet.data).sort();
  assert.deepEqual(keys, ['acceptance', 'boundaries', 'budget', 'checks', 'collisions', 'conventions', 'coverage', 'delivery', 'deps', 'forbidden', 'kind', 'lease', 'packet_version', 'reads', 'recent', 'reuse', 'road', 'role', 'scope_requests', 'steps', 'task', 'writes']);
});

test('the Leader base view exposes readiness, unresolved data, class fit, needs_split, lease and envelope; contents only with --full', async (t) => {
  const { repo } = await packetWorld(t, { scope_policy: { auto_reads: ['src/**'], auto_writes: [] }, reads: [readEntry('SOT/09-use-cases.md', [28, 41], 'rule'), readEntry('SOT/missing.md', null, 'gone')] });
  const base = await details(repo, 'R-P6-1', ['--role', 'leader']);
  const { data } = base.packet;
  assert.equal(validateRoadDetails(data).ok, true, JSON.stringify(validateRoadDetails(data).issues));
  assert.equal(data.role, 'leader');
  assert.equal(data.readiness.ready, false);
  assert.deepEqual(data.readiness.blockers.map(({ reason }) => reason), ['read_unresolved']);
  assert.deepEqual(data.coverage.unresolved.map(({ path }) => path), ['SOT/missing.md']);
  assert.equal(data.class_fit.verdict, 'fits');
  assert.equal(data.class_fit.class, 'weak');
  assert.equal(data.needs_split, false);
  assert.deepEqual(data.lease, { holder: null, caller: null, state: 'none' });
  assert.deepEqual(data.envelope, { policy: { auto_reads: ['src/**'], auto_writes: [] }, grants: 0, grant_cap: data.envelope.grant_cap });
  assert.equal(typeof data.envelope.grant_cap, 'number');
  assert.equal(data.reads.every(({ text, line_count: count }) => text === null && count === null), true, 'no contents and no file-level detail by default');
  assert.equal(base.packet.status, 'blocked');

  const full = (await details(repo, 'R-P6-1', ['--role', 'leader', '--full'])).packet.data;
  assert.equal(full.reads[0].text, lines(await repo.read('SOT/09-use-cases.md'), 28, 41));
  assert.equal(full.reads[0].line_count, 50);
});

test('the Leader packet reports an over-limit Road as needs_split and the lease holder', async (t) => {
  const writes = Array.from({ length: 4 }, (_, index) => fileWrite(`src/d/f${index}.js`));
  const { repo } = await packetWorld(t, { writes });
  const data = (await details(repo, 'R-P6-1', ['--role', 'leader'])).packet.data;
  assert.equal(data.class_fit.verdict, 'split_required');
  assert.equal(data.needs_split, true);
  const current = await computeSnapshot({ ...repo.options, projections: LEASE_CONTRACT_PROJECTION, target: { road: 'R-P6-1' } });
  const claimed = await claimLease({ ...repo.options, providers: repo.providers, kind: 'road', target: 'R-P6-1', holder: 'flash', snapshot: current.snapshot, inventory: current.inventory });
  assert.equal(claimed.status, 'claimed');
  const held = (await details(repo, 'R-P6-1', ['--role', 'leader'])).packet.data;
  assert.equal(held.lease.holder, 'flash');
});

test('a stale lease is reported to its holder; the query never creates or refreshes a lease', async (t) => {
  const { repo } = await packetWorld(t);
  const current = await computeSnapshot({ ...repo.options, projections: LEASE_CONTRACT_PROJECTION, target: { road: 'R-P6-1' } });
  await claimLease({ ...repo.options, providers: repo.providers, kind: 'road', target: 'R-P6-1', holder: 'flash', snapshot: current.snapshot, inventory: current.inventory });
  const options = { ...repo.options, id: 'R-P6-1', role: 'worker', env: { AKRS_EXECUTOR: 'flash' } };
  assert.equal((await buildRoadDetails(options)).data.lease.state, 'fresh');
  await seedWithTask(repo, { acceptance: ['Changed by the Leader.'] }, { status: 'ACTIVE' });
  const before = await everything(repo);
  const stale = await buildRoadDetails(options);
  assert.deepEqual({ holder: stale.data.lease.holder, caller: stale.data.lease.caller, state: stale.data.lease.state }, { holder: 'flash', caller: 'flash', state: 'stale' });
  assert.equal(await everything(repo), before, 'detection refreshes nothing');
  assert.equal((await buildRoadDetails({ ...options, env: { AKRS_EXECUTOR: 'mid' } })).data.lease.state, 'other');
  assert.equal((await buildRoadDetails({ ...options, env: {} })).data.lease.state, 'unknown', 'two Workers and no choice: the caller is unknown, and nothing is guessed');
});

test('the byte and token estimate is deterministic and uses the frozen CJK/Arabic-safe estimator', async (t) => {
  const arabic = Array.from({ length: 10 }, (_, index) => `السطر رقم ${index + 1} من القاعدة — 支付状态 ${index}`).join('\n');
  const { repo } = await packetWorld(t, { reads: [readEntry('SOT/arabic.md', [2, 9], 'unicode window')] }, { });
  await repo.write('SOT/arabic.md', `${arabic}\n`);
  const first = (await details(repo, 'R-P6-1')).packet;
  const second = (await details(repo, 'R-P6-1')).packet;
  assert.deepEqual(first.data, second.data);
  const text = lines(arabic, 2, 9);
  assert.equal(first.data.reads[0].bytes, Buffer.byteLength(text, 'utf8'));
  assert.equal(first.data.budget.read_files, 1);
  assert.equal(first.data.budget.read_bytes, Buffer.byteLength(text, 'utf8'));
  assert.equal(first.data.budget.estimated_tokens, estimateTokens(text));
  assert.ok(first.data.budget.estimated_tokens > Buffer.byteLength(text, 'utf8') / 8, 'multi-byte text is not under-counted');
});

test('--max-tokens refuses an oversized complete packet and drops nothing; at the limit the complete packet is returned', async (t) => {
  const { repo } = await packetWorld(t);
  const full = (await details(repo, 'R-P6-1')).packet;
  const size = full.data.budget.packet_tokens;
  assert.ok(size > 0);
  assert.equal(full.data.budget.max_tokens, null);
  const exact = await details(repo, 'R-P6-1', ['--max-tokens', String(size)]);
  assert.equal(exact.exitCode, 0);
  assert.deepEqual({ ...exact.packet.data, budget: { ...exact.packet.data.budget, max_tokens: null } }, full.data, 'at the limit nothing is dropped');
  assert.equal(exact.packet.data.budget.max_tokens, size);

  const refused = await details(repo, 'R-P6-1', ['--max-tokens', String(size - 1)]);
  assert.equal(refused.exitCode, 1);
  assert.equal(refused.packet.status, 'blocked');
  assert.equal(refused.packet.data.kind, 'road_details_refused');
  assert.equal(validateRoadDetails(refused.packet.data).ok, true, JSON.stringify(validateRoadDetails(refused.packet.data).issues));
  assert.deepEqual(refused.packet.data.refusal, { max_tokens: size - 1, packet_tokens: size });
  for (const key of ['reads', 'writes', 'acceptance', 'checks']) assert.equal(Object.hasOwn(refused.packet.data, key), false, `${key} is not delivered in part`);
  assert.deepEqual(codesOf(refused.packet), ['AKRS-R021']);
  assertFindingsMatchCatalog(refused.packet);
  assert.deepEqual(refused.packet.next_commands, [{ command: 'road-details', args: ['R-P6-1', '--role', 'worker', '--root', repo.root] }]);
  assert.equal((await details(repo, 'R-P6-1', ['--max-tokens', '0'])).exitCode, 2);
  assert.equal((await details(repo, 'R-P6-1', ['--max-tokens', 'many'])).exitCode, 2);
});

test('road-details is read-only: the whole tree and the snapshot are identical before and after', async (t) => {
  const { repo } = await packetWorld(t);
  const before = await strict(repo);
  const snapshot = await snapshotOf(repo, 'R-P6-1');
  for (const args of [[], ['--role', 'leader'], ['--include-reads'], ['--role', 'leader', '--full'], ['--max-tokens', '5']]) {
    const { packet } = await details(repo, 'R-P6-1', args);
    assert.deepEqual(packet.changed, []);
    assert.equal(packet.snapshot.before, snapshot);
    assert.equal(packet.snapshot.after, snapshot);
  }
  assert.equal(await strict(repo), before);
});

test('the internal fresh-packet builder returns the same data the command does, for both roles', async (t) => {
  const { repo } = await packetWorld(t);
  for (const role of ['worker', 'leader']) {
    const built = await buildFreshRoadPacket({ ...repo.options, id: 'R-P6-1', role, env: {} });
    const viaCommand = (await details(repo, 'R-P6-1', ['--role', role])).packet;
    assert.deepEqual(built.data, viaCommand.data);
    assert.equal(built.status, viaCommand.status);
    assert.equal(built.snapshot, viaCommand.snapshot.before);
  }
});

test('WORKER_ROAD is a valid seeded contract for the fixtures above', () => {
  assert.equal(WORKER_ROAD.id, 'R-P6-1');
});
