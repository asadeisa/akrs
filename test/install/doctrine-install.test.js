import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { CliUsageError } from '../../lib/core/errors.js';
import {
  DEFAULT_SOURCE_ROOT,
  DOCTRINE_TARGET,
  INSTALL_RECORD_NAME,
  INSTALL_RECORD_SCHEMA,
  installDoctrine,
  recoveryPaths,
  renderInstallRecord,
  validateInstallRecord,
} from '../../lib/store/doctrine-install.js';
import { PathSafetyError } from '../../lib/store/path-service.js';
import { byteTreeHash } from '../helpers/byte-tree.js';
import {
  SOURCE_FILES,
  assertPortable,
  linkDirectory,
  listFiles,
  makeRepo,
  markRecovery,
  makeSource,
  sha256,
  writeTree,
} from './support.js';

const TARGET = DOCTRINE_TARGET;
const RECORD = `${TARGET}/${INSTALL_RECORD_NAME}`;

function run(repository, source, options = {}) {
  return installDoctrine({
    mode: 'sync',
    repositoryRoot: repository.root,
    sourceRoot: source.root,
    ...options,
  });
}

const actionsOf = (result) => Object.fromEntries(result.changes.map(({ path, action }) => [path, action]));
const conflictsOf = (result) => Object.fromEntries(result.conflicts.map(({ path, reason }) => [path, reason]));

test('the doctrine target and ownership record names are frozen', () => {
  assert.equal(DOCTRINE_TARGET, 'docs/akrs');
  assert.equal(INSTALL_RECORD_NAME, '.akrs-install.json');
  assert.equal(INSTALL_RECORD_SCHEMA, 'akrs.install-record/v1');
  assert.deepEqual(recoveryPaths('docs/akrs'), {
    staging: 'docs/.akrs.akrs-staging',
    backup: 'docs/.akrs.akrs-backup',
  });
});

test('install record validator is closed, sorted, hashed, and portable', () => {
  const good = {
    schema_version: INSTALL_RECORD_SCHEMA,
    files: [
      { path: 'GETTING_STARTED.md', sha256: sha256('a') },
      { path: 'framework/a.md', sha256: sha256('b') },
    ],
  };
  assert.equal(validateInstallRecord(good).ok, true);
  const bad = [
    null,
    [],
    { ...good, extra: 1 },
    { files: good.files },
    { ...good, schema_version: 'akrs.install-record/v2' },
    { ...good, files: 'x' },
    { ...good, files: [...good.files].reverse() },
    { ...good, files: [good.files[0], good.files[0]] },
    { ...good, files: [{ path: 'a.md' }] },
    { ...good, files: [{ path: 'a.md', sha256: 'abc' }] },
    { ...good, files: [{ path: 'a.md', sha256: sha256('a'), extra: 1 }] },
    { ...good, files: [{ path: '../a.md', sha256: sha256('a') }] },
    { ...good, files: [{ path: 'a\\b.md', sha256: sha256('a') }] },
    { ...good, files: [{ path: '/a.md', sha256: sha256('a') }] },
    { ...good, files: [{ path: INSTALL_RECORD_NAME, sha256: sha256('a') }] },
  ];
  for (const candidate of bad) {
    assert.equal(validateInstallRecord(candidate).ok, false, JSON.stringify(candidate));
  }
});

test('install record rendering is canonical sorted LF JSON', () => {
  const text = renderInstallRecord([
    { path: 'framework/b.md', sha256: sha256('b') },
    { path: 'GETTING_STARTED.md', sha256: sha256('a') },
  ]);
  assert.equal(text.includes('\r'), false);
  assert.equal(text.endsWith('\n'), true);
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.files.map(({ path }) => path), ['GETTING_STARTED.md', 'framework/b.md']);
  assert.deepEqual(Object.keys(parsed), ['schema_version', 'files']);
  assert.equal(validateInstallRecord(parsed).ok, true);
});

