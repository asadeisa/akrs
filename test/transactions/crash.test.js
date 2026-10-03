// P1-W05 acceptance: a separate Node process runs the transaction and SIGKILLs itself after EVERY recorded boundary
// (each image, the staging manifest, prepared, each applied operation, packet.json, the commit marker, the journal
// commit and every cleanup step). The next mutation must find the workflow either completely old (before the commit
// marker) or completely new (from the commit marker on) before it starts, and the journal and the packet must agree.
// An in-process caught exception alone does not satisfy this packet; these are real process deaths.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readOp } from '../../lib/store/journal/index.js';
import { readLockOwner } from '../../lib/store/lock/index.js';
import {
  SCENARIOS,
  SCENARIO_NAMES,
  SCENARIO_REQUEST_ID,
  UNRELATED,
  UNRELATED_REQUEST_ID,
  censusOf,
  commandSnapshotFor,
  createTxWorkflow,
  crashWorkflow,
  journalStates,
  pendingMarkers,
  pool,
  positionOf,
  referenceTrees,
  runScenario,
  runWorker,
  treeDigest,
  txDirectories,
} from './support.js';

const SLOW = { timeout: 240_000 };

// Everything the next invocation must prove once a crash left the workflow in an unknown place.
async function verifyRecovery(t, workflow, scenarioName, { census, k, refs, beforeSnapshot, afterSnapshot, label }) {
  const scenario = SCENARIOS[scenarioName];
  const commitAt = positionOf(census, 'commit_marker');
  const preparedAt = positionOf(census, 'journal_prepared');
  const forward = k >= commitAt;
  const expectedTree = forward ? refs.new : refs.old;

  // 1. the next mutation: recovery must finish before authorize (the first thing of an unrelated mutation) runs
  const order = [];
  let treeAtAuthorize = null;
  const unrelated = await runScenario(workflow, UNRELATED, {
    async authorize() {
      order.push('authorize');
      treeAtAuthorize = await treeDigest(workflow);
      return null;
    },
    validate: () => { order.push('validate'); return null; },
    boundary({ point }) { order.push(point); },
  });
  assert.equal(unrelated.result.outcome, 'committed', `${label}: the unrelated mutation proceeds after recovery`);
  assert.equal(treeAtAuthorize, expectedTree, `${label}: complete ${forward ? 'new' : 'old'} state before the unrelated mutation began`);
  const firstOwn = order.indexOf('authorize');
  assert.ok(firstOwn >= 0);
  for (const [position, entry] of order.entries()) {
    if (entry.startsWith('recovery_')) assert.ok(position < firstOwn, `${label}: ${entry} happened before the unrelated mutation began`);
  }
  assert.deepEqual(await txDirectories(workflow), [], `${label}: no scratch left`);
  assert.deepEqual(await pendingMarkers(workflow), [], `${label}: no pending marker left`);
  assert.equal((await readLockOwner(workflow.options)).status, 'absent', `${label}: lock released`);

  // 2. the journal agrees with the outcome
  const states = await journalStates(workflow, SCENARIO_REQUEST_ID);
  if (forward) assert.deepEqual(states, ['prepared', 'committed'], `${label}: rolled forward`);
  else assert.deepEqual(states, k < preparedAt ? null : ['prepared', 'failed'], `${label}: rolled back or never journaled`);

  // 3. retry of the same request
  const retry = await runScenario(workflow, scenario);
  assert.equal(await treeDigest(workflow), refs.final, `${label}: both mutations applied exactly once`);
  if (forward) {
    const op = await readOp({ ...workflow.options, requestId: SCENARIO_REQUEST_ID });
    assert.equal(retry.result.outcome, 'replayed', `${label}: the retry is a noop`);
    assert.equal(retry.result.packet.status, 'noop');
    assert.equal(retry.result.packet.request_id, SCENARIO_REQUEST_ID, `${label}: original request ID`);
    assert.equal(retry.calls.render, 0, `${label}: nothing rendered or applied twice`);
    assert.equal(op.committed.before, beforeSnapshot, `${label}: journal before snapshot`);
    assert.equal(op.committed.after, afterSnapshot, `${label}: journal after snapshot is the new state's snapshot`);
    assert.equal(op.committed.packet.snapshot.after, afterSnapshot, `${label}: the stored packet agrees`);
    assert.deepEqual(op.committed.packet.data, { kind: 'transaction-test', operations: scenario.operations.length });
    assert.equal(op.committed.packet.status, 'ok');
    assert.deepEqual(retry.result.packet.data, op.committed.packet.data, `${label}: the replay carries the original data`);
    assert.deepEqual(await journalStates(workflow, SCENARIO_REQUEST_ID), ['prepared', 'committed']);
  } else {
    assert.equal(retry.result.outcome, 'committed', `${label}: a rolled back request is retryable and commits fresh`);
    assert.equal(retry.calls.render, 1);
    assert.equal(retry.result.packet.snapshot.after, await commandSnapshotFor(workflow, scenario), `${label}: fresh snapshot.after`);
    assert.deepEqual(
      await journalStates(workflow, SCENARIO_REQUEST_ID),
      k < preparedAt ? ['prepared', 'committed'] : ['prepared', 'failed', 'prepared', 'committed'],
      label,
    );
  }
  assert.deepEqual(await txDirectories(workflow), []);
}

async function snapshotsOf(t, scenarioName) {
  const scenario = SCENARIOS[scenarioName];
  const oldWorkflow = await createTxWorkflow(t);
  const beforeSnapshot = await commandSnapshotFor(oldWorkflow, scenario);
  const fresh = await createTxWorkflow(t);
  await runScenario(fresh, scenario);
  return { beforeSnapshot, afterSnapshot: await commandSnapshotFor(fresh, scenario) };
}

