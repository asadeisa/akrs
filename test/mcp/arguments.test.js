// P2-W15 F19: server-side argument validation and coercion. Arguments map to exactly the manifest flags and positionals of the chosen
// action; the CLI equivalent (argv) is part of the answer so every MCP call has a runnable CLI twin.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { projectTools } from '../../lib/mcp/project.js';
import { resolveArguments } from '../../lib/mcp/arguments.js';

const projection = projectTools(commandManifest);
const resolve = (tool, args) => resolveArguments(projection, tool, args);

test('an action maps flat arguments to the flags and positionals of its command, with the CLI twin', () => {
  const done = resolve('akrs_work', { action: 'done', road: 'R-1', executor: 'flash', result: 'ready', reach: ['open /a', 'click b'], expect: 'a table' });
  assert.equal(done.ok, true, done.reason);
  assert.equal(done.command, 'done');
  assert.deepEqual(done.input.positionals, { road: 'R-1' });
  assert.deepEqual(done.input.flags, { '--executor': 'flash', '--result': 'ready', '--reach': ['open /a', 'click b'], '--expect': 'a table' });
  // positionals first, then flags in manifest order
  assert.deepEqual(done.argv, ['done', 'R-1', '--result', 'ready', '--reach', 'open /a', '--reach', 'click b', '--expect', 'a table', '--executor', 'flash']);
  const fit = resolve('akrs_road', { action: 'fit', input_path: 'akrs/drafts/r.json' });
  assert.deepEqual([fit.command, fit.input.flags, fit.argv], ['road-fit', { '--input': 'akrs/drafts/r.json' }, ['road', 'fit', '--input', 'akrs/drafts/r.json']]);
  const page = resolve('akrs_page', { action: 'read', url: 'http://127.0.0.1:1/', text: true, timeout_ms: 500 });
  assert.deepEqual(page.input.flags, { '--text': true, '--timeout-ms': 500 });
});

test('positional aliases: explain code is id, akrs_write positionals are id, scope approve takes request or road', () => {
  assert.deepEqual(resolve('akrs_status', { action: 'explain', id: 'AKRS-C001' }).input.positionals, { code: 'AKRS-C001' });
  assert.deepEqual(resolve('akrs_write', { action: 'plan_finish', id: 'P6' }).input.positionals, { plan: 'P6' });
  assert.deepEqual(resolve('akrs_write', { action: 'lease_release', id: 'R-1' }).input.positionals, { road: 'R-1' });
  assert.deepEqual(resolve('akrs_scope', { action: 'approve', request: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }).input.positionals, { target: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
  assert.deepEqual(resolve('akrs_scope', { action: 'approve', road: 'R-1' }).input.positionals, { target: 'R-1' });
  assert.deepEqual(resolve('akrs_scope', { action: 'approve', request: 'Q', road: 'R-1' }).input.positionals, { target: 'Q' }, 'the first alias given wins');
  assert.deepEqual(resolve('akrs_scope', { action: 'list', road: 'R-1' }).input.positionals, { road: 'R-1' });
});

test('coercion: stringified arrays, "true"/"false", numeric strings, a leading @ on paths, null as absent', () => {
  const coerced = resolve('akrs_work', { action: 'done', road: 'R-1', reach: '["open /a","click b"]', pre_existing: 'src/x.js', deviations: null });
  assert.deepEqual(coerced.input.flags, { '--reach': ['open /a', 'click b'], '--pre-existing': ['src/x.js'] });
  assert.deepEqual(resolve('akrs_work', { action: 'work', takeover: 'true' }).input.flags, { '--takeover': true });
  assert.deepEqual(resolve('akrs_work', { action: 'work', takeover: 'false' }).input.flags, {}, 'a false switch is simply not given');
  assert.deepEqual(resolve('akrs_page', { action: 'read', url: 'http://h.example/', timeout_ms: '1500' }).input.flags, { '--timeout-ms': 1500 });
  assert.deepEqual(resolve('akrs_page', { action: 'read', url: 'http://h.example/', timeout_ms: '-3' }).input.flags, { '--timeout-ms': -3 });
  assert.deepEqual(resolve('akrs_write', { action: 'road_new', input_path: '@akrs/drafts/r.json' }).input.flags, { '--input': 'akrs/drafts/r.json' });
  assert.deepEqual(resolve('akrs_work', { action: 'done', road: 'R-1', handoff: '@akrs/drafts/h.json' }).input.flags, { '--handoff': 'akrs/drafts/h.json' });
  assert.deepEqual(resolve('akrs_work', { action: 'done', road: 'R-1', result: '@not-a-path' }).input.flags, { '--result': '@not-a-path' }, 'only paths lose the @');
});

const rejected = (tool, args, pattern) => {
  const result = resolve(tool, args);
  assert.equal(result.ok, false, JSON.stringify(args));
  assert.match(result.reason, pattern, JSON.stringify(args));
  return result;
};

test('invalid arguments are rejected with a reason that names the argument and what is accepted', () => {
  rejected('akrs_work', {}, /action/);
  rejected('akrs_work', { action: 'finish' }, /action.*work, done, yield/);
  rejected('akrs_work', { action: 'done' }, /road/);
  rejected('akrs_work', { action: 'yield', road: 'R-1' }, /reason/);
  rejected('akrs_work', { action: 'work', bogus: 1 }, /bogus/);
  rejected('akrs_work', { action: 'work', reason: 'x' }, /reason.*work/);
  rejected('akrs_work', { action: 'work', takeover: 'yes' }, /takeover.*boolean/);
  rejected('akrs_page', { action: 'read', url: 'http://h.example/', timeout_ms: '1.5' }, /timeout_ms.*integer/);
  rejected('akrs_page', { action: 'read', url: 'http://h.example/', timeout_ms: 2 ** 60 }, /timeout_ms.*integer/);
  rejected('akrs_work', { action: 'done', road: 7 }, /road.*string/);
  rejected('akrs_work', { action: 'done', road: 'R-1', reach: '["a", 1]' }, /reach/);
  rejected('akrs_work', { action: 'done', road: 'R-1', reach: [{ step: 'a' }] }, /reach/);
  rejected('akrs_status', { action: 'status', id: 'x' }, /id.*status/);
  rejected('akrs_work', 'done', /object/);
  rejected('akrs_work', ['done'], /object/);
});