test('init installs the packaged doctrine tree and its ownership record', async (t) => {
  const repository = await makeRepo(t);
  const result = await installDoctrine({
    mode: 'init',
    repositoryRoot: repository.root,
    sourceRoot: DEFAULT_SOURCE_ROOT,
  });
  const installed = await listFiles(repository.path('docs/akrs'));
  const packaged = await listFiles(join(DEFAULT_SOURCE_ROOT, 'docs', 'framework'));
  const expected = { 'GETTING_STARTED.md': await readFile(join(DEFAULT_SOURCE_ROOT, 'GETTING_STARTED.md'), 'utf8') };
  for (const [path, text] of Object.entries(packaged)) expected[`framework/${path}`] = text;

  const record = JSON.parse(installed[INSTALL_RECORD_NAME]);
  delete installed[INSTALL_RECORD_NAME];
  assert.deepEqual(installed, expected);
  assert.equal(validateInstallRecord(record).ok, true);
  assert.deepEqual(record.files.map(({ path }) => path), Object.keys(expected).sort());
  assert.equal(result.applied, true);
  assert.equal(result.changes.every(({ action }) => action === 'create'), true);
  assert.equal(result.changes.length, Object.keys(expected).length + 1);
  assertPortable(result.changed);
  assert.equal(result.changed.includes(RECORD), true);
  assert.deepEqual(await listFiles(repository.path('docs')), Object.fromEntries(
    Object.entries({ ...expected, [INSTALL_RECORD_NAME]: JSON.stringify(record, null, 2) + '\n' })
      .map(([path, text]) => [`akrs/${path}`, text]),
  ));
});

test('B14/B15 init refuses an existing target without force and changes nothing', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  await run(repository, source, { mode: 'init' });
  await writeFile(repository.path('docs/akrs/framework/02-Spec.md'), 'local\n');
  const before = await byteTreeHash(repository.root);
  await assert.rejects(() => run(repository, source, { mode: 'init' }), CliUsageError);
  await assert.rejects(() => run(repository, source, { mode: 'init', dryRun: true }), CliUsageError);
  assert.equal(await byteTreeHash(repository.root), before);
});

test('dry-run returns the exact proposed change list and changes no byte', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t, { 'README.md': 'repo\n' });
  const before = await byteTreeHash(repository.root);
  const init = await run(repository, source, { mode: 'init', dryRun: true });
  assert.equal(init.applied, false);
  assert.deepEqual(actionsOf(init), {
    [RECORD]: 'create',
    'docs/akrs/GETTING_STARTED.md': 'create',
    'docs/akrs/framework/01-Constitution.md': 'create',
    'docs/akrs/framework/02-Spec.md': 'create',
    'docs/akrs/framework/skills/README.md': 'create',
    'docs/akrs/framework/skills/akrs-close-out.md': 'create',
  });
  assert.deepEqual(init.changes.map(({ path }) => path), init.changes.map(({ path }) => path).sort());
  assert.equal(await byteTreeHash(repository.root), before);

  const applied = await run(repository, source, { mode: 'init' });
  assert.deepEqual(applied.changes, init.changes);
  assert.deepEqual(applied.changed, init.changes.map(({ path }) => path));
  assert.equal(init.snapshot.before, init.snapshot.after);
  assert.notEqual(applied.snapshot.before, applied.snapshot.after);
});

