// P2-W05: `road check` reports readiness and the legal transitions of a Road without any mutation. Dependency readiness is
// not graph validity, and every readiness blocker is a named finding.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertFindingsMatchCatalog } from '../road/support.js';
import { details, fileWrite, seedRoad } from '../road-details/support.js';
import { everything } from '../change/support.js';
import { codesOf, lifecycle, lifecycleWorld, reasonsOf, runCommand, snapshotOf } from './support.js';

const check = (repo, id = 'R-P6-1') => lifecycle(repo, 'check', [id]);

test('a ready QUEUED Road: ok, legal to activate only, and the next command carries the current snapshot', async (t) => {
  const { repo } = await lifecycleWorld(t, { status: 'QUEUED' });
  const before = await everything(repo);
  const { exitCode, packet } = await check(repo);
  assert.equal(exitCode, 0);
  assert.equal(packet.status, 'ok');
  assert.equal(packet.data.kind, 'road_check');
  assert.deepEqual(packet.data.road, { id: 'R-P6-1', plan: 'P6', status: 'QUEUED', contract: 'declared', executor_class: 'weak', path: packet.data.road.path });
  assert.deepEqual(packet.data.readiness, { ready: true, blockers: [] });
  assert.deepEqual(packet.data.transitions.map(({ command, legal }) => [command, legal]), [['road-activate', true], ['road-finish', false], ['road-reopen', false]]);
  assert.deepEqual(packet.next_commands[0], { command: 'road-activate', args: ['R-P6-1', '--if-snapshot', await snapshotOf(repo, 'road-activate'), '--root', repo.root] });
  assert.equal(await everything(repo), before, 'a check writes nothing, not even a journal or a lease');
  assertFindingsMatchCatalog(packet);
});

test('a dependency that is not DONE blocks activation although the graph is valid', async (t) => {
  const { repo } = await lifecycleWorld(t, { status: 'QUEUED' });
  await seedRoad(repo, { id: 'R-P5-6', plan: null, executor_class: 'medium' }, { status: 'QUEUED' });
  const { packet } = await check(repo);
  assert.equal(packet.status, 'blocked');
  assert.deepEqual(packet.data.readiness.blockers, [{ reason: 'dependency_not_done', subject: 'R-P5-6' }]);
  assert.deepEqual(codesOf(packet), ['AKRS-R025']);
  assert.deepEqual(reasonsOf(packet), ['dependency_not_done']);
  assert.equal(packet.data.transitions[0].legal, false);
  assert.deepEqual(packet.data.transitions[0].blockers, [{ reason: 'dependency_not_done', subject: 'R-P5-6' }]);
  assertFindingsMatchCatalog(packet);
  const validated = JSON.parse((await runCommand(repo, ['validate', '--json'], { providers: repo.providers })).stdout);
  assert.equal(validated.findings.some(({ code }) => ['AKRS-R005', 'AKRS-R006'].includes(code)), false, 'the graph itself is valid');
});

test('an unclassified Road and a Road that needs splitting are not ready, and the same readiness is in the Leader packet', async (t) => {
  const { repo } = await lifecycleWorld(t, { status: 'QUEUED', overrides: { executor_class: null } });
  const unclassified = (await check(repo)).packet;
  assert.deepEqual(unclassified.data.readiness.blockers.map(({ reason }) => reason), ['executor_class_missing']);
  assert.equal(unclassified.status, 'blocked');
  const leader = (await details(repo, 'R-P6-1', ['--role', 'leader'])).packet.data;
  assert.deepEqual(leader.readiness, unclassified.data.readiness, 'check and the Leader packet share one readiness');

  const crowded = await lifecycleWorld(t, { status: 'QUEUED', overrides: { writes: ['a', 'b', 'c', 'd', 'e'].map((name) => fileWrite(`src/${name}.js`)) } });
  const split = (await check(crowded.repo)).packet;
  assert.equal(split.data.needs_split, true);
  assert.ok(split.data.readiness.blockers.some(({ reason }) => reason === 'class_fit'));
  assert.equal(split.data.class_fit.verdict, 'split_required');
  assertFindingsMatchCatalog(split);
});

test('an ACTIVE Road is ok to check: only finish and reopen are legal', async (t) => {
  const { repo } = await lifecycleWorld(t, { status: 'ACTIVE' });
  const { packet } = await check(repo);
  assert.equal(packet.status, 'ok');
  assert.deepEqual(packet.data.transitions.map(({ command, legal }) => [command, legal]), [['road-activate', false], ['road-finish', true], ['road-reopen', true]]);
  assert.deepEqual(packet.data.transitions[1].requires, ['checks_pass', 'audit_clean', 'no_blocking_scope_request']);
});

test('a missing Road is a usage error', async (t) => {
  const { repo } = await lifecycleWorld(t);
  const { exitCode, packet, stderr } = await check(repo, 'R-NOPE');
  assert.equal(exitCode, 2, stderr);
  assert.equal(packet.data.kind, 'usage');
  assert.match(packet.findings[0].message, /no Road R-NOPE/);
});
