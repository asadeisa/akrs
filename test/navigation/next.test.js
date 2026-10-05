// P2-W09: `next` returns only legal commands, with explicit blocked and empty states; --executor filters by that executor's class.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { validateNext } from '../../lib/schemas/navigation.js';
import { treeDigest } from '../road/support.js';
import { request } from '../change/support.js';
import { claimRoad, closableWorld, finish, flat, navWorld, next, packetWorld, ranWorld, runWorld, testRun, worldOptions, writePlan } from './support.js';

const KNOWN = commandManifest.commands.map(({ id }) => id);
const ok = (out) => {
  assert.equal(out.exitCode, 0, out.text);
  assert.equal(validateNext(out.packet.data).ok, true, JSON.stringify(validateNext(out.packet.data).issues));
  return out.packet;
};
const kinds = (packet) => packet.data.actions.map(({ kind, subject }) => `${kind}:${subject}`);

test('next offers the legal Leader and Worker actions of a mixed workflow, in a stable order, and writes nothing', async (t) => {
  const repo = await navWorld(t);
  const digest = await treeDigest(repo);
  const packet = ok(await next(repo));
  assert.deepEqual([packet.command, packet.status, packet.data.kind, packet.data.packet_version], ['next', 'ok', 'next', 'akrs.next/v1']);
  assert.deepEqual(kinds(packet), ['activate:R-P6-3', 'work:R-P6-1']);
  assert.equal(packet.data.empty, null);
  assert.deepEqual(await treeDigest(repo), digest);
});

test('every offered command is a manifest command and every next command of the packet comes from an action', async (t) => {
  const repo = await navWorld(t);
  const packet = ok(await next(repo));
  for (const action of packet.data.actions) assert.ok(KNOWN.includes(action.command), action.command);
  assert.deepEqual(packet.next_commands.map(({ command }) => command), packet.data.actions.map(({ command }) => command));
  const activate = packet.data.actions.find(({ kind }) => kind === 'activate');
  assert.deepEqual([activate.command, activate.args[0], activate.args[1]], ['road-activate', 'R-P6-3', '--if-snapshot']);
  assert.match(activate.args[2], /^sha256:[0-9a-f]{64}$/);
});

test('a blocked QUEUED Road is named with its blockers and never offered', async (t) => {
  const repo = await navWorld(t);
  const packet = ok(await next(repo));
  const blocked = packet.data.blocked.find(({ subject }) => subject === 'R-P6-2');
  assert.deepEqual([blocked.kind, blocked.reasons.map(({ reason }) => reason)], ['road', ['dependency_not_done']]);
  assert.equal(kinds(packet).includes('activate:R-P6-2'), false);
});

test('a pending scope request is a Leader decision and comes before anything else', async (t) => {
  const repo = await navWorld(t);
  const filed = await request(repo, { road: 'R-P6-1', add_reads: [{ path: 'src/own.js', lines: null, why: 'needed' }], blocking: true });
  assert.equal(filed.outcome, 'committed', JSON.stringify(filed.packet.findings));
  const packet = ok(await next(repo));
  assert.equal(kinds(packet)[0], 'decide_scope:R-P6-1');
  assert.deepEqual(packet.data.actions[0].command, 'scope-list');
});

test('--executor filters by that executor class; an unknown executor is a usage error', async (t) => {
  const repo = await navWorld(t);
  const medium = ok(await next(repo, ['--executor', 'mid']));
  assert.deepEqual(kinds(medium), ['activate:R-P6-3']);
  assert.deepEqual(medium.data.executor, { id: 'mid', role: 'worker', class: 'medium' });
  const weak = ok(await next(repo, ['--executor', 'flash']));
  assert.deepEqual(kinds(weak), ['work:R-P6-1'], 'the weak Worker gets its own ACTIVE Road and no medium Road');
  const unknown = await next(repo, ['--executor', 'ghost']);
  assert.equal(unknown.exitCode, 2);
});

test('the Tester loop is navigated state by state: handoff gap, run, result, close', async (t) => {
  const ran = await runWorld(t, worldOptions());
  await writePlan(ran);
  assert.deepEqual(kinds(ok(await next(ran))), ['run_tests:P6']);
  await testRun(ran);
  assert.deepEqual(kinds(ok(await next(ran))), ['inspect:P6'], 'testing: read the packet and record the result');
  const passed = await closableWorld(t);
  const close = ok(await next(passed));
  assert.deepEqual(kinds(close), ['close_plan:P6']);
  assert.deepEqual([close.data.actions[0].command, close.data.actions[0].args[1]], ['plan-finish', '--dry-run']);
  await passed.write('SOT/10-budgets.md', 'frame budget 8ms\n');
  assert.deepEqual(kinds(ok(await next(passed))), ['run_tests:P6'], 'a stale pass is run again, never closed');
});

test('a failed Plan sends the Tester to the packet, not to a close', async (t) => {
  const repo = await ranWorld(t);
  await writePlan(repo);
  await flat(repo, 'fail', 'It broke.');
  assert.deepEqual(kinds(ok(await next(repo))), ['inspect:P6']);
});

test('a closed Plan has nothing left: the empty state is explicit', async (t) => {
  const repo = await closableWorld(t);
  await finish(repo);
  const packet = ok(await next(repo));
  assert.deepEqual(packet.data.actions, []);
  assert.equal(packet.data.empty.reason, 'nothing_to_do');
  assert.deepEqual(packet.next_commands, []);
});

test('a fully blocked workflow says so instead of staying silent', async (t) => {
  const { repo } = await packetWorld(t, { reads: [{ path: 'missing/file.md', lines: null, why: 'does not exist' }] }, { road: { status: 'QUEUED' } });
  const packet = ok(await next(repo));
  assert.deepEqual(packet.data.actions, []);
  assert.equal(packet.data.empty.reason, 'blocked');
  assert.deepEqual(packet.data.blocked.map(({ subject }) => subject), ['R-P6-1']);
  assert.equal(packet.data.blocked[0].reasons[0].reason, 'read_unresolved');
});

test('an ACTIVE Road with a fresh lease is the holder\'s to finish: road check names the transitions', async (t) => {
  const repo = await navWorld(t);
  await claimRoad(repo, 'R-P6-1', 'flash');
  const packet = ok(await next(repo));
  const action = packet.data.actions.find(({ subject }) => subject === 'R-P6-1');
  assert.deepEqual([action.kind, action.command, action.args[0]], ['finish_road', 'road-check', 'R-P6-1']);
});
