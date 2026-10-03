// P1-W02: the validate packet reports a real, stable snapshot of its declared inputs (replaces the EMPTY placeholder).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EMPTY_SNAPSHOT, commandSnapshot } from '../../lib/store/snapshots/index.js';
import { runCli } from '../helpers/process.js';
import { createTempRepository } from '../helpers/temp-repository.js';

const fixture = fileURLToPath(new URL('../fixtures/validation/dependency-graph', import.meta.url));

async function validatePacket(repository) {
  const result = await runCli([
    'validate', '--root', repository.root, '--workflow-root', repository.path('akrs'), '--json',
  ]);
  assert.equal(result.timedOut, false);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

test('validate reports the workflow snapshot, identical before and after', async (t) => {
  const repository = await createTempRepository(t, { prefix: 'akrs-snap-cli-', fixture });
  const packet = await validatePacket(repository);
  assert.equal(packet.command, 'validate');
  assert.equal(packet.snapshot.before, packet.snapshot.after);
  assert.notEqual(packet.snapshot.before, EMPTY_SNAPSHOT);
  const expected = await commandSnapshot('validate', {
    repositoryRoot: repository.root, workflowRoot: repository.path('akrs'),
  });
  assert.equal(expected.status, 'ok');
  assert.equal(packet.snapshot.before, expected.snapshot);
});

test('validate snapshot changes with the workflow inputs and not with housekeeping', async (t) => {
  const repository = await createTempRepository(t, { prefix: 'akrs-snap-cli-', fixture });
  const first = (await validatePacket(repository)).snapshot.before;
  await repository.write('akrs/.ops/lock', 'pid 1');
  await repository.write('akrs/drafts/scratch.md', 'draft');
  assert.equal((await validatePacket(repository)).snapshot.before, first);
  await repository.write('akrs/memory/note.md', '# note\n');
  assert.notEqual((await validatePacket(repository)).snapshot.before, first);
});
