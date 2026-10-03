// P1-W05: recovery decisions that are not "kill after every boundary": corrupt or missing staged files, a
// corrupt manifest, unexpected target bytes, in-process write failures, orphan scratch and the standalone
// recovery entry point. Crashes are real SIGKILLs of a child process (test/fixtures/transaction-crash).
import assert from 'node:assert/strict';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { acquireRepositoryLock, readLockOwner } from '../../lib/store/lock/index.js';
import { recoverTransactions } from '../../lib/store/transactions/index.js';
import {
  SCENARIOS,
  SCENARIO_REQUEST_ID,
  UNRELATED,
  censusOf,
  crashAt,
  createTxWorkflow,
  digestOf,
  fakeProviders,
  journalStates,
  pendingMarkers,
  positionOf,
  referenceTrees,
  runScenario,
  treeDigest,
  txDirectories,
  txPath,
} from './support.js';

async function onlyTransaction(workflow) {
  const directories = await txDirectories(workflow);
  assert.equal(directories.length, 1, `exactly one transaction directory: ${directories}`);
  return directories[0];
}

const stateOf = async (workflow) => ({
  tree: await treeDigest(workflow),
  tx: await digestOf(workflow, 'akrs/.ops/tx'),
  journal: await digestOf(workflow, 'akrs/.ops/journal'),
});

// An unrelated mutation that must be stopped by an unrecoverable transaction: nothing of it may start.
async function assertBlocked(workflow, reason, pathSuffix) {
  const before = await stateOf(workflow);
  const { result, calls } = await runScenario(workflow, UNRELATED, { authorize: () => null, validate: () => null });
  assert.equal(result.outcome, 'recovery_required');
  assert.equal(result.exit_code, 1);
  assert.equal(result.packet.status, 'blocked');
  const codes = result.packet.findings.map(({ code }) => code);
  assert.deepEqual(codes, ['AKRS-C011', 'AKRS-C014']);
  const detail = result.packet.findings[1].detail;
  assert.equal(detail.reason, reason, JSON.stringify(detail));
  assert.deepEqual(Object.keys(detail).sort(), ['path', 'reason', 'request_id', 'transaction']);
  if (pathSuffix !== undefined) assert.ok(detail.path?.endsWith(pathSuffix), `${detail.path} ends with ${pathSuffix}`);
  assert.equal(calls.authorize + calls.validate + calls.render, 0, 'no unrelated mutation began');
  assert.deepEqual(await stateOf(workflow), before, 'a blocked recovery changes no byte');
  assert.equal((await readLockOwner(workflow.options)).status, 'absent');
  return result;
}

async function assertRecovers(t, workflow, scenarioName, expected) {
  const refs = await referenceTrees(t, scenarioName);
  let atAuthorize = null;
  const { result } = await runScenario(workflow, UNRELATED, { authorize: async () => { atAuthorize = await treeDigest(workflow); return null; } });
  assert.equal(result.outcome, 'committed');
  assert.equal(atAuthorize, refs[expected], `recovered to the complete ${expected} state before the unrelated mutation began`);
  assert.deepEqual(await txDirectories(workflow), []);
  assert.deepEqual(await pendingMarkers(workflow), []);
  return refs;
}

test('a corrupt manifest after prepared blocks every mutation, is never guessed, and heals when the file is restored', async (t) => {
  const census = await censusOf(t, 'multi');
  const workflow = await crashAt(t, 'multi', 'operation_applied', 0, census);
  const tx = await onlyTransaction(workflow);
  const manifestPath = txPath(workflow, tx, 'manifest.json');
  const original = await readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(original);
  assert.equal(parsed.state, 'applying');
  assert.equal(parsed.progress, 1);

  for (const corrupt of ['{ not json', '', original.slice(0, 40), JSON.stringify({ ...parsed, state: 'bogus' }),
    JSON.stringify({ ...parsed, id: '01ARZ3NDEKTSV4RRFFQ6000099' }), JSON.stringify({ ...parsed, extra: true }),
    JSON.stringify({ ...parsed, operations: [] })]) {
    await writeFile(manifestPath, corrupt);
    await assertBlocked(workflow, 'manifest_corrupt', `${tx}/manifest.json`);
  }

  await writeFile(manifestPath, original);
  await assertRecovers(t, workflow, 'multi', 'old');
});

