// P1-W04 / F8 + F17: separate Node processes race for the journal and the lease store.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { readLease } from '../../lib/store/leases/index.js';
import { readOp } from '../../lib/store/journal/index.js';
import { readLockOwner } from '../../lib/store/lock/index.js';
import {
  createIdempotencyWorkflow,
  listNames,
  readRecords,
  startWorker,
  ulid,
  workflowSnapshot,
} from './support.js';

const SLOW = { timeout: 120_000 };

async function lines(path) {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

const startIn = (ms) => Date.now() + ms;
const count = (results, outcome) => results.filter(({ result }) => result.outcome === outcome).length;
const countStatus = (results, status) => results.filter(({ result }) => result.status === status).length;

function assertAllClean(runs) {
  for (const run of runs) {
    assert.equal(run.exitCode, 0, run.stderr);
    assert.notEqual(run.result, null, run.stdout);
  }
}

test('concurrent identical requests with the same ID commit once; the rest replay as noop', SLOW, async (t) => {
  const workflow = await createIdempotencyWorkflow(t);
  const logFile = workflow.path('applied.log');
  const id = ulid(7);
  const input = { name: 'race', body: 'one body' };
  const startAt = startIn(700);
  const runs = await Promise.all(Array.from({ length: 6 }, () => startWorker({
    mode: 'mutation', options: workflow.options, requestId: id, input, logFile, startAt,
  })));
  assertAllClean(runs);
  assert.equal(count(runs, 'committed'), 1, JSON.stringify(runs.map((run) => run.result)));
  assert.equal(count(runs, 'replayed'), 5);
  for (const { result } of runs) assert.equal(result.request_id, id);
  for (const { result } of runs.filter(({ result: item }) => item.outcome === 'replayed')) {
    assert.equal(result.status, 'noop');
    assert.equal(result.replayed.request_id, id);
  }
  assert.equal((await lines(logFile)).length, 1, 'the mutation ran exactly once');
  assert.deepEqual((await readRecords(workflow, id)).map(({ state }) => state), ['prepared', 'committed']);
  assert.equal((await readLockOwner(workflow.options)).status, 'absent');
});

test('concurrent identical requests with generated IDs commit once; the rest replay with the original ID', SLOW, async (t) => {
  const workflow = await createIdempotencyWorkflow(t);
  const logFile = workflow.path('applied.log');
  const input = { name: 'generated', body: 'same body' };
  const startAt = startIn(700);
  const runs = await Promise.all(Array.from({ length: 6 }, () => startWorker({
    mode: 'mutation', options: workflow.options, input, logFile, startAt,
  })));
  assertAllClean(runs);
  assert.equal(count(runs, 'committed'), 1, JSON.stringify(runs.map((run) => run.result)));
  assert.equal(count(runs, 'replayed'), 5);
  const winner = runs.find(({ result }) => result.outcome === 'committed').result.request_id;
  for (const { result } of runs) assert.equal(result.request_id, winner, 'every process reports the original ID');
  assert.equal((await lines(logFile)).length, 1);
  assert.deepEqual(await listNames(workflow.path('akrs', '.ops', 'journal', 'ops')), [`${winner}.jsonl`]);
  assert.equal((await readOp({ ...workflow.options, requestId: winner })).status, 'committed');
});

test('legitimately different appends racing from several processes all land; exact duplicates land once', SLOW, async (t) => {
  const workflow = await createIdempotencyWorkflow(t);
  const logFile = workflow.path('applied.log');
  const names = ['a', 'a', 'b', 'b', 'c', 'd'];
  const startAt = startIn(700);
  const runs = await Promise.all(names.map((name) => startWorker({
    mode: 'mutation', options: workflow.options, dedupe: 'append', command: 'log-append',
    input: { name, body: `body ${name}` }, logFile, startAt,
  })));
  assertAllClean(runs);
  assert.equal(count(runs, 'committed'), 4, JSON.stringify(runs.map((run) => run.result)));
  assert.equal(count(runs, 'replayed'), 2);
  assert.equal((await lines(logFile)).length, 4);
  assert.equal((await listNames(workflow.path('akrs', '.ops', 'journal', 'ops'))).length, 4);
  for (const name of ['a', 'b', 'c', 'd']) {
    assert.equal(await readFile(workflow.path('akrs', 'memory', `${name}.md`), 'utf8'), `body ${name}`);
  }
});

test('the same ID with different input racing from several processes admits one request and refuses the rest', SLOW, async (t) => {
  const workflow = await createIdempotencyWorkflow(t);
  const logFile = workflow.path('applied.log');
  const id = ulid(8);
  const startAt = startIn(700);
  const runs = await Promise.all(['x', 'y', 'z', 'w'].map((name) => startWorker({
    mode: 'mutation', options: workflow.options, requestId: id, input: { name, body: name }, logFile, startAt,
  })));
  assertAllClean(runs);
  assert.equal(count(runs, 'committed'), 1);
  assert.equal(count(runs, 'conflict'), 3);
  assert.equal((await lines(logFile)).length, 1);
  assert.deepEqual((await readRecords(workflow, id)).map(({ state }) => state), ['prepared', 'committed']);
});

test('separate-process races on the lease store admit exactly one holder', SLOW, async (t) => {
  const workflow = await createIdempotencyWorkflow(t);
  const holders = ['worker-1', 'worker-2', 'worker-3', 'worker-4', 'worker-5', 'worker-6'];
  const startAt = startIn(700);
  const runs = await Promise.all(holders.map((holder) => startWorker({
    mode: 'lease', options: workflow.options, target: 'R1', holder, startAt,
  })));
  assertAllClean(runs);
  assert.equal(countStatus(runs, 'claimed'), 1, JSON.stringify(runs.map((run) => run.result)));
  assert.equal(countStatus(runs, 'blocked'), 5);
  const winner = runs.findIndex(({ result }) => result.status === 'claimed');
  const stored = (await readLease({ ...workflow.options, kind: 'road', target: 'R1' })).lease;
  assert.equal(stored.holder, holders[winner]);
  for (const { result } of runs.filter(({ result: item }) => item.status === 'blocked')) {
    assert.equal(result.holder, holders[winner], 'every loser names the winner');
  }
  assert.equal((await readLockOwner(workflow.options)).status, 'absent');

  // explicit takeover from another process changes the holder; plain claimers still cannot
  const takeover = await startWorker({ mode: 'lease', options: workflow.options, target: 'R1', holder: 'worker-9', takeover: true });
  assertAllClean([takeover]);
  assert.equal(takeover.result.status, 'taken_over');
  assert.equal(takeover.result.previous_holder, holders[winner]);
  assert.equal((await readLease({ ...workflow.options, kind: 'road', target: 'R1' })).lease.holder, 'worker-9');
  const loser = await startWorker({ mode: 'lease', options: workflow.options, target: 'R1', holder: holders[winner] });
  assert.equal(loser.result.status, 'blocked');
  assert.equal(loser.result.holder, 'worker-9');
});

test('several processes claiming as the same holder: one claim, the rest noop', SLOW, async (t) => {
  const workflow = await createIdempotencyWorkflow(t);
  const startAt = startIn(700);
  const runs = await Promise.all(Array.from({ length: 4 }, () => startWorker({
    mode: 'lease', options: workflow.options, target: 'R1', holder: 'worker-1', startAt,
  })));
  assertAllClean(runs);
  assert.equal(countStatus(runs, 'claimed'), 1);
  assert.equal(countStatus(runs, 'noop'), 3);
});

test('journal commits and lease claims from many processes share one lock without losing any of them', SLOW, async (t) => {
  const workflow = await createIdempotencyWorkflow(t);
  const logFile = workflow.path('applied.log');
  const startAt = startIn(700);
  const mutations = ['m1', 'm2', 'm3'].map((name) => startWorker({
    mode: 'mutation', options: workflow.options, input: { name, body: name }, logFile, startAt, holdMs: 20,
  }));
  const leases = ['worker-1', 'worker-2', 'worker-3'].map((holder) => startWorker({
    mode: 'lease', options: workflow.options, target: 'R2', holder, startAt,
  }));
  const [mutationRuns, leaseRuns] = [await Promise.all(mutations), await Promise.all(leases)];
  assertAllClean([...mutationRuns, ...leaseRuns]);
  assert.equal(count(mutationRuns, 'committed'), 3);
  assert.equal(countStatus(leaseRuns, 'claimed'), 1);
  assert.equal(countStatus(leaseRuns, 'blocked'), 2);
  assert.equal((await lines(logFile)).length, 3);
  assert.notEqual(await workflowSnapshot(workflow), null);
  assert.equal((await readLockOwner(workflow.options)).status, 'absent');
});
