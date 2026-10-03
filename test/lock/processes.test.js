// P1-W03 / F7: separate Node processes. Exclusivity, a live holder, a killed holder and concurrent recoverers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { acquireRepositoryLock, readLockOwner } from '../../lib/store/lock/index.js';
import {
  createLockWorkflow,
  hostName,
  listDirectory,
  runWorker,
  startWorker,
} from './support.js';

const SLOW = { timeout: 90_000 };

async function markerLines(path) {
  return (await readFile(path, 'utf8')).split('\n').filter(Boolean);
}

test('several processes never interleave inside the critical section', SLOW, async (t) => {
  const workflow = await createLockWorkflow(t);
  const markerFile = workflow.path('markers.log');
  const workers = 5;
  const iterations = 4;
  const runs = await Promise.all(Array.from({ length: workers }, (_, index) => runWorker({
    mode: 'critical',
    id: `w${index}`,
    iterations,
    holdMs: 8,
    timeoutMs: 60_000,
    retryMs: 5,
    markerFile,
    options: workflow.options,
  })));

  for (const run of runs) assert.equal(run.exitCode, 0, run.stderr);
  const lines = await markerLines(markerFile);
  assert.equal(lines.length, workers * iterations * 2);
  // Strict alternation: every "enter x" is immediately followed by "exit x".
  for (let index = 0; index < lines.length; index += 2) {
    const [enterWord, enterId] = lines[index].split(' ');
    assert.equal(enterWord, 'enter', `line ${index}: ${lines[index]}`);
    assert.equal(lines[index + 1], `exit ${enterId}`, `critical sections interleaved near line ${index}`);
  }
  for (let index = 0; index < workers; index += 1) {
    assert.equal(lines.filter((line) => line === `enter w${index}`).length, iterations);
  }
  assert.deepEqual(await listDirectory(workflow.opsDir), [], 'every holder released');
  assert.deepEqual(runs.flatMap(({ result }) => result.recovered), [], 'no live holder was ever recovered');
});

test('a live holder in another process is not stolen even when its lock looks ancient', SLOW, async (t) => {
  const workflow = await createLockWorkflow(t);
  const holder = startWorker({
    mode: 'hold', options: workflow.options, timeoutMs: 5000, fixedNow: '2000-01-01T00:00:00.000Z',
  });
  t.after(() => holder.kill());
  const ready = JSON.parse(await holder.nextLine());
  assert.equal(ready.status, 'acquired');

  const before = await readFile(workflow.ownerFile, 'utf8');
  const blocked = await acquireRepositoryLock({ ...workflow.options, command: 'x', timeoutMs: 150, retryMs: 25 });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'held');
  assert.equal(blocked.holder.pid, holder.child.pid);
  assert.equal(blocked.holder.host, hostName());
  assert.equal(blocked.holder.acquired_at, '2000-01-01T00:00:00.000Z');
  assert.equal(blocked.recovered, null);
  assert.equal(await readFile(workflow.ownerFile, 'utf8'), before);
});

test('a lock whose holder process was killed is recovered by the next acquirer', SLOW, async (t) => {
  const workflow = await createLockWorkflow(t);
  const holder = startWorker({ mode: 'hold', options: workflow.options, timeoutMs: 5000 });
  const ready = JSON.parse(await holder.nextLine());
  assert.equal(ready.status, 'acquired');
  assert.equal((await readLockOwner(workflow.options)).owner.pid, holder.child.pid);

  await holder.kill();
  assert.equal((await readLockOwner(workflow.options)).status, 'valid', 'termination leaves the lock behind');

  const next = await acquireRepositoryLock({ ...workflow.options, command: 'recover', timeoutMs: 2000, retryMs: 10 });
  assert.equal(next.status, 'acquired');
  assert.deepEqual(next.recovered, { pid: holder.child.pid, host: hostName(), run_id: ready.run_id });
  assert.deepEqual(await listDirectory(workflow.opsDir), ['lock']);
  assert.deepEqual(await next.handle.release(), { released: true });
  assert.deepEqual(await listDirectory(workflow.opsDir), []);
});

test('a dead owner is recovered exactly once even with several concurrent recoverers', SLOW, async (t) => {
  const workflow = await createLockWorkflow(t);
  for (let round = 0; round < 3; round += 1) {
    const holder = startWorker({ mode: 'hold', options: workflow.options, timeoutMs: 5000 });
    const ready = JSON.parse(await holder.nextLine());
    assert.equal(ready.status, 'acquired', `round ${round}`);
    await holder.kill();

    const runs = await Promise.all(Array.from({ length: 5 }, () => runWorker({
      mode: 'once', options: workflow.options, timeoutMs: 30_000, retryMs: 5, holdMs: 15,
    })));
    for (const run of runs) {
      assert.equal(run.exitCode, 0, run.stderr);
      assert.equal(run.result.status, 'acquired', `round ${round}: ${run.stdout}`);
      assert.deepEqual(run.result.released, { released: true }, run.stdout);
    }
    const recoveries = runs.map(({ result }) => result.recovered).filter((recovered) => recovered !== null);
    assert.equal(recoveries.length, 1, `round ${round}: exactly one recoverer`);
    assert.deepEqual(recoveries[0], { pid: holder.child.pid, host: hostName(), run_id: ready.run_id });
    assert.deepEqual(await listDirectory(workflow.opsDir), [], `round ${round}: lock free and no stale directory left`);
  }
});

test('a contender that times out against a live process gets a blocked result, not an exception', SLOW, async (t) => {
  const workflow = await createLockWorkflow(t);
  const holder = startWorker({ mode: 'hold', options: workflow.options, timeoutMs: 5000 });
  t.after(() => holder.kill());
  await holder.nextLine();

  const contender = await runWorker({ mode: 'once', options: workflow.options, timeoutMs: 100, retryMs: 20 });
  assert.equal(contender.exitCode, 0, contender.stderr);
  assert.equal(contender.result.status, 'blocked');
  assert.equal(contender.result.reason, 'held');
  assert.equal(contender.result.finding.code, 'AKRS-C009');
  assert.equal(contender.result.holder.pid, holder.child.pid);
});
