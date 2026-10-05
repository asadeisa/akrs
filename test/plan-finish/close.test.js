// P2-W08: a successful close is one recoverable transaction that changes exactly the Plan file and the closure ledger, lists
// them, records the closure state, and answers a repeated request as a noop.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLAN_SPEC, validatePlan } from '../../lib/schemas/plan.js';
import { verifyMeta } from '../../lib/store/canonical/index.js';
import { treeDigest } from '../road/support.js';
import { PLAN_PATH, closableWorld, closures, finish, flat, ledger, snapshotOf } from './support.js';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

test('a close writes the closed Plan and one closure record, lists exactly those files, and records who closed it', async (t) => {
  const repo = await closableWorld(t);
  const before = await snapshotOf(repo);
  const out = await finish(repo, ['--request-id', '01ARZ3NDEKTSV4RRFFQ6900001']);
  assert.equal(out.exitCode, 0, out.text);
  assert.deepEqual(out.packet.findings, []);
  assert.deepEqual([out.packet.status, out.packet.data.kind, out.packet.request_id], ['ok', 'plan_finish', '01ARZ3NDEKTSV4RRFFQ6900001']);
  assert.deepEqual(out.packet.changed, ['log/0001.jsonl', 'plans/P6.json']);
  assert.notEqual(out.packet.snapshot.after, before, 'a fresh snapshot is returned');
  assert.equal(out.packet.snapshot.after, await snapshotOf(repo));

  const plan = JSON.parse(await repo.read(PLAN_PATH));
  assert.equal(validatePlan(plan, { form: 'stored' }).ok, true);
  assert.equal(verifyMeta(plan, { spec: PLAN_SPEC }), 'declared');
  assert.deepEqual([plan.closure.status, plan.closure.at], ['closed', out.packet.data.plan.at]);
  assert.equal(plan.closure.operation.request, '01ARZ3NDEKTSV4RRFFQ6900001');
  assert.match(plan.closure.operation.run, ULID);

  const [record, ...rest] = await closures(repo);
  assert.equal(rest.length, 0);
  assert.deepEqual([record.kind, record.subject, record.outcome, record.deviations], ['plan', 'P6', 'DONE', null]);
  assert.deepEqual(record.operation, plan.closure.operation, 'the ledger and the Plan name the same operation');
  assert.deepEqual(out.packet.data.closure, { action: 'appended', id: record.id, segment: 'akrs/log/0001.jsonl', operation: plan.closure.operation });
  assert.deepEqual(out.packet.data.plan, { id: 'P6', path: PLAN_PATH, from: 'open', to: 'closed', at: plan.closure.at });
  assert.deepEqual(out.packet.next_commands, [{ command: 'state-render', args: ['--root', repo.root] }]);
});

test('a close changes nothing but the Plan file and the closure ledger (the results, Roads and evidence stay)', async (t) => {
  const repo = await closableWorld(t);
  const results = await repo.read('akrs/verifications/P6/results.jsonl');
  const roads = await repo.read('akrs/roads/P6/R-P6-1.json');
  const contract = await repo.read('akrs/verifications/P6/contract.json');
  await finish(repo);
  assert.equal(await repo.read('akrs/verifications/P6/results.jsonl'), results);
  assert.equal(await repo.read('akrs/roads/P6/R-P6-1.json'), roads);
  assert.equal(await repo.read('akrs/verifications/P6/contract.json'), contract);
  assert.equal((await ledger(repo)).length, 1, 'the pass is still the one result');
});

test('the same request is a noop that writes nothing, and so is a new request for the Plan the journal already closed', async (t) => {
  const repo = await closableWorld(t);
  const id = '01ARZ3NDEKTSV4RRFFQ6900002';
  const snapshot = await snapshotOf(repo);
  const first = await finish(repo, ['--request-id', id], { snapshot });
  assert.equal(first.exitCode, 0, first.text);
  const digest = await treeDigest(repo);
  const again = await finish(repo, ['--request-id', id], { snapshot });
  assert.equal(again.packet.status, 'noop', again.text);
  const other = await finish(repo);
  assert.equal(other.packet.status, 'noop', other.text);
  assert.deepEqual(await treeDigest(repo), digest);
  assert.equal((await closures(repo)).length, 1);
});

test('two concurrent closes of one Plan append one closure', async (t) => {
  const repo = await closableWorld(t);
  const snapshot = await snapshotOf(repo);
  const outs = await Promise.all([finish(repo, ['--request-id', '01ARZ3NDEKTSV4RRFFQ6900003'], { snapshot }), finish(repo, ['--request-id', '01ARZ3NDEKTSV4RRFFQ6900004'], { snapshot })]);
  assert.equal(outs.filter(({ packet }) => packet.status === 'ok').length, 1, JSON.stringify(outs.map(({ packet }) => [packet.status, packet.data.reason ?? null])));
  assert.equal((await closures(repo)).length, 1);
});

test('the gate is evaluated again under the lock: a change after the snapshot was read is refused and nothing is written', async (t) => {
  const repo = await closableWorld(t);
  const snapshot = await snapshotOf(repo);
  await repo.write('SOT/10-budgets.md', 'frame budget 8ms\n');
  const digest = await treeDigest(repo);
  const out = await finish(repo, [], { snapshot });
  assert.equal(out.packet.status, 'blocked');
  assert.ok(out.packet.findings.some(({ code }) => code === 'AKRS-C013'), 'the snapshot guard refuses a changed Plan');
  assert.deepEqual(await treeDigest(repo), digest);
});

test('a pass after the close cannot reopen it and a later result is judged on its own', async (t) => {
  const repo = await closableWorld(t);
  await finish(repo);
  const more = await flat(repo, 'pass', 'A second look after the close.');
  assert.equal(more.exitCode, 0, 'recording a result never closes or reopens a Plan');
  const plan = JSON.parse(await repo.read(PLAN_PATH));
  assert.equal(plan.closure.status, 'closed');
});
