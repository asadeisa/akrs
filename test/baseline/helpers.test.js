import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { byteTreeHash } from '../helpers/byte-tree.js';
import { assertNormalizedRepoPath, normalizeRepoPath } from '../helpers/paths.js';
import { runNode } from '../helpers/process.js';
import { createTempRepository } from '../helpers/temp-repository.js';

test('temporary repository writes are contained and byte-tree hashes are deterministic', async (t) => {
  const repository = await createTempRepository(t);
  await repository.write('nested/value.txt', Buffer.from('value\r\n', 'utf8'));

  const firstHash = await byteTreeHash(repository.root);
  const secondHash = await byteTreeHash(repository.root);
  assert.equal(firstHash, secondHash);
  assert.deepEqual(await readFile(repository.path('nested/value.txt')), Buffer.from('value\r\n'));

  assert.throws(() => repository.path('..', 'outside.txt'), /escapes temporary root/);
});

test('repository paths normalize to portable slash form', () => {
  assert.equal(normalizeRepoPath('akrs\\roads\\R1.md'), 'akrs/roads/R1.md');
  assert.doesNotThrow(() => assertNormalizedRepoPath('akrs/roads/R1.md'));
  assert.throws(() => assertNormalizedRepoPath('akrs\\roads\\R1.md'));
  assert.throws(() => assertNormalizedRepoPath('C:/outside.md'));
  assert.throws(() => assertNormalizedRepoPath('//server/share.md'));
  assert.throws(() => assertNormalizedRepoPath('../outside.md'));
});

test('child execution captures streams and injects deterministic environment', async () => {
  const result = await runNode([
    '-e',
    "process.stdout.write(process.env.AKRS_TEST_VALUE); process.stderr.write('captured')",
  ], { env: { AKRS_TEST_VALUE: 'injected' } });

  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, 'injected');
  assert.equal(result.stderr, 'captured');
});
