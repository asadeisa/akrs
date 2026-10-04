import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PATH_SAFETY_POLICY,
  PathSafetyError,
  createPathService,
  validateRestrictedPath,
} from '../../lib/store/path-service.js';
import { createTempRepository } from '../helpers/temp-repository.js';
import { byteTreeHash } from '../helpers/byte-tree.js';
import { runCli } from '../helpers/process.js';
import { createRepo, seedRoad } from '../road/support.js';

const caseFixture = fileURLToPath(new URL('../fixtures/path-safety/case/', import.meta.url));

test('path-safety fixture preserves provenance and exact case-sensitive bytes', async () => {
  const provenance = JSON.parse(await readFile(new URL(
    '../fixtures/path-safety/case/provenance.json', import.meta.url), 'utf8'));
  assert.deepEqual(provenance, {
    fixture: 'path-safety/case',
    capturedOn: '2026-08-26',
    evidenceMeasuredOn: '2026-08-18',
    bugIds: ['B23'],
    sources: [{
      kind: 'synthetic-regression',
      project: 'AKRS v2 evidence',
      path: 'plans/update-to-v-2.0.0/source-opus-plan/06-bug-register.md#B23',
    }],
    runtimeFiles: ['Expected.txt', 'akrs/roads/R1.md'],
    notes: 'The Road intentionally declares expected.txt while the entry is Expected.txt so every host reports the same case finding.',
  });
  assert.equal(await readFile(new URL(
    '../fixtures/path-safety/case/Expected.txt', import.meta.url), 'utf8'),
  'case-sensitive fixture\n');
  assert.equal(await readFile(new URL(
    '../fixtures/path-safety/case/akrs/roads/R1.md', import.meta.url), 'utf8'), [
    '# Road R1', '', 'Status: ACTIVE', '', '## Expected files', '', '- `expected.txt`', '',
  ].join('\n'));
});

test('B12 every repository and workflow resolver shares one canonical repository root', async (t) => {
  const temporary = await createTempRepository(t, { prefix: 'akrs-one-root-' });
  await mkdir(temporary.path('akrs'), { recursive: true });
  const service = await createPathService({
    repositoryRoot: temporary.root,
    workflowRoot: temporary.path('akrs'),
  });

  const repositoryTarget = await service.resolveRepositoryPath('src/new.js');
  const workflowTarget = await service.resolveWorkflowPath('roads/R1.json');

  assert.equal(repositoryTarget.repository_root, service.repository_root);
  assert.equal(workflowTarget.repository_root, service.repository_root);
  assert.equal(repositoryTarget.relative_path, 'src/new.js');
  assert.equal(workflowTarget.relative_path, 'akrs/roads/R1.json');
  // The temp root may be an 8.3 short alias on Windows; the service reports the canonical long path.
  const canonicalRoot = await realpath(temporary.root);
  assert.equal(repositoryTarget.absolute_path, join(canonicalRoot, 'src', 'new.js').replaceAll('\\', '/'));
  assert.equal(workflowTarget.absolute_path, join(canonicalRoot, 'akrs', 'roads', 'R1.json').replaceAll('\\', '/'));
});

test('B13 restricted paths reject lexical escape and Windows-specific ambiguous forms on every OS', () => {
  const rejected = [
    '../outside',
    'akrs/../outside',
    '/absolute/path',
    'C:/absolute/path',
    'C:drive-relative',
    '//server/share/path',
    '\\\\server\\share\\path',
    '\\\\?\\C:\\device\\path',
    'akrs/LOG.md\0suffix',
    'akrs/file.txt:stream',
    'akrs\\roads\\R1.json',
    'akrs//roads/R1.json',
    './akrs/state.json',
    'akrs/*.json',
  ];

  for (const value of rejected) {
    assert.throws(() => validateRestrictedPath(value), PathSafetyError, value);
  }
  assert.equal(validateRestrictedPath('akrs/roads/R1.json'), 'akrs/roads/R1.json');
  assert.deepEqual(PATH_SAFETY_POLICY.path_classes, ['file', 'dir', 'glob', 'ephemeral']);
  assert.equal(PATH_SAFETY_POLICY.glob_grammar, 'restricted_star_question_globstar_v1');
});

