import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseNpmJson, repositoryRoot, repositoryTarballs, runNpm } from './pack-harness.js';

const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

test('package.json declares the v2 prerelease runtime contract', () => {
  assert.equal(packageJson.version, '2.0.0-alpha.0');
  assert.equal(packageJson.engines.node, '>=22.17.0');
  assert.equal(packageJson.scripts.test, 'node --test');
  assert.equal(packageJson.scripts.postinstall, 'node bin/akrs.js postinstall');
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.bin.akrs, 'bin/akrs.js');
  for (const entry of ['bin', 'lib', 'docs/framework', 'examples/minimal']) {
    assert.equal(packageJson.files.includes(entry), true, `files must list ${entry}`);
  }
});

test('npm pack --dry-run ships the runtime and excludes development material', async () => {
  const before = await repositoryTarballs();
  const result = await runNpm(['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: repositoryRoot,
  });
  const [entry] = parseNpmJson('npm pack --dry-run', result);
  const paths = entry.files.map(({ path }) => path);
  const has = (prefix) => paths.some((path) => path === prefix || path.startsWith(prefix));

  for (const required of [
    'package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'VERSIONING.md', 'GETTING_STARTED.md',
    'bin/akrs.js', 'bin/akrs-guard.js', 'bin/node-guard.js', 'bin/cli-adapter.js',
    'lib/core/index.js', 'lib/commands/meta.js',
    'docs/framework/01-Constitution.md',
    'examples/minimal/README.md', 'examples/minimal/akrs/roads/R1.json', 'examples/minimal/akrs/state.json', 'examples/minimal/akrs/STATE.md',
    'examples/minimal/akrs/executors.json', 'examples/minimal/akrs/tasks/T1.md', 'examples/minimal/akrs/verifications/R1/contract.json',
  ]) {
    assert.equal(paths.includes(required), true, `tarball must contain ${required}`);
  }
  for (const prefix of ['bin/', 'lib/', 'docs/framework/skills/', 'examples/minimal/']) {
    assert.equal(has(prefix), true, `tarball must contain ${prefix}`);
  }
  for (const excluded of [
    'test/', 'plans/', 'docs/research/', 'docs/validation/', 'docs/guides/', '.github/',
    '.claude/', 'node_modules/', 'templates/',
  ]) {
    assert.equal(has(excluded), false, `tarball must not contain ${excluded}`);
  }
  assert.equal(paths.some((path) => path.endsWith('.tgz')), false, 'tarball must not nest a .tgz');
  assert.equal(paths.includes('examples/README.md'), false, 'only examples/minimal ships');
  assert.deepEqual(await repositoryTarballs(), before, 'dry run must not leave a .tgz in the repository');
});

test('v2 prereleases publish under the next dist-tag, publicly', () => {
  assert.deepEqual(packageJson.publishConfig, { access: 'public', tag: 'next' });
});
