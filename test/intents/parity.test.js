// P2-W12 parity: the primitive chain (next -> road-details -> verify -> audit -> test handoff -> road finish, with the explicit snapshot the
// primitives need) and the intent loop (work -> done, no snapshot, no hash) give the SAME final canonical state on the same fixture. This is
// the proof that an intent adds no second code path: only the bookkeeping moves from the agent to the CLI.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { transition } from '../road-lifecycle/support.js';
import { ROAD, closures, done, edit, runCommand, statusOf, work, workWorld } from './support.js';
import { readHandoffs } from '../../lib/store/verification/index.js';

async function files(directory, prefix = '') {
  const found = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => (left.name < right.name ? -1 : 1))) {
    if (['.git', '.ops', '.cache'].includes(entry.name)) continue;
    if (entry.isDirectory()) found.push(...await files(join(directory, entry.name), `${prefix}${entry.name}/`));
    else found.push(`${prefix}${entry.name}`);
  }
  return found;
}

// Generated identity (record IDs, timestamps, hashes of records that contain them) is the only thing allowed to differ between two runs.
const normalize = (text) => text
  .replace(/01ARZ3NDEKTSV4RRFFQ6\d{6}/g, '<id>')
  .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<ts>')
  .replace(/"hash":"sha256:[0-9a-f]{64}"/g, '"hash":"<hash>"');

async function canonicalState(repo) {
  const state = {};
  for (const path of await files(repo.root)) {
    if (path.startsWith('src/') || path.startsWith('SOT/') || path.startsWith('app/')) continue;
    state[path] = normalize(await readFile(repo.path(path), 'utf8'));
  }
  return state;
}

test('work -> done and the primitive chain end in the same canonical workflow state', async (t) => {
  const { repo: primitive } = await workWorld(t);
  const { repo: composed } = await workWorld(t);

  // the primitive chain: the agent (here the test) carries the snapshot
  assert.equal((await runCommand(primitive, ['next', '--json'], { providers: primitive.providers })).exitCode, 0);
  const details = await runCommand(primitive, ['road-details', ROAD, '--role', 'worker', '--json'], { providers: primitive.providers });
  assert.equal(JSON.parse(details.stdout).data.road.id, ROAD);
  await edit(primitive);
  assert.equal(JSON.parse((await runCommand(primitive, ['verify', '--road', ROAD, '--json'], { providers: primitive.providers })).stdout).status, 'ok');
  assert.equal(JSON.parse((await runCommand(primitive, ['audit', '--git', '--road', ROAD, '--json'], { providers: primitive.providers })).stdout).data.audit.status, 'clean');
  const handoff = await runCommand(primitive, ['test', 'handoff', 'P6', '--road', ROAD, '--result', 'the admin page is ready', '--reach', 'open /admin', '--expect', 'a table of users', '--json'], { providers: primitive.providers });
  assert.equal(JSON.parse(handoff.stdout).status, 'ok', handoff.stdout);
  const finish = await transition(primitive, 'finish');
  assert.equal(finish.packet.status, 'ok', finish.stdout);

  // the intent loop: no snapshot, no hash, no request ID
  assert.equal((await work(composed)).packet.status, 'ok');
  await edit(composed);
  const finished = await done(composed);
  assert.equal(finished.packet.status, 'ok', finished.stdout);

  assert.equal(await statusOf(primitive), 'DONE');
  assert.equal(await statusOf(composed), 'DONE');
  assert.equal(await primitive.read('akrs/roads/P6/R-P6-1.json'), await composed.read('akrs/roads/P6/R-P6-1.json'), 'the Road file is byte-identical');
  assert.deepEqual(await canonicalState(composed), await canonicalState(primitive));

  const strip = ({ id, hash, ts, ...rest }) => rest;
  assert.deepEqual((await closures(composed)).map(strip), (await closures(primitive)).map(strip));
  const batons = async (repo) => (await readHandoffs({ ...repo.options, key: 'P6' })).records.map(({ value }) => strip(value));
  assert.deepEqual(await batons(composed), await batons(primitive), 'the baton is the same record, snapshot included');
});
