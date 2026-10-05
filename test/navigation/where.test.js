// P2-W09: `where <path>` answers with exactly four deterministic relations and labels them provisional.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateWhere } from '../../lib/schemas/navigation.js';
import { matchOf } from '../../lib/store/navigation/paths.js';
import { treeDigest } from '../road/support.js';
import { request } from '../change/support.js';
import { fileWrite, seedWithTask } from '../road-details/support.js';
import { closableWorld, finish, navWorld, query } from './support.js';

const where = (repo, path) => query(repo, ['where', path]);
const ok = (out) => {
  assert.equal(out.exitCode, 0, out.text);
  assert.equal(validateWhere(out.packet.data).ok, true, JSON.stringify(validateWhere(out.packet.data).issues));
  return out.packet;
};

test('where has exactly the four frozen relations, labelled provisional, in a fixed order', async (t) => {
  const repo = await navWorld(t);
  const digest = await treeDigest(repo);
  const packet = ok(await where(repo, 'src/own.js'));
  assert.deepEqual([packet.data.kind, packet.data.packet_version, packet.data.path, packet.data.provisional], ['where', 'akrs.where/v1', 'src/own.js', true]);
  assert.deepEqual(Object.keys(packet.data.relations), ['closures', 'readers', 'scope_requests', 'writers']);
  assert.deepEqual(await treeDigest(repo), digest);
});

test('writers are the Roads that declare a write over the path, exact or by overlap, never by a guess', async (t) => {
  const repo = await navWorld(t);
  await seedWithTask(repo, { id: 'R-P6-4', task: 'T-P6-4', deps: ['R-P5-6'], executor_class: 'medium', writes: [{ path: 'src/**', class: 'glob', action: 'modify' }] }, { status: 'QUEUED' });
  const writers = ok(await where(repo, 'src/own.js')).data.relations.writers;
  assert.deepEqual(writers.map(({ road, match }) => [road, match]), [['R-P6-1', 'exact'], ['R-P6-4', 'overlap']]);
  const none = ok(await where(repo, 'docs/readme.md')).data.relations.writers;
  assert.deepEqual(none, []);
});

test('readers are the Roads whose declared reads cover the path', async (t) => {
  const repo = await navWorld(t);
  const readers = ok(await where(repo, 'SOT/09-use-cases.md')).data.relations.readers;
  assert.deepEqual(readers.map(({ road }) => road), ['R-P5-6', 'R-P6-1', 'R-P6-2', 'R-P6-3']);
  assert.deepEqual(readers.find(({ road }) => road === 'R-P6-1').windows, [{ lines: [28, 41], why: 'canonical paid-state rule' }]);
});

test('scope requests that name the path are listed with their state', async (t) => {
  const repo = await navWorld(t);
  const filed = await request(repo, { road: 'R-P6-1', add_reads: [{ path: 'src/extra.js', lines: null, why: 'needed' }], blocking: true });
  assert.equal(filed.outcome, 'committed', JSON.stringify(filed.packet.findings));
  const requests = ok(await where(repo, 'src/extra.js')).data.relations.scope_requests;
  assert.deepEqual(requests.map(({ road, state, blocking }) => [road, state, blocking]), [['R-P6-1', 'pending', true]]);
});

test('closures are the closure records of the Roads and Plan that touch the path', async (t) => {
  const repo = await closableWorld(t);
  await finish(repo);
  const closures = ok(await where(repo, 'SOT/09-use-cases.md')).data.relations.closures;
  assert.deepEqual(closures.map(({ kind, subject, outcome }) => [kind, subject, outcome]), [['plan', 'P6', 'DONE']]);
});

test('an unsafe or malformed path is a usage error and nothing is guessed', async (t) => {
  const repo = await navWorld(t);
  for (const path of ['../outside', '/etc/passwd', '']) assert.equal((await where(repo, path)).exitCode, 2, path);
});

test('a path the glob engine does not support is a usage error, and an undecidable overlap is reported as unknown, never guessed', async (t) => {
  const repo = await navWorld(t);
  assert.equal((await where(repo, 'src/[ab]/x.js')).exitCode, 2);
  assert.equal(matchOf('src/**', 'glob', 'src/[ab]/x.js'), 'unknown');
  assert.equal(matchOf('src/own.js', 'file', 'src/other.js'), null);
  assert.equal(matchOf('src/own.js', 'file', 'src/own.js'), 'exact');
  assert.equal(matchOf('src/**', 'glob', 'src/own.js'), 'overlap');
});