test('B13 existing symlinks and nearest existing ancestors cannot escape the repository', async (t) => {
  const repository = await createTempRepository(t, { prefix: 'akrs-containment-root-' });
  const outside = await createTempRepository(t, { prefix: 'akrs-containment-outside-' });
  await mkdir(repository.path('akrs'), { recursive: true });
  await writeFile(outside.path('secret.txt'), 'outside\n');
  const link = repository.path('escape-link');
  await symlink(outside.root, link, process.platform === 'win32' ? 'junction' : 'dir');
  const service = await createPathService({
    repositoryRoot: repository.root,
    workflowRoot: repository.path('akrs'),
  });

  await assert.rejects(
    service.resolveRepositoryPath('escape-link/secret.txt', { mustExist: true }),
    PathSafetyError,
  );
  await assert.rejects(
    service.resolveRepositoryPath('escape-link/not-created/yet.txt'),
    PathSafetyError,
  );
});

test('B23 case mismatches produce the same stable finding on case-sensitive and insensitive hosts', async (t) => {
  const temporary = await createTempRepository(t, {
    prefix: 'akrs-case-',
    fixture: caseFixture,
  });
  const service = await createPathService({
    repositoryRoot: temporary.root,
    workflowRoot: temporary.path('akrs'),
  });

  const result = await service.resolveRepositoryPath('expected.txt');
  assert.equal(result.case_matches, false);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0], {
    code: 'AKRS-C006',
    severity: 'warning',
    message: 'Path case does not match the filesystem entry: expected.txt.',
    file: 'expected.txt',
    line: null,
    detail: {
      actual_path: 'Expected.txt',
      expected_path: 'expected.txt',
    },
  });
});

test('B13 and B23 validation emits stable findings and never resolves outside its one root', async (t) => {
  // P1-W13: the same two properties over canonical v2 Roads (the v1 Markdown "Expected files" form is not parsed any more).
  const caseTree = await createRepo(t);
  await caseTree.write('Expected.txt', 'case-sensitive fixture\n');
  await seedRoad(caseTree, { id: 'R-CASE', plan: null, reads: [{ path: 'expected.txt', lines: null, why: 'x' }] }, { folder: 'roads' });
  const caseResult = await runCli([
    'validate', '--root', caseTree.root,
    '--workflow-root', caseTree.path('akrs'), '--json',
  ], { cwd: caseTree.root });
  assert.equal(caseResult.exitCode, 1);
  const caseFinding = JSON.parse(caseResult.stdout).findings.find(({ code }) => code === 'AKRS-R012');
  assert.ok(caseFinding, 'the case mismatch is reported');
  assert.match(JSON.stringify(caseFinding.detail), /case_mismatch/);

  const unsafeTree = await createRepo(t);
  await seedRoad(unsafeTree, { id: 'R-ESC', plan: null, reads: [{ path: '../../outside.txt', lines: null, why: 'x' }] }, { folder: 'roads' });
  const before = await byteTreeHash(unsafeTree.root);
  const unsafeResult = await runCli([
    'validate', '--root', unsafeTree.root,
    '--workflow-root', unsafeTree.path('akrs'), '--json',
  ], { cwd: unsafeTree.root });
  assert.equal(unsafeResult.exitCode, 1);
  const unsafe = JSON.parse(unsafeResult.stdout);
  assert.equal(unsafe.findings.some(({ code, detail }) => code === 'AKRS-R011' && JSON.stringify(detail).includes('/reads/0/path')), true);
  assert.equal(unsafe.data.checks.find(({ check }) => check === 'road-integrity').status, 'failed');
  assert.equal(await byteTreeHash(unsafeTree.root), before);
});

test('directory walks return normalized files in code-point order and do not follow links', async (t) => {
  const temporary = await createTempRepository(t, { prefix: 'akrs-walk-' });
  for (const path of ['akrs/roads/z.md', 'akrs/roads/A.md', 'akrs/roads/m.md']) {
    await temporary.write(path, `${path}\n`);
  }
  const service = await createPathService({
    repositoryRoot: temporary.root,
    workflowRoot: temporary.path('akrs'),
  });

  assert.deepEqual(await service.walkFiles('akrs/roads'), [
    'akrs/roads/A.md',
    'akrs/roads/m.md',
    'akrs/roads/z.md',
  ]);
});