test('a staged image that restore needs must exist and match its hash, otherwise recovery is blocked', async (t) => {
  const census = await censusOf(t, 'multi');
  const { old } = await referenceTrees(t, 'multi');
  for (const [label, damage, reason] of [
    ['missing', (path) => rm(path), 'image_missing'],
    ['corrupt', (path) => writeFile(path, 'tampered'), 'image_corrupt'],
    ['truncated', async (path) => writeFile(path, (await readFile(path)).subarray(0, 3)), 'image_corrupt'],
  ]) {
    // ops 0 and 1 are applied: Road R1 (op 1) sits at its after state, so its before image is the only way back
    const workflow = await crashAt(t, 'multi', 'operation_applied', 1, census);
    const tx = await onlyTransaction(workflow);
    await damage(txPath(workflow, tx, 'before', '1'));
    await assertBlocked(workflow, reason, `${tx}/before/1`);
    assert.notEqual(await treeDigest(workflow), old, `${label}: nothing was rolled back`);
  }
});

test('an image whose target is already in the required state is not needed', async (t) => {
  const census = await censusOf(t, 'multi');
  // only op 0 is applied; the before images of ops 2 and 3 (targets untouched) can vanish without harm
  const workflow = await crashAt(t, 'multi', 'operation_applied', 0, census);
  const tx = await onlyTransaction(workflow);
  await rm(txPath(workflow, tx, 'before', '2'));
  await writeFile(txPath(workflow, tx, 'before', '3'), 'garbage');
  await rm(txPath(workflow, tx, 'after', '1'));
  await assertRecovers(t, workflow, 'multi', 'old');
});

test('roll forward re-applies from after images only when a target is not yet in its new state', async (t) => {
  const census = await censusOf(t, 'multi');

  // every target is already new: even destroyed images cannot stop the roll forward
  const settled = await crashAt(t, 'multi', 'commit_marker', null, census);
  const tx = await onlyTransaction(settled);
  await writeFile(txPath(settled, tx, 'after', '1'), 'garbage');
  await rm(txPath(settled, tx, 'before', '1'));
  await assertRecovers(t, settled, 'multi', 'new');
  assert.deepEqual(await journalStates(settled, SCENARIO_REQUEST_ID), ['prepared', 'committed']);

  // one target is back at its old bytes: it is re-applied from a healthy after image
  const reverted = await crashAt(t, 'multi', 'commit_marker', null, census);
  await writeFile(reverted.path('akrs', 'roads', 'R1.json'), reverted.files['akrs/roads/R1.json']);
  await assertRecovers(t, reverted, 'multi', 'new');

  // ... and when that image is damaged, recovery is blocked without writing anything
  const broken = await crashAt(t, 'multi', 'commit_marker', null, census);
  const brokenTx = await onlyTransaction(broken);
  await writeFile(broken.path('akrs', 'roads', 'R1.json'), broken.files['akrs/roads/R1.json']);
  await writeFile(txPath(broken, brokenTx, 'after', '1'), 'garbage');
  await assertBlocked(broken, 'image_corrupt', `${brokenTx}/after/1`);
  const missing = await crashAt(t, 'multi', 'commit_marker', null, census);
  const missingTx = await onlyTransaction(missing);
  await writeFile(missing.path('akrs', 'roads', 'R1.json'), missing.files['akrs/roads/R1.json']);
  await rm(txPath(missing, missingTx, 'after', '1'));
  await assertBlocked(missing, 'image_missing', `${missingTx}/after/1`);
});

test('a missing or damaged packet.json after the commit marker blocks, it is never regenerated', async (t) => {
  const census = await censusOf(t, 'multi');
  for (const [label, damage, reason] of [
    ['missing', (path) => rm(path), 'packet_missing'],
    ['not json', (path) => writeFile(path, '{ nope'), 'packet_corrupt'],
    ['not a packet', (path) => writeFile(path, '{"schema_version":"akrs.packet/v2"}'), 'packet_corrupt'],
  ]) {
    const workflow = await crashAt(t, 'multi', 'commit_marker', null, census);
    const tx = await onlyTransaction(workflow);
    await damage(txPath(workflow, tx, 'packet.json'));
    await assertBlocked(workflow, reason, `${tx}/packet.json`);
    assert.equal((await journalStates(workflow, SCENARIO_REQUEST_ID)).at(-1), 'prepared', label);
  }
});

test('a target that is neither the before nor the after image is never overwritten', async (t) => {
  const census = await censusOf(t, 'multi');
  const workflow = await crashAt(t, 'multi', 'operation_applied', 0, census);
  const tx = await onlyTransaction(workflow);
  await writeFile(workflow.path('akrs', 'roads', 'R1.json'), '{"edited":"by a human"}\n');
  await assertBlocked(workflow, 'target_unexpected', 'roads/R1.json');
  assert.equal(await readFile(workflow.path('akrs', 'roads', 'R1.json'), 'utf8'), '{"edited":"by a human"}\n');
  assert.deepEqual(await txDirectories(workflow), [tx]);
});

