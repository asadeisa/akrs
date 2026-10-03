import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRepo } from '../road/support.js';
import { GENERATOR, parseTaskMarker, readTask, renderTaskScaffold, taskPath } from '../../lib/store/roads/index.js';

export const taskInput = (overrides = {}) => ({
  schema: 'akrs.task/v1',
  id: 'T-P6-1',
  plan: 'P6',
  road: 'R-P6-1',
  objective: 'Give the admin a table that lists every booking with its paid state.',
  constraints: 'No backend route change.',
  approach: 'Build the page first, then wire the route.',
  notes: null,
  ...overrides,
});

const ROAD_FILE = 'akrs/roads/P6/R-P6-1.json';
const headings = (text) => text.split('\n').filter((line) => line.startsWith('## ')).map((line) => line.slice(3));

test('the scaffold starts with the identity marker and carries the four narrative headings in order', () => {
  const text = renderTaskScaffold(taskInput(), { roadPath: ROAD_FILE });
  const [first] = text.split('\n');
  assert.match(first, /^<!-- akrs:task \{.*\} -->$/);
  assert.deepEqual(JSON.parse(first.slice('<!-- akrs:task '.length, -' -->'.length)), {
    schema: 'akrs.task/v1', id: 'T-P6-1', plan: 'P6', road: 'R-P6-1', generator: GENERATOR,
  });
  assert.equal(text.split('\n')[1], '# Task T-P6-1');
  assert.deepEqual(headings(text), ['Objective', 'Constraints', 'Approach', 'Notes']);
  assert.equal(text.endsWith('\n'), true);
  assert.equal(text.endsWith('\n\n'), false);
  assert.equal(text.includes('\r'), false);
});

test('submitted prose appears verbatim under its heading and nothing else is invented', () => {
  const text = renderTaskScaffold(taskInput({ notes: 'Mind the empty state.' }), { roadPath: ROAD_FILE });
  const section = (name) => text.split(`## ${name}\n`)[1].split('\n## ')[0].trim();
  assert.equal(section('Objective'), 'Give the admin a table that lists every booking with its paid state.');
  assert.equal(section('Constraints'), 'No backend route change.');
  assert.match(section('Approach'), /^Build the page first, then wire the route\./);
  assert.equal(section('Notes'), 'Mind the empty state.');
  const bare = renderTaskScaffold(taskInput({ constraints: null, approach: null, notes: null }), { roadPath: ROAD_FILE });
  for (const name of ['Constraints', 'Notes']) assert.equal(bare.split(`## ${name}\n`)[1].split('\n## ')[0].trim(), '_Not provided._');
  assert.match(bare.split('## Approach\n')[1].split('\n## ')[0], /^\n_Not provided\._/);
});

test('the scaffold points at the Road and its steps instead of restating anything executable', () => {
  const text = renderTaskScaffold(taskInput(), { roadPath: ROAD_FILE });
  assert.equal(text.includes(`\`${ROAD_FILE}\``), true);
  assert.match(text, /`steps` in `akrs\/roads\/P6\/R-P6-1\.json`/);
  for (const owner of ['reads', 'writes', 'forbidden', 'checks', 'acceptance', 'boundaries']) {
    assert.equal(text.includes(`\`${owner}\``), true, `${owner} is named as a Road-owned field`);
  }
  assert.equal(/\bwrites:|\bacceptance:|"writes"|"acceptance"/.test(text), false, 'no executable data shape is written');
});

test('CR and CRLF in prose become LF; the marker is the only structured line', () => {
  const text = renderTaskScaffold(taskInput({ objective: 'one\r\ntwo\rthree' }), { roadPath: ROAD_FILE });
  assert.equal(text.includes('\r'), false);
  assert.equal(text.includes('one\ntwo\nthree'), true);
});

test('arguments are checked: a Task document and a Road path are required', () => {
  assert.throws(() => renderTaskScaffold(null, { roadPath: ROAD_FILE }), TypeError);
  assert.throws(() => renderTaskScaffold(taskInput(), {}), TypeError);
  assert.throws(() => renderTaskScaffold(taskInput({ id: '../x' }), { roadPath: ROAD_FILE }), TypeError);
  assert.throws(() => renderTaskScaffold(taskInput(), { roadPath: '../x.json' }), TypeError);
});

test('parseTaskMarker reads the first line only, and only the closed identity shape', () => {
  const text = renderTaskScaffold(taskInput(), { roadPath: ROAD_FILE });
  const expected = { schema: 'akrs.task/v1', id: 'T-P6-1', plan: 'P6', road: 'R-P6-1', generator: GENERATOR };
  assert.deepEqual(parseTaskMarker(text), expected);
  assert.deepEqual(parseTaskMarker(text.replace('Mind', 'x') + 'trailing prose\n'), expected);
  assert.equal(parseTaskMarker('# no marker\n'), null);
  assert.equal(parseTaskMarker(''), null);
  const forged = `# prose first\n${text}`;
  assert.equal(parseTaskMarker(forged), null, 'a marker that is not on the first line does not count');
  const noPlan = renderTaskScaffold(taskInput({ plan: null }), { roadPath: ROAD_FILE });
  assert.equal(parseTaskMarker(noPlan).plan, null);
  const [first, ...rest] = text.split('\n');
  const tweak = (change) => [first.replace('"generator"', change), ...rest].join('\n');
  assert.equal(parseTaskMarker(tweak('"extra":1,"generator"')), null, 'unknown key');
  assert.equal(parseTaskMarker(first.replace('akrs.task/v1', 'akrs.task/v2')), null, 'wrong schema');
  assert.equal(parseTaskMarker(first.replace('"T-P6-1"', '"bad id"')), null, 'invalid ID');
  assert.equal(parseTaskMarker(first.replace('{"schema"', '{"schema":"x","schema"')), null, 'duplicate key');
  assert.equal(parseTaskMarker('<!-- akrs:task {not json} -->\n'), null);
});

test('readTask returns the identity only: prose is never parsed, a damaged marker is unverified', async (t) => {
  const repo = await createRepo(t);
  const text = renderTaskScaffold(taskInput(), { roadPath: ROAD_FILE });
  await repo.write('akrs/tasks/T-P6-1.md', text);
  const found = await readTask({ ...repo.options, id: 'T-P6-1' });
  assert.deepEqual(found, { id: 'T-P6-1', plan: 'P6', road: 'R-P6-1', path: 'akrs/tasks/T-P6-1.md', meta_state: 'declared' });

  const prose = `${text}\n## Extra\n\nacceptance: everything\nwrites: /etc/passwd\nroad: R-other\nsteps: rm -rf\n`;
  await repo.write('akrs/tasks/T-P6-1.md', prose);
  assert.deepEqual(await readTask({ ...repo.options, id: 'T-P6-1' }), found, 'extra prose changes nothing');

  await repo.write('akrs/tasks/T-P6-1.md', '# Task T-P6-1\n\nroad: R-other\nacceptance: everything\n');
  const unverified = await readTask({ ...repo.options, id: 'T-P6-1' });
  assert.equal(unverified.meta_state, 'unverified');
  assert.equal(unverified.road, null, 'identity is never recovered from prose');
  assert.equal(unverified.plan, null);

  await repo.write('akrs/tasks/T-P6-2.md', text);
  const mismatched = await readTask({ ...repo.options, id: 'T-P6-2' });
  assert.equal(mismatched.meta_state, 'unverified', 'the marker id must equal the file name');
  assert.equal(await readTask({ ...repo.options, id: 'T-none' }), null);
  assert.equal(taskPath('T-P6-1'), 'tasks/T-P6-1.md');
});
