import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeRepoPath } from './paths.js';

export async function byteTreeHash(root) {
  const hash = createHash('sha256');

  async function walk(directory, relativeDirectory = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));

    for (const entry of entries) {
      const relativePath = normalizeRepoPath(join(relativeDirectory, entry.name));
      const absolutePath = join(directory, entry.name);
      const metadata = await lstat(absolutePath);

      if (metadata.isSymbolicLink()) {
        hash.update(`link\0${relativePath}\0${await readlink(absolutePath)}\0`);
      } else if (metadata.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`);
        await walk(absolutePath, relativePath);
      } else if (metadata.isFile()) {
        const bytes = await readFile(absolutePath);
        hash.update(`file\0${relativePath}\0${bytes.byteLength}\0`);
        hash.update(bytes);
      }
    }
  }

  await walk(root);
  return hash.digest('hex');
}