test('B14 sync follows ownership: update, remove, recreate, preserve, never touch user files', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  await run(repository, source, { mode: 'init' });
  const target = repository.path('docs/akrs');
  await writeFile(join(target, 'framework/01-Constitution.md'), 'LOCAL EDIT\n');
  await rm(join(target, 'framework/skills/README.md'));
  await writeFile(join(target, 'framework/user-notes.md'), 'mine\n');
  await writeFile(join(target, 'MY-NOTES.md'), 'mine too\n');
  await writeTree(source.root, {
    'docs/framework/01-Constitution.md': 'constitution v2\n',
    'docs/framework/02-Spec.md': 'spec v2\n',
    'docs/framework/03-New.md': 'new v1\n',
  });
  await rm(join(source.root, 'docs/framework/skills/akrs-close-out.md'));

  const preDry = await byteTreeHash(repository.root);
  const dry = await run(repository, source, { dryRun: true });
  assert.equal(await byteTreeHash(repository.root), preDry);
  const result = await run(repository, source);
  assert.deepEqual(actionsOf(result), {
    [RECORD]: 'update',
    'docs/akrs/framework/02-Spec.md': 'update',
    'docs/akrs/framework/03-New.md': 'create',
    'docs/akrs/framework/skills/README.md': 'create',
    'docs/akrs/framework/skills/akrs-close-out.md': 'remove',
  });
  assert.deepEqual(dry.changes, result.changes);
  assert.deepEqual(conflictsOf(result), {
    'docs/akrs/framework/01-Constitution.md': 'locally_modified',
  });
  assert.deepEqual(result.changed, result.changes.map(({ path }) => path));

  const files = await listFiles(target);
  assert.equal(files['framework/01-Constitution.md'], 'LOCAL EDIT\n');
  assert.equal(files['framework/02-Spec.md'], 'spec v2\n');
  assert.equal(files['framework/03-New.md'], 'new v1\n');
  assert.equal(files['framework/skills/README.md'], 'skills readme v1\n');
  assert.equal('framework/skills/akrs-close-out.md' in files, false);
  assert.equal(files['framework/user-notes.md'], 'mine\n');
  assert.equal(files['MY-NOTES.md'], 'mine too\n');

  const record = JSON.parse(files[INSTALL_RECORD_NAME]);
  const owned = Object.fromEntries(record.files.map(({ path, sha256: hash }) => [path, hash]));
  assert.equal(owned['framework/01-Constitution.md'], sha256('constitution v1\n'));
  assert.equal(owned['framework/02-Spec.md'], sha256('spec v2\n'));
  assert.equal('MY-NOTES.md' in owned, false);
  assert.equal('framework/user-notes.md' in owned, false);
  assert.equal('framework/skills/akrs-close-out.md' in owned, false);
});

test('repeated sync is a byte-identical noop, including while a conflict is preserved', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  await run(repository, source, { mode: 'init' });
  const clean = await byteTreeHash(repository.root);
  const noop = await run(repository, source);
  assert.deepEqual(noop.changes, []);
  assert.deepEqual(noop.changed, []);
  assert.equal(noop.applied, false);
  assert.equal(await byteTreeHash(repository.root), clean);

  await writeFile(repository.path('docs/akrs/GETTING_STARTED.md'), 'edited\n');
  await writeTree(source.root, { 'GETTING_STARTED.md': 'getting started v2\n' });
  const first = await run(repository, source);
  const hash = await byteTreeHash(repository.root);
  const second = await run(repository, source);
  assert.deepEqual(first.changes, []);
  assert.deepEqual(conflictsOf(first), { 'docs/akrs/GETTING_STARTED.md': 'locally_modified' });
  assert.deepEqual(second, first);
  assert.equal(await byteTreeHash(repository.root), hash);
});

test('a file removed upstream but modified locally is preserved and reported', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  await run(repository, source, { mode: 'init' });
  await writeFile(repository.path('docs/akrs/framework/02-Spec.md'), 'local\n');
  await rm(join(source.root, 'docs/framework/02-Spec.md'));
  const result = await run(repository, source);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(conflictsOf(result), { 'docs/akrs/framework/02-Spec.md': 'removed_upstream_modified' });
  assert.equal(await readFile(repository.path('docs/akrs/framework/02-Spec.md'), 'utf8'), 'local\n');
  assert.equal((await run(repository, source)).changes.length, 0);
});

test('removing the last owned file of a directory prunes the empty directory only', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  await run(repository, source, { mode: 'init' });
  await rm(join(source.root, 'docs/framework/skills'), { recursive: true });
  const result = await run(repository, source);
  assert.deepEqual(actionsOf(result), {
    [RECORD]: 'update',
    'docs/akrs/framework/skills/README.md': 'remove',
    'docs/akrs/framework/skills/akrs-close-out.md': 'remove',
  });
  const files = await listFiles(repository.path('docs/akrs'));
  assert.deepEqual(Object.keys(files).sort(), [
    INSTALL_RECORD_NAME, 'GETTING_STARTED.md', 'framework/01-Constitution.md', 'framework/02-Spec.md',
  ].sort());
  await assert.rejects(() => readFile(repository.path('docs/akrs/framework/skills/README.md')));
  await mkdir(repository.path('docs/akrs/framework/keep'), { recursive: true });
  await writeFile(repository.path('docs/akrs/framework/keep/user.md'), 'mine\n');
  await run(repository, source);
  assert.equal(await readFile(repository.path('docs/akrs/framework/keep/user.md'), 'utf8'), 'mine\n');
});

