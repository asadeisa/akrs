import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { verifyMeta } from '../../lib/store/canonical/index.js';
import { ROAD_KEYS, ROAD_SPEC, validateRoad } from '../../lib/schemas/road.js';
import {
  GENERATOR,
  RoadStoreError,
  buildStoredRoad,
  collectIdentities,
  listRoadFiles,
  readRoad,
  renderRoad,
  roadPath,
  taskPath,
  draftPath,
} from '../../lib/store/roads/index.js';
import { createRepo, roadInput, roadText, seedPlan, seedRoad, storedRoad } from './support.js';

const full = JSON.parse(await readFile(new URL('../fixtures/schemas/road/valid/full.json', import.meta.url), 'utf8'));
const { status: _status, meta: _meta, ...FULL_INPUT } = full;

test('placement: plan folder when a Plan is set, flat in the no-Plan tier; the base name is the explicit ID', () => {
  assert.equal(roadPath({ id: 'R-P6-1', plan: 'P6' }), 'roads/P6/R-P6-1.json');
  assert.equal(roadPath({ id: 'R1', plan: null }), 'roads/R1.json');
  assert.equal(roadPath({ id: 'R1' }), 'roads/R1.json');
  assert.equal(taskPath('T-P6-1'), 'tasks/T-P6-1.md');
  assert.equal(draftPath('road-a'), 'drafts/road-a.json');
  for (const bad of ['', 'a/b', '../x', 'a b', 'CON', null, 5]) {
    assert.throws(() => roadPath({ id: bad }), TypeError, String(bad));
    assert.throws(() => taskPath(bad), TypeError, String(bad));
    assert.throws(() => draftPath(bad), TypeError, String(bad));
  }
  assert.throws(() => roadPath({ id: 'R1', plan: '../x' }), TypeError);
});

test('buildStoredRoad fills only status and meta: every submitted field is carried unchanged', () => {
  const stored = buildStoredRoad(FULL_INPUT);
  assert.deepEqual(Object.keys(stored), ROAD_KEYS);
  assert.equal(stored.status, 'QUEUED');
  assert.equal(stored.meta.generator, GENERATOR);
  assert.match(stored.meta.content_hash, /^sha256:[0-9a-f]{64}$/);
  const { status, meta, ...rest } = stored;
  // sets are stored code-point sorted; the fixture is authored sorted, so nothing may differ at all
  assert.deepEqual(rest, FULL_INPUT);
  assert.equal(validateRoad(stored, { form: 'stored' }).ok, true);
});

test('buildStoredRoad never invents, reorders ordered arrays, or accepts CLI-owned keys', () => {
  const input = roadInput({
    deps: ['R-b', 'R-a'],
    reads: [
      { path: 'SOT/09-use-cases.md', lines: [30, 31], why: 'second window first' },
      { path: 'SOT/09-use-cases.md', lines: [1, 2], why: null },
    ],
    acceptance: ['second', 'first'],
    steps: ['z step', 'a step'],
    writes: [
      { path: 'z/file.js', class: 'file', action: 'create' },
      { path: 'a/file.js', class: 'file', action: 'modify' },
    ],
  });
  const stored = buildStoredRoad(input);
  assert.deepEqual(stored.deps, ['R-a', 'R-b'], 'sets are sorted');
  assert.deepEqual(stored.writes.map(({ path }) => path), ['a/file.js', 'z/file.js'], 'writes are sorted by path');
  assert.deepEqual(stored.reads, input.reads, 'reads keep authored order, lines and why');
  assert.deepEqual(stored.acceptance, ['second', 'first']);
  assert.deepEqual(stored.steps, ['z step', 'a step']);
  assert.throws(() => buildStoredRoad({ ...input, status: 'ACTIVE' }), TypeError);
  assert.throws(() => buildStoredRoad({ ...input, meta: { generator: 'x', content_hash: 'sha256:' } }), TypeError);
  assert.throws(() => buildStoredRoad({ ...input, extra: 1 }), TypeError);
});

test('renderRoad is canonical: LF, one final newline, idempotent, and the hash verifies as declared', () => {
  const stored = buildStoredRoad(FULL_INPUT);
  const text = renderRoad(stored);
  assert.equal(text.endsWith('\n'), true);
  assert.equal(text.endsWith('\n\n'), false);
  assert.equal(text.includes('\r'), false);
  assert.equal(text, roadText(storedRoad(FULL_INPUT)), 'same bytes as the codec called directly');
  assert.equal(verifyMeta(JSON.parse(text), { spec: ROAD_SPEC }), 'declared');
  assert.equal(renderRoad(JSON.parse(text)), text);
});