test('scratch from a crash before prepared is discarded: no manifest, a torn manifest write, or a staging manifest', async (t) => {
  const census = await censusOf(t, 'multi');
  const cases = [
    ['no manifest yet', async () => crashAt(t, 'multi', 'before_image_written', 0, census)],
    ['all images, no manifest', async () => crashAt(t, 'multi', 'after_image_written', 2, census)],
    ['staging manifest', async () => crashAt(t, 'multi', 'manifest_staged', null, census)],
    ['torn manifest temp file', async () => {
      const workflow = await crashAt(t, 'multi', 'after_image_written', 2, census);
      const tx = await onlyTransaction(workflow);
      await writeFile(txPath(workflow, tx, 'manifest.json.tmp-123-abcdef'), '{ "schema": "akrs.tx/v1", "sta');
      return workflow;
    }],
  ];
  const refs = await referenceTrees(t, 'multi');
  for (const [label, make] of cases) {
    const workflow = await make();
    assert.equal(await treeDigest(workflow), refs.old, `${label}: no target was touched`);
    assert.equal((await txDirectories(workflow)).length, 1, `${label}: scratch is there`);
    const { result } = await runScenario(workflow, UNRELATED);
    assert.equal(result.outcome, 'committed', label);
    assert.deepEqual(await txDirectories(workflow), [], `${label}: scratch discarded`);
    assert.equal(await journalStates(workflow, SCENARIO_REQUEST_ID), null, `${label}: no journal record existed`);
    // the same request is simply new
    const retry = await runScenario(workflow, SCENARIOS.multi);
    assert.equal(retry.result.outcome, 'committed', label);
    assert.equal(await treeDigest(workflow), refs.final, label);
  }
});

test('a prepared transaction without a journal record is restored (nothing applied) and discarded', async (t) => {
  const census = await censusOf(t, 'multi');
  const workflow = await crashAt(t, 'multi', 'manifest_prepared', null, census);
  assert.equal(await journalStates(workflow, SCENARIO_REQUEST_ID), null);
  await assertRecovers(t, workflow, 'multi', 'old');
  assert.equal(await journalStates(workflow, SCENARIO_REQUEST_ID), null);
});

test('a journal prepared record plus a pending marker is resolved as rolled back before anything else runs', async (t) => {
  const census = await censusOf(t, 'multi');
  const workflow = await crashAt(t, 'multi', 'journal_prepared', null, census);
  assert.deepEqual(await journalStates(workflow, SCENARIO_REQUEST_ID), ['prepared']);
  assert.deepEqual(await pendingMarkers(workflow), [`${SCENARIO_REQUEST_ID}.json`]);
  await assertRecovers(t, workflow, 'multi', 'old');
  assert.deepEqual(await journalStates(workflow, SCENARIO_REQUEST_ID), ['prepared', 'failed']);
});

test('a missing transaction directory behind a prepared journal record is blocked, not guessed', async (t) => {
  const census = await censusOf(t, 'multi');
  const workflow = await crashAt(t, 'multi', 'operation_applied', 1, census);
  const tx = await onlyTransaction(workflow);
  await rm(txPath(workflow, tx), { recursive: true });
  await assertBlocked(workflow, 'directory_missing', tx);
});

test('retrying the same request right after a roll-forward crash replays it with the original request ID', async (t) => {
  const census = await censusOf(t, 'multi');
  const workflow = await crashAt(t, 'multi', 'commit_marker', null, census);
  const tx = await onlyTransaction(workflow);
  const staged = JSON.parse(await readFile(txPath(workflow, tx, 'packet.json'), 'utf8'));
  const { result, calls } = await runScenario(workflow, SCENARIOS.multi, { providers: fakeProviders({ firstId: 5000 }) });
  assert.equal(result.outcome, 'replayed', 'recovery ran before the idempotency check');
  assert.equal(result.packet.status, 'noop');
  assert.equal(result.packet.request_id, SCENARIO_REQUEST_ID);
  assert.equal(calls.render, 0, 'nothing was rendered or applied twice');
  assert.deepEqual(result.packet.data, staged.data, 'the replayed packet is the staged final packet');
  assert.equal(result.packet.snapshot.after, staged.snapshot.after);
  assert.equal(result.record.packet.run_id, staged.run_id, 'the journal stores the packet written before the commit marker');
  assert.deepEqual(result.record.packet, staged);
  assert.deepEqual(await journalStates(workflow, SCENARIO_REQUEST_ID), ['prepared', 'committed']);
});