test('sync without a record adopts identical files and preserves differing ones', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t, {
    'docs/akrs/framework/01-Constitution.md': 'constitution v1\n',
    'docs/akrs/framework/02-Spec.md': 'hand written\n',
    'docs/akrs/GETTING_STARTED.md': 'getting started v1\n',
    'docs/akrs/other.txt': 'user\n',
  });
  const result = await run(repository, source);
  assert.deepEqual(conflictsOf(result), { 'docs/akrs/framework/02-Spec.md': 'unowned_differs' });
  assert.deepEqual(actionsOf(result), {
    [RECORD]: 'create',
    'docs/akrs/framework/skills/README.md': 'create',
    'docs/akrs/framework/skills/akrs-close-out.md': 'create',
  });
  const files = await listFiles(repository.path('docs/akrs'));
  assert.equal(files['framework/02-Spec.md'], 'hand written\n');
  assert.equal(files['other.txt'], 'user\n');
  const owned = JSON.parse(files[INSTALL_RECORD_NAME]).files.map(({ path }) => path);
  assert.equal(owned.includes('framework/01-Constitution.md'), true);
  assert.equal(owned.includes('GETTING_STARTED.md'), true);
  assert.equal(owned.includes('framework/02-Spec.md'), false);
  assert.equal(owned.includes('other.txt'), false);
});

test('sync creates the target when it is absent, exactly like init', async (t) => {
  const source = await makeSource(t);
  const synced = await makeRepo(t);
  const initialized = await makeRepo(t);
  await run(synced, source);
  await run(initialized, source, { mode: 'init' });
  assert.equal(await byteTreeHash(synced.path('docs')), await byteTreeHash(initialized.path('docs')));
});

test('B15 forced init replaces the exact generated target; ghosts and local edits do not survive', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t, {
    'docs/other.txt': 'sibling\n',
    'docs/akrs-notes.md': 'near miss\n',
    'README.md': 'repo\n',
  });
  await run(repository, source, { mode: 'init' });
  await writeFile(repository.path('docs/akrs/framework/01-Constitution.md'), 'LOCAL\n');
  await writeFile(repository.path('docs/akrs/ghost-user.md'), 'inside target\n');
  await rm(join(source.root, 'docs/framework/02-Spec.md'));
  await writeTree(source.root, { 'docs/framework/03-New.md': 'new\n' });
  await writeTree(repository.root, { 'docs/akrs/framework/02-Spec.md': 'ghost\n' });

  const dry = await run(repository, source, { mode: 'init', force: true, dryRun: true });
  const dryHash = await byteTreeHash(repository.root);
  const result = await run(repository, source, { mode: 'init', force: true });
  assert.deepEqual(dry.changes, result.changes);
  assert.deepEqual(actionsOf(result), {
    [RECORD]: 'update',
    'docs/akrs/framework/01-Constitution.md': 'update',
    'docs/akrs/framework/02-Spec.md': 'remove',
    'docs/akrs/framework/03-New.md': 'create',
    'docs/akrs/ghost-user.md': 'remove',
  });
  assert.notEqual(dryHash, await byteTreeHash(repository.root));

  const files = await listFiles(repository.path('docs/akrs'));
  assert.deepEqual(Object.keys(files).sort(), [
    INSTALL_RECORD_NAME,
    'GETTING_STARTED.md',
    'framework/01-Constitution.md',
    'framework/03-New.md',
    'framework/skills/README.md',
    'framework/skills/akrs-close-out.md',
  ].sort());
  assert.equal(files['framework/01-Constitution.md'], 'constitution v1\n');
  assert.equal(await readFile(repository.path('docs/other.txt'), 'utf8'), 'sibling\n');
  assert.equal(await readFile(repository.path('docs/akrs-notes.md'), 'utf8'), 'near miss\n');
  assert.equal(await readFile(repository.path('README.md'), 'utf8'), 'repo\n');
  const siblings = await listFiles(repository.path('docs'));
  assert.deepEqual(Object.keys(siblings).filter((path) => !path.startsWith('akrs/')).sort(), [
    'akrs-notes.md', 'other.txt',
  ]);
});

