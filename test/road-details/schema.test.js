// P2-W01 freeze: the closed road-details data schema. Valid shapes pass; every kind of deviation is refused with a pointer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROAD_DETAILS_SHAPES, validateRoadDetails } from '../../lib/schemas/road-details.js';
import { details, packetWorld } from './support.js';

async function shapes(t) {
  const { repo } = await packetWorld(t);
  const worker = (await details(repo, 'R-P6-1')).packet.data;
  const leader = (await details(repo, 'R-P6-1', ['--role', 'leader'])).packet.data;
  const refused = (await details(repo, 'R-P6-1', ['--max-tokens', '5'])).packet.data;
  const blocked = { kind: 'road_details_blocked', packet_version: 'akrs.road-details/v2', role: 'worker', road: 'R-P6-1', blockers: [{ reason: 'road_ambiguous', subject: 'a.json, b.json' }] };
  return { worker, leader, refused, blocked };
}

test('the four shapes are valid and their key sets are exactly the frozen lists', async (t) => {
  const { worker, leader, refused, blocked } = await shapes(t);
  for (const [name, value] of Object.entries({ worker, leader, refused, blocked })) {
    assert.equal(validateRoadDetails(value).ok, true, `${name}: ${JSON.stringify(validateRoadDetails(value).issues)}`);
    assert.deepEqual(Object.keys(value).sort(), [...ROAD_DETAILS_SHAPES[name]].sort(), name);
  }
});

test('unknown keys, missing keys and wrong types are refused with a pointer, in every shape', async (t) => {
  const all = await shapes(t);
  for (const [name, value] of Object.entries(all)) {
    const unknown = validateRoadDetails({ ...value, surprise: 1 });
    assert.deepEqual(unknown.issues.map(({ path, code }) => [path, code]), [['$.surprise', 'unknown_key']], name);
    const { kind: _kind, ...withoutKind } = value;
    assert.equal(validateRoadDetails(withoutKind).ok, false, `${name}: kind is required`);
    assert.equal(validateRoadDetails({ ...value, packet_version: 'akrs.road-details/v1' }).ok, false, `${name}: the version is frozen`);
    assert.equal(validateRoadDetails({ ...value, role: 'boss' }).ok, false, `${name}: role is closed`);
  }
  assert.equal(validateRoadDetails(null).ok, false);
  assert.equal(validateRoadDetails([]).ok, false);
});

const BAD = [
  ['read status outside the vocabulary', (d) => { d.reads[0].status = 'vanished'; }, '$.reads[0].status'],
  ['read entry with an extra key', (d) => { d.reads[0].hash = 'sha256:x'; }, '$.reads[0].hash'],
  ['a window that is not [start, end]', (d) => { d.reads[0].window = { lines: [1] }; }, '$.reads[0].window.lines'],
  ['write class outside the vocabulary', (d) => { d.writes[0].class = 'tree'; }, '$.writes[0].class'],
  ['dependency status outside the vocabulary', (d) => { d.deps[0].status = 'LOST'; }, '$.deps[0].status'],
  ['delivery reads outside the vocabulary', (d) => { d.delivery.reads = 'streamed'; }, '$.delivery.reads'],
  ['lease state outside the vocabulary', (d) => { d.lease.state = 'maybe'; }, '$.lease.state'],
  ['a negative budget number', (d) => { d.budget.read_bytes = -1; }, '$.budget.read_bytes'],
  ['a zero max_tokens', (d) => { d.budget.max_tokens = 0; }, '$.budget.max_tokens'],
  ['coverage with a missing key', (d) => { delete d.coverage.unresolved; }, '$.coverage.unresolved'],
  ['relations that are not lists', (d) => { d.collisions = null; }, '$.collisions'],
  ['a check without argv', (d) => { d.checks[0].argv = []; }, '$.checks[0].argv'],
];
for (const [label, mutate, pointer] of BAD) {
  test(`refused: ${label}`, async (t) => {
    const { worker } = await shapes(t);
    const copy = structuredClone(worker);
    mutate(copy);
    const verdict = validateRoadDetails(copy);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.issues.some(({ path }) => path === pointer || path.startsWith(`${pointer}.`) || path.startsWith(`${pointer}[`)), JSON.stringify(verdict.issues));
  });
}

test('Leader-only keys are refused on a Worker packet and required on a Leader packet', async (t) => {
  const { worker, leader } = await shapes(t);
  assert.equal(validateRoadDetails({ ...worker, readiness: { ready: true, blockers: [] } }).ok, false);
  const { readiness: _readiness, ...partial } = leader;
  assert.deepEqual(validateRoadDetails(partial).issues.map(({ path }) => path), ['$.readiness']);
});
