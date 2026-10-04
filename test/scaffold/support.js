// Shared helpers for the P1-W13 scaffold tests: an EMPTY repository (no akrs/ yet) and in-process CLI runs.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeProviders, runCommand, treeDigest } from '../road/support.js';
import { createTempRepository } from '../helpers/temp-repository.js';

export { runCommand, treeDigest };

export async function emptyRepo(t) {
  const repository = await createTempRepository(t, { prefix: 'akrs-scaffold-' });
  // A fixed clock: scaffold bytes then depend only on the inputs (run IDs still count up, so requests never collide).
  const providers = fakeProviders();
  providers.now = () => '2026-10-03T10:00:00.000Z';
  return { ...repository, read: (path) => readFile(repository.path(path), 'utf8'), providers };
}

export const scaffold = async (repo, args = []) => {
  const result = await runCommand(repo, ['init', '--scaffold', '--json', ...args], { providers: repo.providers });
  return { exitCode: result.exitCode, packet: JSON.parse(result.stdout) };
};
export const validate = async (repo) => JSON.parse((await runCommand(repo, ['validate', '--json'], { providers: repo.providers })).stdout);

// Every file below a directory as { 'a/b.txt': content }, sorted.
export async function treeOf(root) {
  const out = {};
  async function walk(directory, prefix) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(directory, entry.name);
      if (entry.name === '.ops') continue;
      if (entry.isDirectory()) await walk(path, `${prefix}${entry.name}/`);
      else out[`${prefix}${entry.name}`] = await readFile(path, 'utf8');
    }
  }
  await walk(root, '');
  return out;
}
