import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCliAdapter } from '../../bin/cli-adapter.js';
import { commandHandlers, commandManifest, normalizeAbsolutePath } from '../../lib/core/index.js';
import { installDoctrine } from '../../lib/store/doctrine-install.js';
import { byteTreeHash } from '../helpers/byte-tree.js';
import { createTempRepository } from '../helpers/temp-repository.js';
import {
  SOURCE_FILES,
  hostIsCaseSensitive,
  linkDirectory,
  listFiles,
  makeRepo,
  makeSource,
  providers,
  writeTree,
} from './support.js';

const RECORD = 'docs/akrs/.akrs-install.json';
const FRAMEWORK = 'docs/akrs/framework';

const FILES = {
  ...SOURCE_FILES,
  'docs/framework/foo.md': 'foo v1\n',
  'docs/framework/other.md': 'other v1\n',
};

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

async function installed(t) {
  const source = await makeSource(t, FILES);
  const repository = await makeRepo(t);
  await run(repository, source, { mode: 'init' });
  return { source, repository };
}

test('F2 a case-only upstream rename is applied as remove+create with the new spelling on every host', async (t) => {
  const { source, repository } = await installed(t);
  await rm(join(source.root, 'docs/framework/foo.md'));
  await writeTree(source.root, {
    'docs/framework/Foo.md': 'foo v2\n',
    'docs/framework/other.md': 'other v2\n',
  });

  const dry = await run(repository, source, { dryRun: true });
  const result = await run(repository, source);
  assert.deepEqual(actionsOf(result), {
    [RECORD]: 'update',
    [`${FRAMEWORK}/Foo.md`]: 'create',
    [`${FRAMEWORK}/foo.md`]: 'remove',
    [`${FRAMEWORK}/other.md`]: 'update',
  });
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(dry.changes, result.changes);
  assert.deepEqual(result.changed, result.changes.map(({ path }) => path));

  const files = await listFiles(repository.path('docs/akrs'));
  assert.equal(files['framework/Foo.md'], 'foo v2\n');
  assert.equal('framework/foo.md' in files, false);
  assert.equal(files['framework/other.md'], 'other v2\n');
  const owned = JSON.parse(files['.akrs-install.json']).files.map(({ path }) => path);
  assert.equal(owned.includes('framework/Foo.md'), true);
  assert.equal(owned.includes('framework/foo.md'), false);

  const hash = await byteTreeHash(repository.root);
  const again = await run(repository, source);
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.conflicts, []);
  assert.equal(await byteTreeHash(repository.root), hash);
});

test('F2 a case-only rename of a locally edited file is a case_collision conflict, never a thrown error', async (t) => {
  const { source, repository } = await installed(t);
  await writeFile(repository.path(`${FRAMEWORK}/foo.md`), 'LOCAL\n');
  await rm(join(source.root, 'docs/framework/foo.md'));
  await writeTree(source.root, {
    'docs/framework/Foo.md': 'foo v2\n',
    'docs/framework/other.md': 'other v2\n',
  });

  const result = await run(repository, source);
  assert.deepEqual(conflictsOf(result), { [`${FRAMEWORK}/Foo.md`]: 'case_collision' });
  assert.equal(result.conflicts[0].other_path, `${FRAMEWORK}/foo.md`);
  assert.deepEqual(actionsOf(result), {
    [RECORD]: 'update',
    [`${FRAMEWORK}/other.md`]: 'update',
  });
  const files = await listFiles(repository.path('docs/akrs'));
  assert.equal(files['framework/foo.md'], 'LOCAL\n');
  assert.equal('framework/Foo.md' in files, false);
  assert.equal(files['framework/other.md'], 'other v2\n');

  const hash = await byteTreeHash(repository.root);
  const again = await run(repository, source);
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.conflicts, result.conflicts);
  assert.equal(await byteTreeHash(repository.root), hash);
});

test('F2 an unowned local case variant of an upstream file is preserved as a case_collision', async (t) => {
  const source = await makeSource(t, { ...SOURCE_FILES, 'docs/framework/Foo.md': 'foo upstream\n' });
  const repository = await makeRepo(t, { [`${FRAMEWORK}/foo.md`]: 'hand written\n' });
  const result = await run(repository, source);
  assert.deepEqual(conflictsOf(result), { [`${FRAMEWORK}/Foo.md`]: 'case_collision' });
  assert.equal(result.conflicts[0].other_path, `${FRAMEWORK}/foo.md`);
  assert.equal(await readFile(repository.path(`${FRAMEWORK}/foo.md`), 'utf8'), 'hand written\n');
  assert.equal(result.changes.some(({ path }) => path === `${FRAMEWORK}/foo.md`), false);
  assert.equal(await readFile(repository.path(`${FRAMEWORK}/02-Spec.md`), 'utf8'), 'spec v1\n');
});

