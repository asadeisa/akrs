import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCliAdapter } from '../../bin/cli-adapter.js';
import { commandHandlers, commandManifest, normalizeAbsolutePath } from '../../lib/core/index.js';
import { installDoctrine } from '../../lib/store/doctrine-install.js';
import { applyManagedBlockToFile } from '../../lib/store/managed-block.js';
import { PathSafetyError, createPathService } from '../../lib/store/path-service.js';
import { byteTreeHash } from '../helpers/byte-tree.js';
import { createTempRepository } from '../helpers/temp-repository.js';
import { SOURCE_FILES, listFiles, providers, shortAlias, writeTree } from './support.js';

const SKIP = '8.3 short names unavailable';

test('F8 the overlap check and new-file writes hold when the root is given as an 8.3 short alias', async (t) => {
  const base = await createTempRepository(t, { prefix: 'akrs short alias base ' });
  const longRoot = join(base.root, 'repository with a long name');
  await mkdir(longRoot);
  const short = shortAlias(longRoot);
  if (short === null) {
    t.skip(SKIP);
    return;
  }
  await writeTree(longRoot, SOURCE_FILES);
  const before = await byteTreeHash(longRoot);

  await assert.rejects(
    () => installDoctrine({
      mode: 'init', force: true, repositoryRoot: short, sourceRoot: short, target: 'docs/framework',
    }),
    PathSafetyError,
  );
  await assert.rejects(
    () => installDoctrine({
      mode: 'init',
      force: true,
      repositoryRoot: short,
      sourceRoot: join(short, 'docs', 'framework'),
      target: 'docs',
    }),
    PathSafetyError,
  );
  assert.equal(await byteTreeHash(longRoot), before);

  const paths = await createPathService({ repositoryRoot: short, workflowRoot: short });
  const result = await applyManagedBlockToFile(paths, 'new/.gitignore', {
    id: 'akrs', style: 'hash', content: 'akrs/.tmp\n', dryRun: false,
  });
  assert.equal(result.outcome, 'created');
  const files = await listFiles(longRoot);
  assert.equal(files['new/.gitignore'].startsWith('# akrs:begin akrs'), true);
  assert.equal(Object.keys(files).some((path) => path.includes('akrs-tmp')), false);

  const installed = await installDoctrine({
    mode: 'init', repositoryRoot: short, sourceRoot: short, target: 'docs/akrs',
  });
  assert.equal(installed.applied, true);
  assert.equal((await installDoctrine({
    mode: 'init', force: true, repositoryRoot: short, sourceRoot: short, target: 'docs/akrs',
  })).changes.length, 0);
});

async function adapter(argv, cwd, context) {
  return runCliAdapter({
    argv,
    cwd,
    manifest: commandManifest,
    handlers: commandHandlers,
    providers,
    resolveContext: async () => ({ repository_root: normalizeAbsolutePath(cwd), ...context }),
  });
}

test('F8 postinstall self-guards and the node_modules check compare canonical paths', async (t) => {
  const base = await createTempRepository(t, { prefix: 'akrs short alias project ' });
  const packageRoot = join(base.root, 'node_modules', 'akrs-framework');
  await mkdir(packageRoot, { recursive: true });
  await writeTree(packageRoot, SOURCE_FILES);
  const shortPackage = shortAlias(packageRoot);
  if (shortPackage === null) {
    t.skip(SKIP);
    return;
  }
  const before = await byteTreeHash(base.root);

  const own = await adapter(['postinstall', '--json'], base.root, {
    env: { INIT_CWD: shortPackage },
    package_root: packageRoot,
    source_root: packageRoot,
  });
  assert.equal(own.exitCode, 0);
  assert.equal(JSON.parse(own.stdout).data.reason, 'init_cwd_is_package');
  assert.equal(await byteTreeHash(base.root), before);

  const dependency = await adapter(['postinstall', '--json'], base.root, {
    env: { INIT_CWD: base.root },
    package_root: shortPackage,
    source_root: shortPackage,
  });
  assert.equal(dependency.exitCode, 0);
  const packet = JSON.parse(dependency.stdout);
  assert.equal(packet.data.outcome, 'synced');
  assert.equal((await listFiles(await realpath(base.root)))['docs/akrs/GETTING_STARTED.md'], 'getting started v1\n');
});
