import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { installDoctrine } from '../../lib/store/doctrine-install.js';
import { PathSafetyError } from '../../lib/store/path-service.js';
import { byteTreeHash } from '../helpers/byte-tree.js';
import { listFiles, makeRepo, makeSource, markRecovery, writeTree } from './support.js';

const STAGING = 'docs/.akrs.akrs-staging';
const BACKUP = 'docs/.akrs.akrs-backup';

function run(repository, source, options = {}) {
  return installDoctrine({
    mode: 'sync',
    repositoryRoot: repository.root,
    sourceRoot: source.root,
    ...options,
  });
}

async function installed(t) {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  await run(repository, source, { mode: 'init' });
  return { source, repository };
}

test('F3 an unmarked look-alike backup beside a live target is reported and never deleted', async (t) => {
  const { source, repository } = await installed(t);
  await writeTree(repository.root, { [`${BACKUP}/precious.md`]: 'user data\n' });
  await writeTree(source.root, { 'docs/framework/02-Spec.md': 'spec v2\n' });
  const note = [{ action: 'skip_unmarked_backup', path: BACKUP }];

  const dry = await run(repository, source, { dryRun: true });
  assert.deepEqual(dry.recovery, note);
  const result = await run(repository, source);
  assert.deepEqual(result.recovery, note);
  assert.equal(result.applied, true);
  assert.equal(await readFile(repository.path(`${BACKUP}/precious.md`), 'utf8'), 'user data\n');
  assert.equal(await readFile(repository.path('docs/akrs/framework/02-Spec.md'), 'utf8'), 'spec v2\n');
});

test('F3 an unmarked look-alike backup with a missing target is not restored; the target is created fresh', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t, { [`${BACKUP}/precious.md`]: 'user data\n' });
  const result = await run(repository, source);
  assert.deepEqual(result.recovery, [{ action: 'skip_unmarked_backup', path: BACKUP }]);
  assert.equal(await readFile(repository.path(`${BACKUP}/precious.md`), 'utf8'), 'user data\n');
  const files = await listFiles(repository.path('docs/akrs'));
  assert.equal('precious.md' in files, false);
  assert.equal(files['GETTING_STARTED.md'], 'getting started v1\n');
});

test('F3 forced init refuses to use an occupied, unmarked backup path and changes nothing', async (t) => {
  const { source, repository } = await installed(t);
  await writeTree(repository.root, { [`${BACKUP}/precious.md`]: 'user data\n' });
  await writeTree(source.root, { 'docs/framework/02-Spec.md': 'spec v2\n' });
  const before = await byteTreeHash(repository.root);
  await assert.rejects(() => run(repository, source, { mode: 'init', force: true }), PathSafetyError);
  assert.equal(await byteTreeHash(repository.root), before);
});

test('F3 an unmarked look-alike staging directory is reported and never deleted or used', async (t) => {
  const { source, repository } = await installed(t);
  await writeTree(repository.root, { [`${STAGING}/precious.md`]: 'user data\n' });
  await writeTree(source.root, { 'docs/framework/02-Spec.md': 'spec v2\n' });
  const before = await byteTreeHash(repository.root);

  const dry = await run(repository, source, { dryRun: true });
  assert.deepEqual(dry.recovery, [{ action: 'skip_unmarked_staging', path: STAGING }]);
  await assert.rejects(() => run(repository, source), PathSafetyError);
  assert.equal(await byteTreeHash(repository.root), before);
});

test('F3 markers must be closed and carry the matching role, otherwise the directory is unmarked', async (t) => {
  const { source, repository } = await installed(t);
  const marker = (directory, text) => writeFile(`${directory}/.akrs-recovery.json`, text);
  for (const text of [
    '{not json',
    '[]',
    JSON.stringify({ schema_version: 'akrs.install-staging/v1', role: 'backup' }),
    JSON.stringify({ schema_version: 'akrs.install-staging/v1', role: 'staging', extra: 1 }),
    JSON.stringify({ schema_version: 'akrs.install-staging/v2', role: 'staging' }),
  ]) {
    await mkdir(repository.path(STAGING), { recursive: true });
    await marker(repository.path(STAGING), text);
    const dry = await run(repository, source, { dryRun: true });
    assert.deepEqual(dry.recovery, [{ action: 'skip_unmarked_staging', path: STAGING }], text);
    assert.equal(await readFile(repository.path(`${STAGING}/.akrs-recovery.json`), 'utf8'), text);
  }
});

test('F3 a target that appears after planning is never moved or deleted by the swap', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  const appearing = async (path, options) => {
    const result = await mkdir(path, options);
    if (path.endsWith('.akrs.akrs-staging')) {
      await mkdir(repository.path('docs/akrs'), { recursive: true });
      await writeFile(repository.path('docs/akrs/precious.md'), 'user data\n');
    }
    return result;
  };
  await assert.rejects(
    () => run(repository, source, { fsOps: { mkdir: appearing } }),
    /appeared during install/,
  );
  assert.deepEqual(await listFiles(repository.root), { 'docs/akrs/precious.md': 'user data\n' });
});

test('F3 a successful swap leaves no recovery marker or backup in the live tree', async (t) => {
  const { source, repository } = await installed(t);
  await writeTree(source.root, { 'docs/framework/02-Spec.md': 'spec v2\n' });
  await run(repository, source, { mode: 'init', force: true });
  const files = await listFiles(repository.root);
  assert.equal(Object.keys(files).some((path) => path.includes('.akrs-recovery.json')), false);
  assert.equal(Object.keys(files).some((path) => path.includes('akrs-backup') || path.includes('akrs-staging')), false);
});

test('F3 a failed swap restores the previous tree without leaving a marker in it', async (t) => {
  const { source, repository } = await installed(t);
  await writeTree(source.root, { 'docs/framework/02-Spec.md': 'spec v2\n' });
  const before = await listFiles(repository.root);
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
  assert.deepEqual(await listFiles(repository.root), before);
});

test('F3 a stray valid marker inside the live target is removed and reported as a changed path', async (t) => {
  const { source, repository } = await installed(t);
  await markRecovery(repository.path('docs/akrs'), 'staging');
  const result = await run(repository, source);
  assert.deepEqual(result.recovery, [{ action: 'remove_marker', path: 'docs/akrs/.akrs-recovery.json' }]);
  assert.deepEqual(result.changed, ['docs/akrs/.akrs-recovery.json']);
  assert.equal(result.applied, true);
  await assert.rejects(() => readFile(repository.path('docs/akrs/.akrs-recovery.json')));
});

test('F3 a user file named like the marker is never overwritten by the backup step', async (t) => {
  const { source, repository } = await installed(t);
  await writeFile(repository.path('docs/akrs/.akrs-recovery.json'), 'mine\n');
  await writeTree(source.root, { 'docs/framework/02-Spec.md': 'spec v2\n' });
  const before = await byteTreeHash(repository.root);
  await assert.rejects(() => run(repository, source, { mode: 'init', force: true }), PathSafetyError);
  assert.equal(await byteTreeHash(repository.root), before);
});
