// P2-W08: the whole Tester loop on a Plan whose contract needs no live run (the checks policy): the Leader defines, the Worker
// hands off, the Tester fails with a finding, the Leader's gate refuses, the Tester passes after the fix, and the Plan closes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handoff, define, contractInput, planWorld } from '../tester/support.js';
import { fakeProviders } from '../idempotency/support.js';
import { seedRoad } from '../road/support.js';
import { runCommand } from '../road/support.js';
import { PLAN_PATH, blockersOf, closures, finish, flat, full, ledger, writePlan } from './support.js';

async function checksWorld(t) {
  const repo = await planWorld(t);
  repo.providers = fakeProviders({ firstId: 9000 });
  await repo.write('SOT/10-budgets.md', 'frame budget 16ms\n');
  await seedRoad(repo, { id: 'R-P6-1', plan: 'P6' }, { folder: 'roads/P6', status: 'DONE' });
  const stored = await define(repo, 'P6', await contractInput('valid/full', { plan: 'P6', roads: ['R-P6-1', 'R-P6-2'], policy: 'checks', launch: null, setup: [], teardown: [], measurements: [], scenario: [], evidence_types: [] }));
  assert.equal(stored.outcome, 'committed', JSON.stringify(stored.packet.findings));
  for (const road of ['R-P6-1', 'R-P6-2']) {
    const done = await handoff(repo, 'P6', { road, result: `${road} is reachable.`, reach: [`Open /${road}`], expect: `${road} lists reservations.` });
    assert.equal(done.outcome, 'committed');
  }
  await writePlan(repo);
  return repo;
}

test('define, handoff, fail, refuse, fix, pass, close: the Plan closes only on the current pass', async (t) => {
  const repo = await checksWorld(t);
  const empty = await finish(repo, ['--dry-run'], { snapshot: null });
  assert.deepEqual([empty.packet.status, blockersOf(empty.packet)], ['blocked', ['tester_missing']]);

  const failed = await full(repo, { verdict: 'fail', checks: [], measurements: [], evidence: [], findings: [{ id: 'F1', text: 'The admin page lists nothing.', status: 'open' }], user_acceptance: { answer: 'no', because: 'The page is empty.' } });
  assert.equal(failed.exitCode, 0, failed.text);
  const refused = await finish(repo);
  assert.equal(refused.packet.status, 'blocked');
  assert.deepEqual(blockersOf(refused.packet).sort(), ['finding_open', 'tester_failed']);

  const passed = await full(repo, { verdict: 'pass', checks: [], measurements: [], evidence: [], findings: [{ id: 'F1', text: 'The admin page lists nothing.', status: 'resolved' }], user_acceptance: { answer: 'yes', because: 'The page lists reservations now.' } });
  assert.equal(passed.exitCode, 0, passed.text);
  assert.deepEqual((await ledger(repo)).map(({ verdict }) => verdict), ['fail', 'pass']);

  const closed = await finish(repo);
  assert.equal(closed.exitCode, 0, closed.text);
  assert.equal(JSON.parse(await repo.read(PLAN_PATH)).closure.status, 'closed');
  assert.equal((await closures(repo)).length, 1);
});

test('a pass followed by a change to a declared read cannot close the Plan until the Tester passes again', async (t) => {
  const repo = await checksWorld(t);
  assert.equal((await flat(repo, 'pass')).exitCode, 0);
  await repo.write('SOT/10-budgets.md', 'frame budget 12ms\n');
  const stale = await finish(repo);
  assert.deepEqual([stale.packet.status, blockersOf(stale.packet)], ['blocked', ['tester_stale']]);
  assert.equal((await flat(repo, 'pass', 'Looked again after the budget moved.')).exitCode, 0);
  const closed = await finish(repo);
  assert.equal(closed.exitCode, 0, closed.text);
});

test('the Tester state follows the loop; closing the Plan records no verdict and adds no result', async (t) => {
  const repo = await checksWorld(t);
  const state = async () => JSON.parse((await runCommand(repo, ['test-details', 'P6', '--json'], { providers: repo.providers })).stdout).data.result.state;
  assert.equal(await state(), 'ready_for_test');
  await flat(repo, 'pass');
  assert.equal(await state(), 'passed');
  const closed = await finish(repo);
  assert.equal(closed.exitCode, 0, closed.text);
  assert.deepEqual((await ledger(repo)).map(({ verdict }) => verdict), ['pass'], 'the close appends no result and changes none');
  assert.equal(JSON.stringify(closed.packet.data).includes('verdict'), false, 'the close packet states no verdict');
});
