// Real child-process runs of `task new`.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validatePacket } from '../../lib/schemas/packet.js';
import { runCli } from '../helpers/process.js';
import { codesOf, createRepo, draftDocument, pointersOf, roadInput, seedRoad } from '../road/support.js';
import { taskInput } from './scaffold.test.js';

const cli = (repo, args, options = {}) => runCli([...args, '--root', repo.root], { cwd: repo.root, ...options });

async function repoWithRoad(t) {
  const repo = await createRepo(t);
  await seedRoad(repo, roadInput({ id: 'R-P6-1', plan: 'P6', task: 'T-P6-1' }), { folder: 'roads/P6' });
  return repo;
}

test('task new --input <draft> --json: exit 0, one packet, scaffold written, draft consumed', async (t) => {
  const repo = await repoWithRoad(t);
  await draftDocument(repo, 'task-a', taskInput());
  const result = await cli(repo, ['task', 'new', '--input', 'akrs/drafts/task-a.json', '--json']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, '');
  const packet = JSON.parse(result.stdout);
  assert.equal(validatePacket(packet).ok, true);
  assert.equal(packet.command, 'task-new');
  assert.deepEqual(packet.changed, ['drafts/task-a.json', 'tasks/T-P6-1.md']);
  const text = await repo.read('akrs/tasks/T-P6-1.md');
  assert.equal(text.startsWith('<!-- akrs:task '), true);
  await assert.rejects(() => readFile(repo.path('akrs/drafts/task-a.json')), { code: 'ENOENT' });
});

test('task new --json - works from stdin; a retry is a noop; a Task for a missing Road exits 1 and writes nothing', async (t) => {
  const repo = await repoWithRoad(t);
  const body = JSON.stringify(taskInput());
  const first = await cli(repo, ['task', 'new', '--json', '-'], { stdin: body });
  assert.equal(first.exitCode, 0, first.stderr);
  const again = await cli(repo, ['task', 'new', '--json', '-'], { stdin: body });
  assert.equal(again.exitCode, 0);
  assert.equal(JSON.parse(again.stdout).status, 'noop');

  const lonely = await createRepo(t);
  const missing = await cli(lonely, ['task', 'new', '--json', '-'], { stdin: body });
  assert.equal(missing.exitCode, 1);
  assert.deepEqual(codesOf(JSON.parse(missing.stdout)), ['AKRS-R013']);
  await assert.rejects(() => readFile(lonely.path('akrs/tasks/T-P6-1.md')), { code: 'ENOENT' });
});

test('a Task document with an executable field exits 2 with the pointer', async (t) => {
  const repo = await repoWithRoad(t);
  const result = await cli(repo, ['task', 'new', '--json', '-'], { stdin: JSON.stringify({ ...taskInput(), acceptance: ['x'] }) });
  assert.equal(result.exitCode, 2);
  assert.deepEqual(pointersOf(JSON.parse(result.stdout)), ['/acceptance']);
});