test('repeated forced init yields a byte-identical tree and a noop', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  await run(repository, source, { mode: 'init', force: true });
  const first = await byteTreeHash(repository.root);
  const second = await run(repository, source, { mode: 'init', force: true });
  assert.equal(await byteTreeHash(repository.root), first);
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.changed, []);
  const third = await run(repository, source, { mode: 'init', force: true });
  assert.deepEqual(third, second);
  assert.equal(await byteTreeHash(repository.root), first);
});

test('forced init validates the exact target before removing anything', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  const outside = await makeRepo(t, { 'victim.md': 'outside\n', 'deep/file.md': 'deep\n' });
  const outsideHash = await byteTreeHash(outside.root);

  for (const target of ['../escape', 'docs/../..', '/abs/target', 'C:/abs', 'docs\\akrs', '', '.', 'a//b']) {
    await assert.rejects(
      () => run(repository, source, { mode: 'init', force: true, target }),
      PathSafetyError,
      target,
    );
  }

  await mkdir(repository.path('docs'), { recursive: true });
  await linkDirectory(outside.root, repository.path('docs/akrs'));
  for (const options of [{ mode: 'init', force: true }, { mode: 'init', force: true, dryRun: true }, { mode: 'sync' }]) {
    await assert.rejects(() => run(repository, source, options), PathSafetyError, JSON.stringify(options));
  }
  assert.equal(await byteTreeHash(outside.root), outsideHash);

  await rm(repository.path('docs/akrs'), { recursive: true, force: true });
  await linkDirectory(repository.root, repository.path('docs/akrs'));
  const repoHash = await byteTreeHash(repository.root);
  await assert.rejects(() => run(repository, source, { mode: 'init', force: true }), PathSafetyError);
  assert.equal(await byteTreeHash(repository.root), repoHash);
  assert.equal(await byteTreeHash(outside.root), outsideHash);
});

test('forced init refuses a target that overlaps the packaged source', async (t) => {
  const repository = await makeRepo(t);
  await writeTree(repository.root, SOURCE_FILES);
  const before = await byteTreeHash(repository.root);
  await assert.rejects(
    () => installDoctrine({
      mode: 'init',
      force: true,
      repositoryRoot: repository.root,
      sourceRoot: repository.root,
      target: 'docs/framework',
    }),
    PathSafetyError,
  );
  await assert.rejects(
    () => installDoctrine({
      mode: 'init',
      force: true,
      repositoryRoot: repository.root,
      sourceRoot: repository.path('docs/framework'),
      target: 'docs',
    }),
    PathSafetyError,
  );
  assert.equal(await byteTreeHash(repository.root), before);
});

test('sync never writes through a symlinked directory inside the target', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  const outside = await makeRepo(t, { 'keep.md': 'outside\n' });
  await mkdir(repository.path('docs/akrs'), { recursive: true });
  await linkDirectory(outside.root, repository.path('docs/akrs/framework'));
  const outsideHash = await byteTreeHash(outside.root);
  const result = await run(repository, source);
  assert.equal(await byteTreeHash(outside.root), outsideHash);
  assert.deepEqual(Object.values(conflictsOf(result)).every((reason) => reason === 'blocked_by_non_directory'), true);
  assert.equal(Object.keys(conflictsOf(result)).length, 4);
  assert.equal(await readFile(repository.path('docs/akrs/GETTING_STARTED.md'), 'utf8'), 'getting started v1\n');
});

test('sync reports a directory squatting on a file path instead of removing it', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t, { 'docs/akrs/framework/02-Spec.md/inner.md': 'user\n' });
  const result = await run(repository, source);
  assert.deepEqual(conflictsOf(result), { 'docs/akrs/framework/02-Spec.md': 'blocked_by_non_file' });
  assert.equal(await readFile(repository.path('docs/akrs/framework/02-Spec.md/inner.md'), 'utf8'), 'user\n');

  const other = await makeRepo(t, { 'docs/akrs/framework': 'a file where a directory belongs\n' });
  const blocked = await run(other, source);
  assert.equal(Object.values(conflictsOf(blocked)).every((reason) => reason === 'blocked_by_non_directory'), true);
  assert.equal(await readFile(other.path('docs/akrs/framework'), 'utf8'), 'a file where a directory belongs\n');
});