test('F2 a case-only directory rename converges: the next sync is a clean noop', async (t) => {
  const { source, repository } = await installed(t);
  await rm(join(source.root, 'docs/framework/skills'), { recursive: true });
  await writeTree(source.root, {
    'docs/framework/Skills/README.md': 'skills readme v1\n',
    'docs/framework/Skills/akrs-close-out.md': 'close out v1\n',
  });

  const result = await run(repository, source);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(actionsOf(result), {
    [RECORD]: 'update',
    [`${FRAMEWORK}/Skills/README.md`]: 'create',
    [`${FRAMEWORK}/Skills/akrs-close-out.md`]: 'create',
    [`${FRAMEWORK}/skills/README.md`]: 'remove',
    [`${FRAMEWORK}/skills/akrs-close-out.md`]: 'remove',
  });
  const names = Object.keys(await listFiles(repository.path('docs/akrs'))).map((path) => path.toLowerCase());
  assert.deepEqual(names.sort(), [
    '.akrs-install.json',
    'framework/01-constitution.md',
    'framework/02-spec.md',
    'framework/foo.md',
    'framework/other.md',
    'framework/skills/akrs-close-out.md',
    'framework/skills/readme.md',
    'getting_started.md',
  ].sort());

  const hash = await byteTreeHash(repository.root);
  const again = await run(repository, source);
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.conflicts, []);
  assert.equal(await byteTreeHash(repository.root), hash);
});

test('F2 two case variants present locally block only that path on case-sensitive hosts', async (t) => {
  if (!(await hostIsCaseSensitive(t))) {
    t.skip('host filesystem cannot hold two case variants');
    return;
  }
  const { source, repository } = await installed(t);
  await writeFile(repository.path(`${FRAMEWORK}/Foo.md`), 'second spelling\n');
  await writeTree(source.root, { 'docs/framework/other.md': 'other v2\n' });
  await rm(join(source.root, 'docs/framework/foo.md'));
  await writeTree(source.root, { 'docs/framework/Foo.md': 'foo v2\n' });
  const result = await run(repository, source);
  assert.deepEqual(conflictsOf(result), { [`${FRAMEWORK}/Foo.md`]: 'case_collision' });
  assert.equal(await readFile(repository.path(`${FRAMEWORK}/foo.md`), 'utf8'), 'foo v1\n');
  assert.equal(await readFile(repository.path(`${FRAMEWORK}/Foo.md`), 'utf8'), 'second spelling\n');
  assert.equal(await readFile(repository.path(`${FRAMEWORK}/other.md`), 'utf8'), 'other v2\n');
});

test('F2 upstream paths that differ only by case are never written on case-sensitive hosts', async (t) => {
  if (!(await hostIsCaseSensitive(t))) {
    t.skip('host filesystem cannot hold two case variants');
    return;
  }
  const source = await makeSource(t, {
    ...SOURCE_FILES,
    'docs/framework/A.md': 'upper\n',
    'docs/framework/a.md': 'lower\n',
  });
  const repository = await makeRepo(t);
  const result = await run(repository, source, { mode: 'init' });
  assert.deepEqual(conflictsOf(result), {
    [`${FRAMEWORK}/A.md`]: 'case_collision',
    [`${FRAMEWORK}/a.md`]: 'case_collision',
  });
  const files = await listFiles(repository.path('docs/akrs'));
  assert.equal('framework/A.md' in files || 'framework/a.md' in files, false);
  assert.equal(files['framework/01-Constitution.md'], 'constitution v1\n');
});

test('F5 forced init reports removed links and junctions in changed', async (t) => {
  const { source, repository } = await installed(t);
  const outside = await makeRepo(t, { 'victim.md': 'outside\n' });
  const outsideHash = await byteTreeHash(outside.root);
  await linkDirectory(outside.root, repository.path('docs/akrs/link2'));
  const result = await run(repository, source, { mode: 'init', force: true });
  assert.deepEqual(actionsOf(result), { 'docs/akrs/link2': 'remove' });
  assert.deepEqual(result.changed, ['docs/akrs/link2']);
  assert.equal(await byteTreeHash(outside.root), outsideHash);
  await assert.rejects(() => readFile(repository.path('docs/akrs/link2/victim.md')));
});

test('F6 a failed backup removal after a successful swap is a pending recovery note, not an error', async (t) => {
  const { source, repository } = await installed(t);
  await writeTree(source.root, { 'docs/framework/other.md': 'other v2\n' });
  const backup = join(await realpath(repository.path('docs')), '.akrs.akrs-backup');
  const failing = async (path, options) => {
    if (path === backup) throw Object.assign(new Error('simulated EBUSY'), { code: 'EBUSY' });
    return rm(path, options);
  };
  const result = await run(repository, source, { mode: 'init', force: true, fsOps: { rm: failing } });
  assert.equal(result.applied, true);
  assert.deepEqual(result.recovery, [{ action: 'remove_backup', path: 'docs/.akrs.akrs-backup' }]);
  assert.deepEqual(result.changed, [RECORD, `${FRAMEWORK}/other.md`]);
  assert.equal(await readFile(repository.path(`${FRAMEWORK}/other.md`), 'utf8'), 'other v2\n');

  const next = await run(repository, source);
  assert.deepEqual(next.recovery, [{ action: 'remove_backup', path: 'docs/.akrs.akrs-backup' }]);
  assert.deepEqual(next.changes, []);
  await assert.rejects(() => readFile(repository.path('docs/.akrs.akrs-backup/GETTING_STARTED.md')));
  assert.deepEqual((await run(repository, source)).recovery, []);
});

