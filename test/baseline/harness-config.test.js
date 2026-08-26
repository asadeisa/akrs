import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repositoryRoot = new URL('../../', import.meta.url);

test('package uses the dependency-free node:test runner', async () => {
  const packageJson = JSON.parse(await readFile(new URL('package.json', repositoryRoot), 'utf8'));
  assert.equal(packageJson.scripts.test, 'node --test');
  assert.equal(packageJson.devDependencies, undefined);
});

test('CI covers Windows and Ubuntu on the locked Node matrix', async () => {
  const workflow = await readFile(new URL('.github/workflows/ci.yml', repositoryRoot), 'utf8');

  assert.match(workflow, /^\s*- ubuntu-latest$/m);
  assert.match(workflow, /^\s*- windows-latest$/m);
  assert.match(workflow, /^\s*- 22\.17\.0$/m);
  assert.match(workflow, /^\s*- 24\.x$/m);
  assert.match(workflow, /^\s*- run: npm test$/m);
});
