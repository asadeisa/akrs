import assert from 'node:assert/strict';
import { chmod, link, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { applyManagedBlockToFile } from '../../lib/store/managed-block.js';
import { PathSafetyError, createPathService } from '../../lib/store/path-service.js';
import { createTempRepository } from '../helpers/temp-repository.js';
import { listFiles } from './support.js';

const BLOCK = { id: 'akrs', style: 'hash', content: 'akrs/.tmp\n', dryRun: false };

async function fixture(t, files = {}) {
  const repository = await createTempRepository(t, { prefix: 'akrs-block-write-' });
  for (const [path, data] of Object.entries(files)) await repository.write(path, data);
  const paths = await createPathService({ repositoryRoot: repository.root, workflowRoot: repository.root });
  return { repository, paths };
}

test('F4 a failure between the temp write and the rename leaves the original bytes and no temp file', async (t) => {
  const { repository, paths } = await fixture(t, { 'sub/.gitignore': 'node_modules\r\n' });
  const before = await listFiles(repository.root);
  const failing = async () => {
    throw Object.assign(new Error('simulated rename failure'), { code: 'EPERM' });
  };
  await assert.rejects(
    () => applyManagedBlockToFile(paths, 'sub/.gitignore', { ...BLOCK, fsOps: { rename: failing } }),
    /simulated rename failure/,
  );
  assert.deepEqual(await listFiles(repository.root), before);

  const ok = await applyManagedBlockToFile(paths, 'sub/.gitignore', BLOCK);
  assert.equal(ok.outcome, 'created');
  assert.deepEqual(Object.keys(await listFiles(repository.root)), ['sub/.gitignore']);
  assert.equal((await readFile(repository.path('sub/.gitignore'), 'utf8')).startsWith('node_modules\r\n# akrs:begin akrs'), true);
});

test('F4 a failed write of a new file leaves neither the file nor a temp sibling', async (t) => {
  const { repository, paths } = await fixture(t);
  const failing = async () => {
    throw Object.assign(new Error('simulated link failure'), { code: 'EIO' });
  };
  await assert.rejects(
    () => applyManagedBlockToFile(paths, 'new/.gitignore', { ...BLOCK, fsOps: { link: failing } }),
    /simulated link failure/,
  );
  assert.deepEqual(Object.keys(await listFiles(repository.root)), []);
});

test('F4 a new file is placed with a hard link that never replaces, and the temp sibling is removed', async (t) => {
  const { repository, paths } = await fixture(t);
  const links = [];
  const spying = async (from, to) => {
    links.push([from, to]);
    return link(from, to);
  };
  const result = await applyManagedBlockToFile(paths, 'new/.gitignore', { ...BLOCK, fsOps: { link: spying } });
  assert.equal(result.outcome, 'created');
  assert.equal(result.applied, true);
  assert.equal(links.length, 1);
  assert.equal(links[0][1], repository.path('new/.gitignore'));
  assert.notEqual(links[0][0], links[0][1]);
  assert.deepEqual(Object.keys(await listFiles(repository.root)), ['new/.gitignore']);
});

test('F4 a target created concurrently between planning and placing is never replaced', async (t) => {
  const { repository, paths } = await fixture(t);
  const racingWrite = async (path, data, options) => {
    await writeFile(path, data, options);
    await writeFile(repository.path('new.cfg'), 'concurrent\n');
  };
  const result = await applyManagedBlockToFile(paths, 'new.cfg', { ...BLOCK, fsOps: { writeFile: racingWrite } });
  assert.equal(result.outcome, 'conflict');
  assert.equal(result.reason, 'target_created_concurrently');
  assert.equal(result.applied, false);
  assert.equal(result.changed, false);
  assert.deepEqual(await listFiles(repository.root), { 'new.cfg': 'concurrent\n' });
});

test('F4 without hard-link support the copy fallback is exclusive too', async (t) => {
  const { repository, paths } = await fixture(t);
  const unsupported = async () => {
    throw Object.assign(new Error('links unsupported'), { code: 'EPERM' });
  };
  const created = await applyManagedBlockToFile(paths, 'a.cfg', { ...BLOCK, fsOps: { link: unsupported } });
  assert.equal(created.outcome, 'created');
  assert.equal((await readFile(repository.path('a.cfg'), 'utf8')).startsWith('# akrs:begin akrs'), true);
  assert.deepEqual(Object.keys(await listFiles(repository.root)), ['a.cfg']);

  const racingWrite = async (path, data, options) => {
    await writeFile(path, data, options);
    await writeFile(repository.path('b.cfg'), 'concurrent\n');
  };
  const raced = await applyManagedBlockToFile(paths, 'b.cfg', {
    ...BLOCK, fsOps: { link: unsupported, writeFile: racingWrite },
  });
  assert.equal(raced.outcome, 'conflict');
  assert.equal(raced.reason, 'target_created_concurrently');
  assert.deepEqual(await listFiles(repository.root), {
    'a.cfg': await readFile(repository.path('a.cfg'), 'utf8'),
    'b.cfg': 'concurrent\n',
  });
});

test('F4 a concurrent edit between planning and the rename is detected and the temp file is removed', async (t) => {
  const { repository, paths } = await fixture(t, { '.gitignore': 'node_modules\n' });
  const racingWrite = async (path, data, options) => {
    await writeFile(path, data, options);
    await writeFile(repository.path('.gitignore'), 'concurrent edit\n');
  };
  await assert.rejects(
    () => applyManagedBlockToFile(paths, '.gitignore', { ...BLOCK, fsOps: { writeFile: racingWrite } }),
    PathSafetyError,
  );
  assert.deepEqual(await listFiles(repository.root), { '.gitignore': 'concurrent edit\n' });
});

test('F4 the write goes through a same-directory temp sibling renamed over the target', async (t) => {
  const { repository, paths } = await fixture(t, { 'docs/notes.md': 'hello\n' });
  const renames = [];
  const spying = async (from, to) => {
    renames.push([from, to]);
    return rename(from, to);
  };
  const result = await applyManagedBlockToFile(paths, 'docs/notes.md', {
    id: 'akrs', style: 'html', content: 'x\n', dryRun: false, fsOps: { rename: spying },
  });
  assert.equal(result.applied, true);
  assert.equal(renames.length, 1);
  const [from, to] = renames[0];
  assert.equal(to, repository.path('docs/notes.md'));
  assert.notEqual(from, to);
  assert.equal(from.slice(0, from.lastIndexOf(process.platform === 'win32' ? '\\' : '/')),
    to.slice(0, to.lastIndexOf(process.platform === 'win32' ? '\\' : '/')));
  assert.deepEqual(Object.keys(await listFiles(repository.root)), ['docs/notes.md']);
});

test('F4 the existing file mode is preserved on POSIX hosts', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX file modes are not meaningful on Windows');
    return;
  }
  const { repository, paths } = await fixture(t, { 'secret.cfg': 'a=1\n' });
  await chmod(repository.path('secret.cfg'), 0o640);
  await applyManagedBlockToFile(paths, 'secret.cfg', BLOCK);
  assert.equal((await stat(repository.path('secret.cfg'))).mode & 0o777, 0o640);
});