test('retrying the same request right after a rollback commits it fresh', async (t) => {
  const census = await censusOf(t, 'multi');
  const workflow = await crashAt(t, 'multi', 'operation_applied', 2, census);
  const refs = await referenceTrees(t, 'multi');
  const { result, calls } = await runScenario(workflow, SCENARIOS.multi);
  assert.equal(result.outcome, 'committed');
  assert.equal(calls.render, 1);
  assert.equal(await treeDigest(workflow), refs.new);
  assert.deepEqual(await journalStates(workflow, SCENARIO_REQUEST_ID), ['prepared', 'failed', 'prepared', 'committed']);
});

test('an in-process write failure rolls back cleanly at every point before the commit marker', async (t) => {
  const census = await censusOf(t, 'multi');
  const preparedAt = positionOf(census, 'journal_prepared');
  const commitAt = positionOf(census, 'commit_marker');
  const refs = await referenceTrees(t, 'multi');

  for (let k = 0; k < census.length; k += 1) {
    const { point, index } = census[k];
    const label = `${point}#${index}@${k}`;
    const workflow = await createTxWorkflow(t);
    let count = 0;
    const boom = () => {
      const current = count;
      count += 1;
      if (current === k) throw new Error(`injected disk error at ${label}`);
    };
    await assert.rejects(runScenario(workflow, SCENARIOS.multi, { boundary: boom }), { message: `injected disk error at ${label}` }, label);
    assert.equal((await readLockOwner(workflow.options)).status, 'absent', `${label}: lock released`);

    if (k < preparedAt) {
      assert.equal(await treeDigest(workflow), refs.old, label);
      assert.deepEqual(await txDirectories(workflow), [], `${label}: scratch removed`);
      assert.equal(await journalStates(workflow, SCENARIO_REQUEST_ID), null, `${label}: journal untouched`);
    } else if (k < commitAt && k > preparedAt) {
      assert.equal(await treeDigest(workflow), refs.old, `${label}: rolled back in process`);
      assert.deepEqual(await txDirectories(workflow), [], `${label}: scratch removed`);
      assert.deepEqual(await journalStates(workflow, SCENARIO_REQUEST_ID), ['prepared', 'failed'], label);
      assert.deepEqual(await pendingMarkers(workflow), [], label);
    } else {
      // journal_prepared and everything after the commit marker is a crash, not an error: the journal hooks sit
      // outside the failure handling, so the next mutation recovers
      assert.equal((await txDirectories(workflow)).length === 1 || k > commitAt, true, label);
      const { result } = await runScenario(workflow, UNRELATED);
      assert.equal(result.outcome, 'committed', label);
      assert.deepEqual(await txDirectories(workflow), [], label);
    }

    const retry = await runScenario(workflow, SCENARIOS.multi);
    if (k >= commitAt) {
      assert.equal(retry.result.outcome, 'replayed', label);
      assert.equal(await treeDigest(workflow), refs.final, label);
    } else {
      assert.equal(retry.result.outcome, 'committed', label);
      assert.equal(await treeDigest(workflow), k === preparedAt ? refs.final : refs.new, label);
    }
  }
});

test('rollback removes the directories the transaction created, and nothing else', async (t) => {
  for (const name of ['create', 'move']) {
    const census = await censusOf(t, name);
    const refs = await referenceTrees(t, name);
    const applied = positionOf(census, 'operation_applied', 0);
    const workflow = await createTxWorkflow(t);
    let count = 0;
    await assert.rejects(runScenario(workflow, SCENARIOS[name], {
      boundary() {
        const current = count;
        count += 1;
        if (current === applied) throw new Error('injected');
      },
    }), /injected/);
    assert.equal(await treeDigest(workflow), refs.old, `${name}: no leftover directory (the digest counts directories)`);
  }
});

test('an in-process rollback that itself fails leaves the scratch for the next mutation to finish', async (t) => {
  const census = await censusOf(t, 'multi');
  const refs = await referenceTrees(t, 'multi');
  const workflow = await createTxWorkflow(t);
  const failAt = positionOf(census, 'operation_applied', 1);
  let count = 0;
  await assert.rejects(runScenario(workflow, SCENARIOS.multi, {
    boundary({ point }) {
      const current = count;
      count += 1;
      if (current === failAt) throw new Error('injected apply failure');
      if (point === 'recovery_step') throw new Error('injected rollback failure');
    },
  }), /injected apply failure/, 'the original error wins');
  assert.deepEqual(await journalStates(workflow, SCENARIO_REQUEST_ID), ['prepared', 'failed']);
  assert.equal((await txDirectories(workflow)).length, 1, 'scratch kept: the targets are half applied');
  assert.notEqual(await treeDigest(workflow), refs.old);

  await assertRecovers(t, workflow, 'multi', 'old');
  assert.deepEqual(await journalStates(workflow, SCENARIO_REQUEST_ID), ['prepared', 'failed'], 'no second failed record');
});

