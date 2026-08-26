import assert from 'node:assert/strict';
import test from 'node:test';
import { byteTreeHash } from '../helpers/byte-tree.js';
import { runCli } from '../helpers/process.js';
import { createTempRepository } from '../helpers/temp-repository.js';

const fixture = new URL('../fixtures/legacy/cli-usage/project/', import.meta.url);

test('current CLI can be invoked without mutating its fixture', async (t) => {
  const repository = await createTempRepository(t, { fixture });
  const before = await byteTreeHash(repository.root);
  const result = await runCli(['--help'], { cwd: repository.root });
  const after = await byteTreeHash(repository.root);

  assert.equal(result.timedOut, false);
  assert.equal(Number.isInteger(result.exitCode), true);
  assert.notEqual(`${result.stdout}${result.stderr}`, '');
  assert.equal(after, before);
});
