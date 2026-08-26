import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assertPathWithin, pathWithin } from './paths.js';

export async function createTempRepository(testContext, options = {}) {
  const temporaryRoot = resolve(tmpdir());
  const root = await mkdtemp(join(temporaryRoot, options.prefix ?? 'akrs-test-'));
  assertPathWithin(temporaryRoot, root);

  if (options.fixture) {
    await cp(options.fixture, root, { recursive: true });
  }

  let removed = false;
  const cleanup = async () => {
    if (removed) return;
    assertPathWithin(temporaryRoot, root);
    await rm(root, { recursive: true, force: true });
    removed = true;
  };

  if (testContext?.after) testContext.after(cleanup);

  return {
    root,
    cleanup,
    path(...segments) {
      return pathWithin(root, ...segments);
    },
    async write(relativePath, data) {
      const target = pathWithin(root, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
      return target;
    },
  };
}