test('recoverTransactions is a standalone entry point that reports what it settled', async (t) => {
  const census = await censusOf(t, 'multi');
  const refs = await referenceTrees(t, 'multi');
  const providers = () => fakeProviders({ firstId: 7000 });
  const cases = [
    ['operation_applied', 1, 'rolled_back', refs.old, ['prepared', 'failed'], SCENARIO_REQUEST_ID],
    ['commit_marker', null, 'rolled_forward', refs.new, ['prepared', 'committed'], SCENARIO_REQUEST_ID],
    ['journal_committed', null, 'cleaned', refs.new, ['prepared', 'committed'], SCENARIO_REQUEST_ID],
    ['before_image_written', 0, 'discarded', refs.old, null, null],
    ['manifest_staged', null, 'discarded', refs.old, null, SCENARIO_REQUEST_ID],
    ['manifest_prepared', null, 'rolled_back', refs.old, null, SCENARIO_REQUEST_ID],
  ];
  for (const [point, index, outcome, tree, states, requestId] of cases) {
    const workflow = await crashAt(t, 'multi', point, index, census);
    const tx = await onlyTransaction(workflow);
    const first = await recoverTransactions({ ...workflow.options, providers: providers() });
    assert.equal(first.status, 'ok', point);
    assert.equal(first.recovered.length, 1, point);
    assert.equal(first.recovered[0].transaction, tx);
    assert.equal(first.recovered[0].outcome, outcome, point);
    assert.equal(first.recovered[0].request_id, requestId, `${point}: request ID read from the manifest when there is one`);
    assert.equal(await treeDigest(workflow), tree, point);
    assert.deepEqual(await txDirectories(workflow), [], point);
    assert.deepEqual(await journalStates(workflow, SCENARIO_REQUEST_ID), states, point);
    assert.deepEqual(await pendingMarkers(workflow), [], point);
    const second = await recoverTransactions({ ...workflow.options, providers: providers() });
    assert.deepEqual(second, { status: 'ok', recovered: [], findings: [] }, `${point}: idempotent`);
    assert.equal((await readLockOwner(workflow.options)).status, 'absent');
  }
});

test('recoverTransactions reports a blocked recovery with its finding and changes nothing', async (t) => {
  const census = await censusOf(t, 'multi');
  const workflow = await crashAt(t, 'multi', 'operation_applied', 1, census);
  const tx = await onlyTransaction(workflow);
  await rm(txPath(workflow, tx, 'before', '1'));
  const before = await stateOf(workflow);
  const result = await recoverTransactions({ ...workflow.options, providers: fakeProviders({ firstId: 7000 }) });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.findings.map(({ code }) => code), ['AKRS-C014']);
  assert.equal(result.findings[0].detail.reason, 'image_missing');
  assert.deepEqual(await stateOf(workflow), before);
});

test('recovery runs under the repository lock and reports a held lock instead of touching anything', async (t) => {
  const census = await censusOf(t, 'multi');
  const workflow = await crashAt(t, 'multi', 'operation_applied', 1, census);
  const before = await stateOf(workflow);
  const held = await acquireRepositoryLock({ ...workflow.options, command: 'other holder' });
  assert.equal(held.status, 'acquired');
  try {
    const result = await recoverTransactions({ ...workflow.options, providers: fakeProviders(), lockOptions: { timeoutMs: 50, retryMs: 5 } });
    assert.equal(result.status, 'lock_blocked');
    assert.equal(result.findings[0].code, 'AKRS-C009');
    const mutation = await runScenario(workflow, UNRELATED, { lockOptions: { timeoutMs: 50, retryMs: 5 } });
    assert.equal(mutation.result.outcome, 'lock_blocked');
  } finally {
    await held.handle.release();
  }
  assert.deepEqual(await stateOf(workflow), before);
});

test('a stale lock left by the crashed process does not stop recovery', async (t) => {
  const census = await censusOf(t, 'multi');
  const workflow = await crashAt(t, 'multi', 'operation_applied', 1, census);
  const lockEntries = await readdir(workflow.path('akrs', '.ops'));
  assert.ok(lockEntries.includes('lock'), 'the killed process still owned the lock');
  await assertRecovers(t, workflow, 'multi', 'old');
});