test('an invalid ownership record is a usage error that changes nothing', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  await run(repository, source, { mode: 'init' });
  const recordPath = repository.path(RECORD);
  for (const text of ['{not json', '[]', JSON.stringify({ schema_version: INSTALL_RECORD_SCHEMA, files: [{ path: '../x', sha256: sha256('x') }] })]) {
    await writeFile(recordPath, text);
    const before = await byteTreeHash(repository.root);
    await assert.rejects(() => run(repository, source), CliUsageError);
    await assert.rejects(() => run(repository, source, { dryRun: true }), CliUsageError);
    assert.equal(await byteTreeHash(repository.root), before);
  }
  await run(repository, source, { mode: 'init', force: true });
  assert.equal(validateInstallRecord(JSON.parse(await readFile(recordPath, 'utf8'))).ok, true);
});

test('a missing packaged doctrine source is a usage error before anything is written', async (t) => {
  const repository = await makeRepo(t);
  const empty = await makeSource(t, { 'unrelated.txt': 'x\n' });
  const before = await byteTreeHash(repository.root);
  await assert.rejects(() => run(repository, empty, { mode: 'init' }), CliUsageError);
  assert.equal(await byteTreeHash(repository.root), before);
});

test('a failed swap restores the previous target byte-for-byte and leaves no leftovers', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  await run(repository, source, { mode: 'init' });
  await writeFile(repository.path('docs/akrs/mine.md'), 'user\n');
  await writeTree(source.root, { 'docs/framework/02-Spec.md': 'spec v2\n' });
  const before = await byteTreeHash(repository.root);

  let renames = 0;
  const failing = async (from, to) => {
    renames += 1;
    if (renames === 2) throw Object.assign(new Error('simulated rename failure'), { code: 'EPERM' });
    return rename(from, to);
  };
  await assert.rejects(
    () => run(repository, source, { mode: 'init', force: true, fsOps: { rename: failing } }),
    /simulated rename failure/,
  );
  assert.equal(await byteTreeHash(repository.root), before);
  const siblings = await listFiles(repository.path('docs'));
  assert.equal(Object.keys(siblings).every((path) => path.startsWith('akrs/')), true);
  await assert.rejects(() => readFile(repository.path('docs/.akrs.akrs-backup')));

  const retry = await run(repository, source, { mode: 'init', force: true });
  assert.equal(retry.changes.length > 0, true);
  assert.equal(await readFile(repository.path('docs/akrs/framework/02-Spec.md'), 'utf8'), 'spec v2\n');
});

test('a leftover backup with a missing target is restored on the next run, then sync proceeds', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  await run(repository, source, { mode: 'init' });
  await writeFile(repository.path('docs/akrs/mine.md'), 'user\n');
  const treeBefore = await listFiles(repository.path('docs/akrs'));
  await rename(repository.path('docs/akrs'), repository.path('docs/.akrs.akrs-backup'));
  await markRecovery(repository.path('docs/.akrs.akrs-backup'), 'backup');
  await writeTree(repository.root, { 'docs/.akrs.akrs-staging/half-written.md': 'partial\n' });
  await markRecovery(repository.path('docs/.akrs.akrs-staging'), 'staging');
  const recovery = [
    { action: 'remove_staging', path: 'docs/.akrs.akrs-staging' },
    { action: 'restore_backup', path: 'docs/.akrs.akrs-backup' },
  ];

  const dry = await run(repository, source, { dryRun: true });
  assert.deepEqual(dry.recovery, recovery);
  assert.deepEqual(dry.changed, []);
  await assert.rejects(() => readFile(repository.path('docs/akrs/mine.md')));

  const result = await run(repository, source);
  assert.deepEqual(result.recovery, recovery);
  assert.equal(result.applied, true);
  assert.deepEqual(result.changed, Object.keys(treeBefore).map((path) => `docs/akrs/${path}`).sort());
  assert.deepEqual(await listFiles(repository.path('docs/akrs')), treeBefore);
  await assert.rejects(() => readFile(repository.path('docs/.akrs.akrs-backup/mine.md')));
  await assert.rejects(() => readFile(repository.path('docs/.akrs.akrs-staging/half-written.md')));
  assert.deepEqual((await run(repository, source)).recovery, []);
});

