// F5 product input policy: snapshots read working-tree bytes; the git index, HEAD, and ignore rules are not consulted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { computeSnapshot } from '../../lib/store/snapshots/index.js';
import { createTempRepository } from '../helpers/temp-repository.js';
import { jsonText } from './support.js';

const gitAvailable = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

const ROAD = {
  schema: 'akrs.road/v1', id: 'R1', plan: null, task: null, status: 'ACTIVE', deps: [], reads: [],
  writes: [{ path: 'src/gen', class: 'dir', action: 'create' }],
};

function git(cwd, ...args) {
  const result = spawnSync('git', [
    '-c', 'user.name=Snapshot Test', '-c', 'user.email=snapshot@example.invalid', '-c', 'commit.gpgsign=false', ...args,
  ], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

async function setup(t) {
  const repository = await createTempRepository(t, { prefix: 'akrs-snap-git-' });
  await repository.write('akrs/roads/R1.json', jsonText(ROAD));
  await repository.write('src/gen/a.js', 'export const a = 1;\n');
  await repository.write('.gitignore', 'ignored.log\n');
  git(repository.root, 'init', '--quiet');
  git(repository.root, 'add', '-A');
  git(repository.root, 'commit', '--quiet', '-m', 'initial');
  const snapshot = async () => {
    const result = await computeSnapshot({
      repositoryRoot: repository.root,
      workflowRoot: repository.path('akrs'),
      projections: ['road', 'road-writes'],
      target: { road: 'R1' },
    });
    assert.equal(result.status, 'ok');
    return result.snapshot;
  };
  return { repository, snapshot };
}

test('git index and HEAD are not snapshot inputs', { skip: !gitAvailable }, async (t) => {
  const { repository, snapshot } = await setup(t);
  const original = await snapshot();

  // Staging a file whose working-tree bytes equal the committed bytes changes nothing.
  git(repository.root, 'add', 'src/gen/a.js');
  assert.equal(await snapshot(), original);

  // Modify and stage, then restore the committed bytes in the worktree: the index still holds the edit.
  await repository.write('src/gen/a.js', 'export const a = 2;\n');
  git(repository.root, 'add', 'src/gen/a.js');
  assert.notEqual(await snapshot(), original);
  await repository.write('src/gen/a.js', 'export const a = 1;\n');
  assert.equal(await snapshot(), original);
  assert.match(git(repository.root, 'diff', '--cached', '--stat'), /a\.js/);

  // Committing the staged state (the index differs from the worktree) does not change the snapshot either.
  git(repository.root, 'commit', '--quiet', '-m', 'second');
  assert.equal(await snapshot(), original);
});

test('untracked and git-ignored files inside a declared dir are inputs', { skip: !gitAvailable }, async (t) => {
  const { repository, snapshot } = await setup(t);
  const original = await snapshot();

  await repository.write('src/gen/untracked.js', 'export const u = 1;\n');
  const withUntracked = await snapshot();
  assert.notEqual(withUntracked, original);
  assert.match(git(repository.root, 'status', '--porcelain'), /untracked\.js/);

  await repository.write('src/gen/ignored.log', 'noise\n');
  assert.equal(git(repository.root, 'status', '--porcelain').includes('ignored.log'), false);
  assert.notEqual(await snapshot(), withUntracked);
});
