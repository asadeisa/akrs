// P2-W14: the run record and its evidence files: layout, atomic write order, measured refs, and the reader.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validateRun, RUN_SPEC } from '../../lib/schemas/verification.js';
import { parseStrictJson, verifyMeta } from '../../lib/store/canonical/index.js';
import { createPathService } from '../../lib/store/path-service.js';
import { buildRunRecord, evidencePath, readRuns, writeRunFiles } from '../../lib/store/test-run/record.js';
import { ULID_RE, runWorld } from './support.js';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SNAP = `sha256:${'a'.repeat(64)}`;
const HASH = `sha256:${'b'.repeat(64)}`;
const input = (extra = {}) => ({
  id: ID, plan: 'P6', snapshot: SNAP, contractHash: HASH, startedAt: '2026-10-04T10:00:00.000Z', endedAt: '2026-10-04T10:00:02.000Z', status: 'passed',
  steps: [{ index: 0, step: 'http', status: 'passed', soft: false, duration_ms: 12, detail: 'GET /health -> 200', evidence: [] }], evidence: [], workflowRoot: 'akrs', ...extra,
});

test('evidence lives under verifications/<plan>/evidence/<run-id>/ with plain file names', () => {
  assert.equal(evidencePath('P6', ID, 'home.png'), `verifications/P6/evidence/${ID}/home.png`);
  assert.equal(evidencePath('P6', ID, 'run.json'), `verifications/P6/evidence/${ID}/run.json`);
  for (const bad of ['../x', 'a/b', '', '.hidden', 'x y', 'a'.repeat(100)]) assert.throws(() => evidencePath('P6', ID, bad), TypeError, bad);
});

test('a run record is the closed akrs.run/v1 document, stamped, valid and verifiable', () => {
  const { stored, text } = buildRunRecord(input());
  assert.equal(validateRun(stored, { form: 'stored', workflowRoot: 'akrs' }).ok, true, JSON.stringify(validateRun(stored, { form: 'stored', workflowRoot: 'akrs' }).issues));
  assert.equal(verifyMeta(stored, { spec: RUN_SPEC }), 'declared');
  assert.equal(text.endsWith('\n'), true);
  assert.deepEqual(parseStrictJson(text).value, stored);
});

test('a record that contradicts itself is refused at build time', () => {
  assert.throws(() => buildRunRecord(input({ status: 'passed', steps: [{ index: 0, step: 'http', status: 'failed', soft: false, duration_ms: 1, detail: null, evidence: [] }] })), /passed run has no failed hard/);
});

test('the files are written under the run directory, the record last, with measured refs', async (t) => {
  const repo = await runWorld(t);
  const service = await createPathService(repo.options);
  const written = await writeRunFiles({
    service, plan: 'P6', runId: ID,
    artifacts: [{ type: 'screenshot', name: 'home.png', data: Buffer.from('PNG') }, { type: 'log', name: 'app.log', data: Buffer.from('hello\n') }],
    makeRecord: (refs) => input({ evidence: refs }),
  });
  assert.deepEqual(written.evidence.map(({ path, type, bytes }) => [path, type, bytes]), [
    [`akrs/verifications/P6/evidence/${ID}/app.log`, 'log', 6],
    [`akrs/verifications/P6/evidence/${ID}/home.png`, 'screenshot', 3],
  ]);
  assert.match(written.evidence[0].sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(written.record_path, `akrs/verifications/P6/evidence/${ID}/run.json`);
  assert.deepEqual(written.changed, [`akrs/verifications/P6/evidence/${ID}/app.log`, `akrs/verifications/P6/evidence/${ID}/home.png`, `akrs/verifications/P6/evidence/${ID}/run.json`]);
  assert.equal(await readFile(repo.path(written.record_path), 'utf8').then((text) => JSON.parse(text).evidence.length), 2);
  assert.equal((await readdir(repo.path(`akrs/verifications/P6/evidence/${ID}`))).filter((name) => name.includes('.tmp')).length, 0);
});

test('an existing run directory is never reused', async (t) => {
  const repo = await runWorld(t);
  const service = await createPathService(repo.options);
  await mkdir(repo.path(`akrs/verifications/P6/evidence/${ID}`), { recursive: true });
  await assert.rejects(writeRunFiles({ service, plan: 'P6', runId: ID, artifacts: [], makeRecord: () => input() }), /already exists/);
});

test('a failure while writing removes what was written, so no half run stays behind', async (t) => {
  const repo = await runWorld(t);
  const service = await createPathService(repo.options);
  await assert.rejects(writeRunFiles({
    service, plan: 'P6', runId: ID, artifacts: [{ type: 'log', name: 'app.log', data: Buffer.from('x') }],
    makeRecord: () => { throw new Error('record failed'); },
  }), /record failed/);
  assert.equal(existsSync(repo.path(`akrs/verifications/P6/evidence/${ID}`)), false);
});

test('the reader lists runs newest first and reports unreadable or half-written ones', async (t) => {
  const repo = await runWorld(t);
  const service = await createPathService(repo.options);
  const older = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const newer = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
  for (const id of [older, newer]) await writeRunFiles({ service, plan: 'P6', runId: id, artifacts: [], makeRecord: () => input({ id }) });
  await mkdir(repo.path('akrs/verifications/P6/evidence/01ARZ3NDEKTSV4RRFFQ69G5FB1'), { recursive: true });
  await mkdir(repo.path('akrs/verifications/P6/evidence/01ARZ3NDEKTSV4RRFFQ69G5FB2'), { recursive: true });
  await writeFile(repo.path('akrs/verifications/P6/evidence/01ARZ3NDEKTSV4RRFFQ69G5FB2/run.json'), '{"not":"a run"}\n');
  await mkdir(repo.path('akrs/verifications/P6/evidence/screenshots'), { recursive: true });
  const found = await readRuns({ ...repo.options, key: 'P6' });
  assert.deepEqual(found.runs.map(({ id }) => id), [newer, older]);
  assert.deepEqual(found.problems.map(({ id, reason }) => [id, reason]), [['01ARZ3NDEKTSV4RRFFQ69G5FB1', 'incomplete'], ['01ARZ3NDEKTSV4RRFFQ69G5FB2', 'invalid_record']]);
  assert.match(ID, ULID_RE);
});

test('a plan with no evidence directory has no runs and no problems', async (t) => {
  const repo = await runWorld(t);
  assert.deepEqual(await readRuns({ ...repo.options, key: 'P6' }), { runs: [], problems: [] });
});