test('readRoad returns { road, meta_state, path, issues }: declared when the hash and schema hold', async (t) => {
  const repo = await createRepo(t);
  const stored = buildStoredRoad(roadInput());
  await repo.write('akrs/roads/P6/R-P6-1.json', renderRoad(stored));
  const found = await readRoad({ ...repo.options, id: 'R-P6-1' });
  assert.deepEqual(Object.keys(found).sort(), ['issues', 'meta_state', 'path', 'road']);
  assert.deepEqual(found.road, stored);
  assert.equal(found.meta_state, 'declared');
  assert.equal(found.path, 'akrs/roads/P6/R-P6-1.json');
  assert.deepEqual(found.issues, []);
});

test('readRoad: a hand edit makes the Road unverified, never accepted silently', async (t) => {
  const repo = await createRepo(t);
  const stored = buildStoredRoad(roadInput());
  const edited = { ...stored, acceptance: ['edited by hand'] };
  await repo.write('akrs/roads/R-P6-1.json', renderRoad(edited));
  const found = await readRoad({ ...repo.options, id: 'R-P6-1' });
  assert.equal(found.meta_state, 'unverified');
  assert.deepEqual(found.road.acceptance, ['edited by hand']);

  const { meta: _dropped, ...noMeta } = stored;
  await repo.write('akrs/roads/R-P6-2.json', `${JSON.stringify({ ...noMeta, id: 'R-P6-2' }, null, 2)}\n`);
  const missingMeta = await readRoad({ ...repo.options, id: 'R-P6-2' });
  assert.equal(missingMeta.meta_state, 'unverified');
  assert.equal(missingMeta.issues.some(({ code }) => code === 'missing_key'), true);
});

test('readRoad: absent is null, two files with one base name is ambiguous, garbage is unreadable', async (t) => {
  const repo = await createRepo(t);
  assert.equal(await readRoad({ ...repo.options, id: 'R-none' }), null);
  await seedRoad(repo, { id: 'R-dup' });
  await seedRoad(repo, { id: 'R-dup' }, { folder: 'roads/nested' });
  await assert.rejects(() => readRoad({ ...repo.options, id: 'R-dup' }), (error) => error instanceof RoadStoreError && error.code === 'ambiguous');
  await repo.write('akrs/roads/R-bad.json', '{ not json');
  await assert.rejects(() => readRoad({ ...repo.options, id: 'R-bad' }), (error) => error instanceof RoadStoreError && error.code === 'unreadable');
  await assert.rejects(() => readRoad({ ...repo.options, id: 'bad id' }), TypeError);
});

test('nested plan folders: Roads are found in any folder under roads/, identified by base name only', async (t) => {
  const repo = await createRepo(t);
  await seedRoad(repo, { id: 'R-flat' });
  await seedRoad(repo, { id: 'R-p6', plan: 'P6' }, { folder: 'roads/P6' });
  await seedRoad(repo, { id: 'R-deep' }, { folder: 'roads/P7/sub/deeper' });
  await repo.write('akrs/roads/README.md', '# not a Road\n');
  const files = await listRoadFiles(repo.options);
  assert.deepEqual(files.map(({ id }) => id), ['R-deep', 'R-flat', 'R-p6']);
  assert.deepEqual(files.map(({ path }) => path), [
    'akrs/roads/P7/sub/deeper/R-deep.json', 'akrs/roads/R-flat.json', 'akrs/roads/P6/R-p6.json',
  ], 'ordered by ID, then path');
  assert.deepEqual(files.map(({ workflow_path: path }) => path), files.map(({ path }) => path.slice('akrs/'.length)));
  const deep = await readRoad({ ...repo.options, id: 'R-deep' });
  assert.equal(deep.path, 'akrs/roads/P7/sub/deeper/R-deep.json');
  assert.equal(deep.road.id, 'R-deep');
});

test('collectIdentities lists Roads and Plans in one namespace with their files', async (t) => {
  const repo = await createRepo(t);
  await seedRoad(repo, { id: 'R1' });
  await seedRoad(repo, { id: 'R2', plan: 'P6' }, { folder: 'roads/P6' });
  await seedPlan(repo, 'P6');
  await repo.write('akrs/plans/notes.txt', 'ignored');
  const identities = await collectIdentities(repo.options);
  assert.deepEqual(identities, [
    { id: 'P6', kind: 'plan', path: 'akrs/plans/P6.json' },
    { id: 'R1', kind: 'road', path: 'akrs/roads/R1.json' },
    { id: 'R2', kind: 'road', path: 'akrs/roads/P6/R2.json' },
  ]);
});

test('an empty or absent roads folder yields no identities', async (t) => {
  const repo = await createRepo(t);
  assert.deepEqual(await listRoadFiles(repo.options), []);
  assert.deepEqual(await collectIdentities(repo.options), []);
});
