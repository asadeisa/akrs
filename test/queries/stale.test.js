// P2-W09: `stale` names every stale packet, result and artifact with the exact inputs that invalidated it, or says plainly that
// it has no inventory to name them from. It reads and never refreshes anything.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateStale } from '../../lib/schemas/navigation.js';
import { treeDigest } from '../road/support.js';
import { claimRoad, closableWorld, flat, navWorld, query, ranWorld, testRun, writePlan } from '../navigation/support.js';
import { runCommand } from '../road/support.js';

const stale = (repo) => query(repo, ['stale']);
const ok = (out) => {
  assert.equal(out.exitCode, out.packet.status === 'ok' ? 0 : 1, out.text);
  assert.equal(validateStale(out.packet.data).ok, true, JSON.stringify(validateStale(out.packet.data).issues));
  return out.packet;
};

test('a workflow with nothing stale says so explicitly and writes nothing', async (t) => {
  const repo = await navWorld(t);
  await claimRoad(repo, 'R-P6-1', 'flash');
  const digest = await treeDigest(repo);
  const packet = ok(await stale(repo));
  assert.deepEqual([packet.command, packet.status, packet.data.kind, packet.data.packet_version], ['stale', 'ok', 'stale', 'akrs.stale/v1']);
  assert.deepEqual(packet.data.items, []);
  assert.equal(packet.data.empty, true);
  assert.deepEqual(await treeDigest(repo), digest);
});

test('a stale Road lease names the holder and the exact inputs that changed', async (t) => {
  const repo = await navWorld(t);
  await claimRoad(repo, 'R-P6-1', 'flash');
  await repo.write('SOT/09-use-cases.md', `${'changed use-case line\n'.repeat(50)}`);
  const packet = ok(await stale(repo));
  const [item] = packet.data.items;
  assert.deepEqual([item.kind, item.subject, item.holder], ['road_lease', 'R-P6-1', 'flash']);
  assert.ok(item.inputs.changed.length > 0, 'the changed inputs are named');
  assert.deepEqual([item.inputs.added, item.inputs.removed], [[], []]);
  assert.equal(packet.data.empty, false);
  assert.equal(packet.status, 'warning');
});

test('a stale Tester pass is named with the Plan, the result and why it is no longer current', async (t) => {
  const repo = await closableWorld(t);
  await repo.write('SOT/10-budgets.md', 'frame budget 8ms\n');
  const packet = ok(await stale(repo));
  const result = packet.data.items.find(({ kind }) => kind === 'result');
  assert.deepEqual([result.subject, result.plan], [result.subject, 'P6']);
  assert.ok(result.reasons.includes('snapshot_changed'));
  assert.equal(result.inputs, null, 'results record no per-input inventory, so the inputs are not guessed');
});

test('a stale run record and the Plan Tester lease are named', async (t) => {
  const repo = await ranWorld(t);
  await writePlan(repo);
  await repo.write('SOT/10-budgets.md', 'frame budget 8ms\n');
  const kinds = ok(await stale(repo)).data.items.map(({ kind }) => kind).sort();
  assert.deepEqual(kinds, ['plan_lease', 'run']);
  const lease = ok(await stale(repo)).data.items.find(({ kind }) => kind === 'plan_lease');
  assert.equal(lease.subject, 'P6');
  assert.ok(lease.inputs.changed.length > 0);
});

test('a STATE.md that no longer equals the render of the canonical inputs is a stale artifact', async (t) => {
  const repo = await navWorld(t);
  const set = await runCommand(repo, ['state', 'set', '--mode', '3', '--role', 'leader', '--next', 'Wire the list.', '--json'], { providers: repo.providers });
  assert.equal(set.exitCode, 0, set.stderr);
  // state set re-renders STATE.md in the same transaction, so it equals the render of the canonical inputs
  assert.deepEqual(ok(await stale(repo)).data.items, []);
  await repo.write('akrs/STATE.md', 'hand edited\n');
  const item = ok(await stale(repo)).data.items.find(({ kind }) => kind === 'state_render');
  assert.deepEqual([item.subject, item.reasons, item.inputs], ['akrs/STATE.md', ['differs_from_derived'], null]);
});

test('items are sorted by kind then subject so the report is stable', async (t) => {
  const repo = await navWorld(t);
  await claimRoad(repo, 'R-P6-1', 'flash');
  await claimRoad(repo, 'R-P6-3', 'mid');
  await repo.write('SOT/09-use-cases.md', `${'changed use-case line\n'.repeat(50)}`);
  const items = ok(await stale(repo)).data.items;
  const keys = items.map(({ kind, subject }) => `${kind}:${subject}`);
  assert.deepEqual(keys, [...keys].sort());
});
