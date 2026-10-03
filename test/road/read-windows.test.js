import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
import { test } from 'node:test';
import { computeSnapshot } from '../../lib/store/snapshots/index.js';
import { READ_WINDOW_STATUSES, projectReadWindows } from '../../lib/store/roads/index.js';
import { createRepo, roadInput, seedRoad } from './support.js';

const project = (repo, reads, extra = {}) => projectReadWindows({
  ...repo.options, road: { reads, writes: extra.writes ?? [] }, includeText: extra.includeText ?? false,
});

test('the projection returns the declared reads in declared order with path, lines and why untouched', async (t) => {
  const repo = await createRepo(t);
  const reads = [
    { path: 'SOT/09-use-cases.md', lines: [30, 31], why: 'second window listed first' },
    { path: 'SOT/02-rules.md', lines: null, why: null },
    { path: 'SOT/09-use-cases.md', lines: [1, 2], why: 'first window listed last' },
    { path: 'SOT/09-use-cases.md', lines: [30, 31], why: 'a repeated window is still a declared entry' },
  ];
  const windows = await project(repo, reads);
  assert.deepEqual(windows.map(({ index }) => index), [0, 1, 2, 3]);
  assert.deepEqual(windows.map(({ path, lines, why }) => ({ path, lines, why })), reads);
  assert.deepEqual(windows.map(({ kind }) => kind), ['window', 'file', 'window', 'window']);
  assert.deepEqual(windows.map(({ status }) => status), ['ok', 'ok', 'ok', 'ok']);
  assert.deepEqual(windows.map(({ line_count: count }) => count), [50, 10, 50, 50]);
  assert.equal(windows.every(({ status }) => READ_WINDOW_STATUSES.includes(status)), true);
});

test('no file body leaves the projection unless a caller asks for it, and then it is transient text for valid windows only', async (t) => {
  const repo = await createRepo(t);
  const reads = [
    { path: 'SOT/09-use-cases.md', lines: [28, 30], why: null },
    { path: 'SOT/09-use-cases.md', lines: [49, 60], why: 'past the end' },
  ];
  const plain = await project(repo, reads);
  assert.equal(JSON.stringify(plain).includes('use-case line'), false, 'no fact body in the default projection');
  assert.equal(plain.every((entry) => !Object.hasOwn(entry, 'text')), true);

  const withText = await project(repo, reads, { includeText: true });
  assert.equal(withText[0].text, 'use-case line 28\nuse-case line 29\nuse-case line 30');
  assert.equal(Object.hasOwn(withText[1], 'text'), false, 'an unresolvable window has no text');
  assert.equal(withText[1].status, 'out_of_range');
});

test('windows are judged like the snapshot engine: last line must exist, CRLF counts once, a trailing newline adds no line', async (t) => {
  const repo = await createRepo(t, { files: { 'docs/crlf.md': 'one\r\ntwo\r\nthree\r\n', 'docs/no-newline.md': 'a\nb\nc', 'docs/empty.md': '' } });
  const [crlf, tail, edge, empty] = await project(repo, [
    { path: 'docs/crlf.md', lines: [1, 3], why: null },
    { path: 'docs/no-newline.md', lines: [3, 3], why: null },
    { path: 'docs/no-newline.md', lines: [3, 4], why: null },
    { path: 'docs/empty.md', lines: [1, 1], why: null },
  ], { includeText: true });
  assert.deepEqual([crlf.status, crlf.line_count, crlf.text], ['ok', 3, 'one\ntwo\nthree']);
  assert.deepEqual([tail.status, tail.line_count, tail.text], ['ok', 3, 'c']);
  assert.equal(edge.status, 'out_of_range');
  assert.deepEqual([empty.status, empty.line_count], ['out_of_range', 0]);
});

test('every unresolved state has a stable status: missing, not_file, not_text, case_mismatch, unsafe, own_write', async (t) => {
  const repo = await createRepo(t, { files: { 'bin/data.bin': Buffer.from([0, 1, 2, 3]), 'docs/note.md': 'x\n' } });
  const outside = await createRepo(t, { files: { 'secret.txt': 'outside\n' } });
  let linked = true;
  try {
    await symlink(outside.root, repo.path('escape'), 'dir');
  } catch {
    linked = false;
  }
  const reads = [
    { path: 'SOT/99-missing.md', lines: [1, 2], why: null },
    { path: 'SOT/99-missing.md', lines: null, why: null },
    { path: 'SOT', lines: [1, 2], why: null },
    { path: 'bin/data.bin', lines: [1, 1], why: null },
    { path: 'sot/09-use-cases.md', lines: [1, 2], why: null },
    { path: 'app/pages/admin.vue', lines: null, why: 'will be created by this Road' },
    { path: 'docs', lines: null, why: 'a directory read is fine' },
    { path: 'app/gen/*.js', lines: null, why: 'glob read' },
    ...(linked ? [{ path: 'escape/secret.txt', lines: [1, 1], why: null }] : []),
  ];
  const windows = await project(repo, reads, { writes: [{ path: 'app/pages/admin.vue', class: 'file', action: 'create' }] });
  const statuses = windows.map(({ status }) => status);
  assert.deepEqual(statuses.slice(0, 8), ['missing', 'missing', 'not_file', 'not_text', 'case_mismatch', 'own_write', 'ok', 'ok']);
  assert.deepEqual(windows.slice(0, 8).map(({ kind }) => kind), ['window', 'file', 'window', 'window', 'window', 'file', 'dir', 'glob']);
  if (linked) assert.equal(statuses[8], 'unsafe');
});

test('the projection agrees with the snapshot engine on exactly which reads are unresolved', async (t) => {
  const repo = await createRepo(t, { files: { 'bin/data.bin': Buffer.from([0, 1]) } });
  const reads = [
    { path: 'SOT/09-use-cases.md', lines: [28, 41], why: null },
    { path: 'SOT/09-use-cases.md', lines: [28, 51], why: null },
    { path: 'SOT/99-missing.md', lines: [1, 2], why: null },
    { path: 'SOT', lines: [1, 2], why: null },
    { path: 'bin/data.bin', lines: [1, 1], why: null },
    { path: 'sot/09-use-cases.md', lines: [1, 2], why: null },
    { path: 'src/own.js', lines: null, why: null },
  ];
  await seedRoad(repo, roadInput({ id: 'R-agree', plan: null, task: null, reads, writes: [] }));
  const windows = await project(repo, reads);
  const mine = Object.fromEntries(windows.filter(({ status }) => !['ok', 'own_write'].includes(status)).map(({ path, lines, status }) => [
    status === 'unsafe' || lines === null ? path : `${path}#L${lines[0]}-${lines[1]}`, status,
  ]));
  const engine = await computeSnapshot({ ...repo.options, projections: ['road-reads'], target: { road: 'R-agree' } });
  assert.deepEqual(Object.fromEntries(engine.unresolved.map(({ key, value }) => [key, value])), mine);
  assert.equal(Object.keys(mine).length, 5);
});

test('the projection reads nothing but the declared files and never writes', async (t) => {
  const repo = await createRepo(t);
  const before = await repo.digest();
  await project(repo, [{ path: 'SOT/09-use-cases.md', lines: [1, 3], why: null }], { includeText: true });
  assert.equal(await repo.digest(), before);
});

test('arguments are checked: a Road with a malformed reads list is a programming error', async (t) => {
  const repo = await createRepo(t);
  await assert.rejects(() => projectReadWindows({ ...repo.options, road: { reads: 'x', writes: [] } }), TypeError);
  await assert.rejects(() => projectReadWindows({ ...repo.options, road: null }), TypeError);
});
