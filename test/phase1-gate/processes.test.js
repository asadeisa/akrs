// Phase-1 gate 4, 5 and 7 and the lease half of A1 gate 15, with SEPARATE OS processes running the real bin/akrs.js (log)
// or the lease store (the idempotency worker): unique and duplicate appends, the rotation boundary, archived segments
// that stay byte-identical, and a lease race with exactly one winner.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { LOG_SEGMENT_LIMIT, readLog } from '../../lib/store/log/index.js';
import { readLease } from '../../lib/store/leases/index.js';
import { readLockOwner } from '../../lib/store/lock/index.js';
import { createIdempotencyWorkflow, startWorker } from '../idempotency/support.js';
import { cli, createRepo, listLog, logBytes, seedSegment } from '../log/support.js';

const SLOW = { timeout: 240_000 };
const append = (repo, subject, deviations = null) => cli(repo, [
  'log', 'append', '--kind', 'road', '--subject', subject, '--outcome', 'DONE', ...(deviations === null ? [] : ['--deviations', deviations]), '--json',
]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('gate 4+5+7: unique and duplicate appends and the rotation boundary across processes lose nothing; archived segments stay byte-identical', SLOW, async (t) => {
  const repo = await createRepo(t);
  await seedSegment(repo, 1, LOG_SEGMENT_LIMIT - 2);

  // wave 1: unique appends race over the rotation boundary (the active segment holds 78 of 80)
  const wave1 = await Promise.all(Array.from({ length: 6 }, (_, index) => append(repo, `R-wave1-${index}`)));
  for (const run of wave1) assert.equal(run.exitCode, 0, run.stderr || run.stdout);
  let log = await readLog(repo.options);
  assert.equal(log.records.length, LOG_SEGMENT_LIMIT - 2 + 6, 'no record lost');
  assert.deepEqual(log.segments.map(({ records }) => records.length), [LOG_SEGMENT_LIMIT, 4], 'rotation exactly at 80');
  assert.deepEqual(log.issues, []);
  assert.deepEqual(await listLog(repo), ['0001.jsonl', '0002.jsonl']);

  // wave 2: duplicate closures race — at most one is accepted; the archived segment is untouched
  const archived = sha(await logBytes(repo, '0001.jsonl'));
  const wave2 = await Promise.all(Array.from({ length: 5 }, (_, index) => append(repo, 'R-dup', `attempt ${index}`)));
  assert.deepEqual(wave2.map(({ exitCode }) => exitCode).sort(), [0, 1, 1, 1, 1], wave2.map(({ stderr }) => stderr).join());
  log = await readLog(repo.options);
  assert.equal(log.records.filter(({ subject }) => subject === 'R-dup').length, 1, 'at most one accepted closure');
  assert.equal(log.records.length, LOG_SEGMENT_LIMIT - 2 + 6 + 1);
  assert.equal(sha(await logBytes(repo, '0001.jsonl')), archived, 'the archived segment is byte-identical before and after');

  // wave 3: more appends into the active segment; the archived segment keeps its bytes
  const archivedAfter = [sha(await logBytes(repo, '0001.jsonl'))];
  const wave3 = await Promise.all(Array.from({ length: 6 }, (_, index) => append(repo, `R-wave3-${index}`)));
  for (const run of wave3) assert.equal(run.exitCode, 0, run.stderr || run.stdout);
  assert.deepEqual([sha(await logBytes(repo, '0001.jsonl'))], archivedAfter);
  log = await readLog(repo.options);
  assert.deepEqual(log.issues, []);
  assert.ok(log.segments.every(({ records }) => records.length <= LOG_SEGMENT_LIMIT), 'never an 81st line');
  assert.equal((await readLockOwner(repo.options)).status, 'absent');
});

test('A1 gate 15: separate processes race for one Road lease; exactly one wins and the lock is released', SLOW, async (t) => {
  const workflow = await createIdempotencyWorkflow(t);
  const holders = Array.from({ length: 6 }, (_, index) => `worker-${index}`);
  const startAt = Date.now() + 700;
  const runs = await Promise.all(holders.map((holder) => startWorker({ mode: 'lease', options: workflow.options, target: 'R1', holder, startAt })));
  for (const run of runs) assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(runs.filter(({ result }) => result.status === 'claimed').length, 1);
  assert.equal(runs.filter(({ result }) => result.status === 'blocked').length, 5);
  const winner = runs.findIndex(({ result }) => result.status === 'claimed');
  assert.equal((await readLease({ ...workflow.options, kind: 'road', target: 'R1' })).lease.holder, holders[winner]);
  assert.equal((await readLockOwner(workflow.options)).status, 'absent');
});
