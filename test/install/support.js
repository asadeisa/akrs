import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalizeRepoPath } from '../helpers/paths.js';
import { createTempRepository } from '../helpers/temp-repository.js';

export const providers = {
  now: () => '2026-08-25T10:30:00.000Z',
  runId: () => '01ARZ3NDEKTSV4RRFFQ69G5FAV',
};

export const SOURCE_FILES = Object.freeze({
  'docs/framework/01-Constitution.md': 'constitution v1\n',
  'docs/framework/02-Spec.md': 'spec v1\n',
  'docs/framework/skills/README.md': 'skills readme v1\n',
  'docs/framework/skills/akrs-close-out.md': 'close out v1\n',
  'GETTING_STARTED.md': 'getting started v1\n',
});

export async function writeTree(root, files) {
  for (const [path, data] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

export async function makeSource(t, files = SOURCE_FILES) {
  const source = await createTempRepository(t, { prefix: 'akrs-install-src-' });
  await writeTree(source.root, files);
  return source;
}

export async function makeRepo(t, files = {}) {
  const repository = await createTempRepository(t, { prefix: 'akrs-install-repo-' });
  await writeTree(repository.root, files);
  return repository;
}

export async function listFiles(root) {
  const files = {};
  async function walk(directory, prefix) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : 1));
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), path);
      else if (entry.isFile()) files[path] = await readFile(join(directory, entry.name), 'utf8');
    }
  }
  await walk(root, '');
  return files;
}

export function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export async function linkDirectory(target, linkPath) {
  await mkdir(dirname(linkPath), { recursive: true });
  await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

export function assertPortable(paths) {
  for (const path of paths) {
    if (path !== normalizeRepoPath(path) || path.includes('\\')) {
      throw new Error(`path is not repo-relative with forward slashes: ${path}`);
    }
  }
}

export async function hostIsCaseSensitive(t) {
  const probe = await createTempRepository(t, { prefix: 'akrs-case-probe-' });
  await writeFile(join(probe.root, 'probe.txt'), '1');
  await writeFile(join(probe.root, 'PROBE.txt'), '2');
  return Object.keys(await listFiles(probe.root)).length === 2;
}

export async function markRecovery(directory, role) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, '.akrs-recovery.json'),
    `${JSON.stringify({ schema_version: 'akrs.install-staging/v1', role })}\n`,
  );
}