test('a leftover backup beside a completed target is discarded; forced init also recovers', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  await run(repository, source, { mode: 'init' });
  await writeTree(repository.root, { 'docs/.akrs.akrs-backup/old.md': 'stale\n' });
  await markRecovery(repository.path('docs/.akrs.akrs-backup'), 'backup');
  const result = await run(repository, source);
  assert.deepEqual(result.recovery, [{ action: 'remove_backup', path: 'docs/.akrs.akrs-backup' }]);
  await assert.rejects(() => readFile(repository.path('docs/.akrs.akrs-backup/old.md')));

  await rename(repository.path('docs/akrs'), repository.path('docs/.akrs.akrs-backup'));
  await markRecovery(repository.path('docs/.akrs.akrs-backup'), 'backup');
  const forced = await run(repository, source, { mode: 'init', force: true });
  assert.equal(forced.recovery.some(({ action }) => action === 'restore_backup'), true);
  assert.equal((await listFiles(repository.path('docs/akrs')))['GETTING_STARTED.md'], 'getting started v1\n');
  await assert.rejects(() => readFile(repository.path('docs/.akrs.akrs-backup/GETTING_STARTED.md')));
});

test('plain init refuses to run over interrupted-install leftovers', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t, { 'docs/.akrs.akrs-backup/old.md': 'stale\n' });
  await markRecovery(repository.path('docs/.akrs.akrs-backup'), 'backup');
  const before = await byteTreeHash(repository.root);
  await assert.rejects(() => run(repository, source, { mode: 'init' }), CliUsageError);
  assert.equal(await byteTreeHash(repository.root), before);
});

test('sync refuses to write when a planned file changed after planning', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  await run(repository, source, { mode: 'init' });
  await writeTree(source.root, { 'docs/framework/02-Spec.md': 'spec v2\n' });
  const racing = async (path, options) => {
    await writeFile(repository.path('docs/akrs/framework/02-Spec.md'), 'raced local edit\n');
    return mkdir(path, options);
  };
  await assert.rejects(
    () => run(repository, source, { fsOps: { mkdir: racing } }),
    /changed before write/,
  );
  assert.equal(await readFile(repository.path('docs/akrs/framework/02-Spec.md'), 'utf8'), 'raced local edit\n');
  const converged = await run(repository, source);
  assert.deepEqual(conflictsOf(converged), { 'docs/akrs/framework/02-Spec.md': 'locally_modified' });
});

test('an interrupted sync converges on re-run without spurious conflicts', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  await run(repository, source, { mode: 'init' });
  await writeTree(source.root, {
    'docs/framework/01-Constitution.md': 'constitution v2\n',
    'docs/framework/02-Spec.md': 'spec v2\n',
  });
  let renames = 0;
  const crashing = async (from, to) => {
    renames += 1;
    if (renames === 2) throw new Error('simulated crash');
    return rename(from, to);
  };
  await assert.rejects(() => run(repository, source, { fsOps: { rename: crashing } }), /simulated crash/);
  assert.equal(Object.keys(await listFiles(repository.path('docs'))).every((path) => path.startsWith('akrs/')), true);
  const result = await run(repository, source);
  assert.deepEqual(result.conflicts, []);
  const files = await listFiles(repository.path('docs/akrs'));
  assert.equal(files['framework/01-Constitution.md'], 'constitution v2\n');
  assert.equal(files['framework/02-Spec.md'], 'spec v2\n');
  assert.deepEqual((await run(repository, source)).changes, []);
});

test('all reported paths are repository-relative with forward slashes', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  const results = [
    await run(repository, source, { mode: 'init', dryRun: true }),
    await run(repository, source, { mode: 'init' }),
  ];
  await writeFile(repository.path('docs/akrs/framework/skills/README.md'), 'edit\n');
  await writeTree(source.root, { 'docs/framework/skills/README.md': 'v2\n' });
  results.push(await run(repository, source));
  for (const result of results) {
    assertPortable([
      ...result.changes.map(({ path }) => path),
      ...result.conflicts.map(({ path }) => path),
      ...result.changed,
    ]);
  }
});