for (const scenarioName of SCENARIO_NAMES) {
  test(`kill after every boundary of a ${scenarioName} transaction: the next mutation recovers to the complete old or new state`, SLOW, async (t) => {
    const census = await censusOf(t, scenarioName);
    const refs = await referenceTrees(t, scenarioName);
    const snapshots = await snapshotsOf(t, scenarioName);
    const points = census.map(({ point }) => point);
    const types = SCENARIOS[scenarioName].operations.map(({ type }) => type);
    const required = ['manifest_staged', 'manifest_prepared', 'journal_prepared', 'operation_applied', 'packet_written',
      'commit_marker', 'journal_committed', 'journal_indexed', 'cleanup_started', 'cleanup_images_removed', 'cleanup_finished'];
    if (types.some((type) => type !== 'create')) required.push('before_image_written'); // an image of the old bytes exists
    if (types.some((type) => type !== 'delete')) required.push('after_image_written');
    for (const point of required) assert.ok(points.includes(point), `the census records ${point}`);
    assert.equal(points.filter((point) => point === 'operation_applied').length, SCENARIOS[scenarioName].operations.length);
    assert.ok(positionOf(census, 'commit_marker') < positionOf(census, 'journal_committed'));
    assert.ok(positionOf(census, 'packet_written') < positionOf(census, 'commit_marker'));
    assert.ok(positionOf(census, 'journal_prepared') > positionOf(census, 'manifest_prepared'));

    let intermediate = 0;
    const jobs = census.map((entry, k) => async () => {
      const label = `${scenarioName}: ${entry.point}${entry.index === null ? '' : `#${entry.index}`} (boundary ${k}/${census.length - 1})`;
      const workflow = await crashWorkflow(t, scenarioName, k);
      const crashed = await treeDigest(workflow);
      if (crashed !== refs.old && crashed !== refs.new) intermediate += 1;
      const forward = k >= positionOf(census, 'commit_marker');
      if (!forward && entry.point === 'operation_applied' && entry.index < SCENARIOS[scenarioName].operations.length - 1) {
        assert.notEqual(crashed, refs.old, `${label}: the crash really left a half applied tree`);
        assert.notEqual(crashed, refs.new, label);
      }
      await verifyRecovery(t, workflow, scenarioName, { census, k, refs, ...snapshots, label });
    });
    await pool(jobs);
    if (SCENARIOS[scenarioName].operations.length > 1) assert.ok(intermediate > 0, 'some crash left a tree that is neither old nor new');
  });
}

// Recovery itself is crash-safe: kill the recovering process at each of its boundaries, then recover again.
const RECOVERY_SOURCES = [
  ['operation_applied', 1],
  ['packet_written', null],
  ['commit_marker', null],
  ['journal_committed', null],
];

test('kill the recovering process at every recovery boundary: recovery is idempotent and still reaches the right state', SLOW, async (t) => {
  const census = await censusOf(t, 'multi');
  const refs = await referenceTrees(t, 'multi');
  const snapshots = await snapshotsOf(t, 'multi');

  for (const [point, index] of RECOVERY_SOURCES) {
    const sourceAt = positionOf(census, point, index);
    // how many recovery boundaries does a clean recovery of this crash record?
    const probe = await crashWorkflow(t, 'multi', sourceAt);
    const recorded = [];
    await runScenario(probe, UNRELATED, { boundary: ({ point: name }) => { if (name.startsWith('recovery_')) recorded.push(name); } });
    assert.ok(recorded.includes('recovery_started'), `${point}: recovery announced itself`);
    assert.ok(recorded.length >= 2, `${point}: ${recorded.join(',')}`);

    const jobs = recorded.map((name, j) => async () => {
      const label = `crash at ${point}#${index}, recovery killed at boundary ${j} (${name})`;
      const workflow = await crashWorkflow(t, 'multi', sourceAt);
      const child = await runWorker({
        options: workflow.options, scenario: 'unrelated', requestId: UNRELATED_REQUEST_ID, killAt: j,
      });
      assert.equal(child.result, null, `${label}: the recovering process died`);
      if (process.platform !== 'win32') assert.equal(child.signal, 'SIGKILL', label);
      await verifyRecovery(t, workflow, 'multi', { census, k: sourceAt, refs, ...snapshots, label });
    });
    await pool(jobs);
  }
});

test('a real second process recovers a crashed one end to end', SLOW, async (t) => {
  const census = await censusOf(t, 'multi');
  const refs = await referenceTrees(t, 'multi');
  for (const [point, index, expected] of [['operation_applied', 2, 'old'], ['commit_marker', null, 'new']]) {
    const workflow = await crashWorkflow(t, 'multi', positionOf(census, point, index));
    const next = await runWorker({ options: workflow.options, scenario: 'unrelated', requestId: UNRELATED_REQUEST_ID, killAt: null });
    assert.equal(next.exitCode, 0, next.stderr);
    assert.equal(next.result.outcome, 'committed');
    const retry = await runWorker({ options: workflow.options, scenario: 'multi', requestId: SCENARIO_REQUEST_ID, killAt: null });
    assert.equal(retry.exitCode, 0, retry.stderr);
    assert.equal(retry.result.outcome, expected === 'new' ? 'replayed' : 'committed');
    assert.equal(retry.result.request_id, SCENARIO_REQUEST_ID);
    assert.equal(await treeDigest(workflow), refs.final);
    assert.deepEqual(await txDirectories(workflow), []);
  }
});
