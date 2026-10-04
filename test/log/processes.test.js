// Separate Node processes race for the repository lock: unique appends, the duplicate closure and the rotation
// boundary. No record may be lost and the ledger must stay valid.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOG_SEGMENT_LIMIT, readLog } from '../../lib/store/log/index.js';
import { cli, createRepo, seedSegment } from './support.js';

const SLOW = { timeout: 180_000 };
const append = (repo, subject, deviations = null) => cli(repo, [
  'log', 'append', '--kind', 'road', '--subject', subject, '--outcome', 'DONE', ...(deviations === null ? [] : ['--deviations', deviations]), '--json',
]);

test('unique appends from separate processes lose no record', SLOW, async (t) => {
  const repo = await createRepo(t);
  const runs = await Promise.all(Array.from({ length: 6 }, (_, index) => append(repo, `R-race-${index}`)));
  for (const run of runs) assert.equal(run.exitCode, 0, run.stderr || run.stdout);
  const log = await readLog(repo.options);
  assert.deepEqual(log.records.map(({ subject }) => subject).sort(), Array.from({ length: 6 }, (_, index) => `R-race-${index}`));
  assert.deepEqual(log.issues, []);
});

test('the duplicate closure race accepts at most one record', SLOW, async (t) => {
  const repo = await createRepo(t);
  const runs = await Promise.all(Array.from({ length: 5 }, (_, index) => append(repo, 'R-dup', `attempt ${index}`)));
  const codes = runs.map(({ exitCode }) => exitCode).sort();
  assert.deepEqual(codes, [0, 1, 1, 1, 1], runs.map(({ stderr }) => stderr).join());
  assert.equal((await readLog(repo.options)).records.length, 1);
});

test('the rotation boundary race keeps every record and exactly 80 lines in the full segment', SLOW, async (t) => {
  const repo = await createRepo(t);
  await seedSegment(repo, 1, LOG_SEGMENT_LIMIT - 2);
  const runs = await Promise.all(Array.from({ length: 5 }, (_, index) => append(repo, `R-edge-${index}`)));
  for (const run of runs) assert.equal(run.exitCode, 0, run.stderr || run.stdout);
  const log = await readLog(repo.options);
  assert.equal(log.records.length, LOG_SEGMENT_LIMIT + 3);
  assert.deepEqual(log.segments.map(({ records }) => records.length), [LOG_SEGMENT_LIMIT, 3]);
  assert.deepEqual(log.issues, []);
});