function adapter(argv, cwd, context = {}) {
  return runCliAdapter({
    argv,
    cwd,
    manifest: commandManifest,
    handlers: commandHandlers,
    providers,
    resolveContext: async () => ({ repository_root: normalizeAbsolutePath(cwd), ...context }),
  });
}

test('F7 a forced swap that only removes a stray directory reports ok with applied true, never noop', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  const context = { source_root: source.root };
  await adapter(['init', '--root', repository.root, '--json'], repository.root, context);
  await mkdir(repository.path('docs/akrs/stray-empty-dir'));
  const result = await adapter(['init', '--force', '--root', repository.root, '--json'], repository.root, context);
  assert.equal(result.exitCode, 0);
  const packet = JSON.parse(result.stdout);
  assert.deepEqual(packet.data.changes, []);
  assert.equal(packet.data.applied, true);
  assert.equal(packet.status, 'ok');
  await assert.rejects(() => readFile(repository.path('docs/akrs/stray-empty-dir')));
  const again = JSON.parse((await adapter(['init', '--force', '--root', repository.root, '--json'], repository.root, context)).stdout);
  assert.equal(again.status, 'noop');
  assert.equal(again.data.applied, false);
});

test('F3 init from a subdirectory of a git repository targets the git root; --root overrides it', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t, { '.git/HEAD': 'ref: refs/heads/main\n', 'packages/app/index.js': 'x\n' });
  const other = await createTempRepository(t, { prefix: 'akrs-install-override-' });
  const context = { source_root: source.root };
  const subdirectory = repository.path('packages/app');

  const discovered = await adapter(['init', '--json'], subdirectory, context);
  assert.equal(discovered.exitCode, 0);
  assert.equal(JSON.parse(discovered.stdout).root, normalizeAbsolutePath(repository.root));
  const files = await listFiles(repository.root);
  assert.equal(files['docs/akrs/GETTING_STARTED.md'], 'getting started v1\n');
  assert.equal(Object.keys(files).some((path) => path.startsWith('packages/app/docs/')), false);

  const overridden = await adapter(['init', '--root', other.root, '--json'], subdirectory, context);
  assert.equal(overridden.exitCode, 0);
  assert.equal(JSON.parse(overridden.stdout).root, normalizeAbsolutePath(other.root));
  assert.equal((await listFiles(other.root))['docs/akrs/GETTING_STARTED.md'], 'getting started v1\n');

  const sync = await adapter(['sync', '--dry-run', '--json'], subdirectory, context);
  assert.equal(sync.exitCode, 0);
  assert.equal(JSON.parse(sync.stdout).root, normalizeAbsolutePath(repository.root));
});

test('F3 init and sync no longer accept --workflow-root, and -f stays undeclared', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  const before = await byteTreeHash(repository.root);
  for (const argv of [
    ['init', '--root', repository.root, '--workflow-root', repository.root],
    ['sync', '--root', repository.root, '--workflow-root', repository.root],
    ['init', '--root', repository.root, '-f'],
  ]) {
    const result = await adapter([...argv, '--json'], repository.root, { source_root: source.root });
    assert.equal(result.exitCode, 2, argv.join(' '));
    assert.equal(JSON.parse(result.stdout).findings[0].code, 'AKRS-C001');
  }
  assert.equal(await byteTreeHash(repository.root), before);
});

test('F2r postinstall resolves the repository like init and sync: INIT_CWD below a git root targets the git root', async (t) => {
  const project = await makeRepo(t, {
    '.git/HEAD': 'ref: refs/heads/main\n',
    'package.json': '{"name":"host"}\n',
    'packages/app/index.js': 'x\n',
  });
  const packageRoot = project.path('node_modules/akrs-framework');
  await mkdir(packageRoot, { recursive: true });
  await writeTree(packageRoot, {
    'docs/framework/01-Constitution.md': 'constitution v1\n',
    'GETTING_STARTED.md': 'getting started v1\n',
  });
  const subdirectory = project.path('packages/app');
  const context = {
    env: { INIT_CWD: subdirectory },
    package_root: packageRoot,
    source_root: packageRoot,
  };

  const result = await adapter(['postinstall', '--json'], subdirectory, context);
  assert.equal(result.exitCode, 0);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.status, 'ok');
  assert.equal(packet.data.outcome, 'synced');
  assert.equal(packet.root, normalizeAbsolutePath(project.root));
  const files = await listFiles(project.root);
  assert.equal(files['docs/akrs/GETTING_STARTED.md'], 'getting started v1\n');
  assert.equal(Object.keys(files).some((path) => path.startsWith('packages/app/docs')), false);
  assert.equal(packet.changed.every((path) => path.startsWith('docs/akrs/')), true);

  const sync = await adapter(['sync', '--json'], subdirectory, { source_root: packageRoot });
  assert.equal(sync.exitCode, 0);
  assert.equal(JSON.parse(sync.stdout).status, 'noop');
});
