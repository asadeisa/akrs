import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCOPE_REQUEST_SPEC } from '../../lib/schemas/scope.js';
import { validateRoadDocument } from '../../lib/store/roads/proposal.js';
import { contentHash, decodeJsonl } from '../../lib/store/canonical/index.js';
import { ENVELOPE_GRANT_CAP } from '../../lib/store/scope/policy.js';
import { readScope } from '../../lib/store/scope/index.js';
import {
  assertFindingsMatchCatalog, codesOf, createRepo, everything, fileWrite, readEntry, request, resolve, roadFile, roadInput, roadJson, runCommand,
  seedRoad, snapshotOf, text, update, updateForm,
} from './support.js';

const ID = 'R-P6-1';
const ENVELOPE = { auto_reads: ['src/**', 'app/config/*.ts'], auto_writes: ['src/gen/*.js'] };
const reasons = (packet) => packet.findings.filter(({ code }) => code === 'AKRS-R014').map(({ detail }) => detail.reason);
const seeded = async (t, extra = {}, options = {}) => {
  const repo = await createRepo(t);
  await seedRoad(repo, { id: ID, executor_class: 'medium', ...extra }, options);
  return repo;
};

test('a blocking request writes pending state, blocks the Worker and grants nothing; a non-blocking one lets it continue', async (t) => {
  const repo = await seeded(t);
  const road = await roadFile(repo, ID);
  const result = await request(repo, { road: ID, add_reads: [readEntry('app/config/payment-status.ts')] });
  assert.equal(result.outcome, 'committed');
  assert.equal(result.packet.status, 'warning');
  assert.equal(result.packet.data.worker, 'stop');
  assert.deepEqual(result.packet.changed, ['scope/R-P6-1.jsonl']);
  assert.equal(result.packet.data.request.state, 'pending');
  assert.deepEqual(result.packet.data.envelope, { granted: false, reasons: ['outside_envelope'] }, 'an empty envelope grants nothing');
  assert.equal(await roadFile(repo, ID), road, 'the Road is untouched');
  const scope = await readScope({ ...repo.options, road: ID });
  assert.deepEqual(scope.requests.map(({ state, blocking }) => [state, blocking]), [['pending', true]]);
  assert.equal(scope.requests[0].snapshot, result.packet.snapshot.before, 'the record carries the snapshot the Worker saw');
  assert.equal(decodeJsonl(scope.text, () => SCOPE_REQUEST_SPEC).records[0].state, 'declared');
  const soft = await request(repo, { road: ID, add_writes: [fileWrite('src/new.js')], blocking: false });
  assert.equal(soft.packet.status, 'ok');
  assert.equal(soft.packet.data.worker, 'continue');
  assert.equal((await readScope({ ...repo.options, road: ID })).requests.length, 2);
  assert.equal(await roadFile(repo, ID), road);
});

test('a request that asks for nothing new, names a missing Road or hits an unusable ledger writes nothing', async (t) => {
  const repo = await seeded(t);
  const known = await roadJson(repo, ID);
  const nothing = await request(repo, { road: ID, add_reads: [known.reads[0]] });
  assert.deepEqual(reasons(nothing.packet), ['nothing_to_add']);
  const missing = await request(repo, { road: 'R-NOPE', add_reads: [readEntry('src/own.js')] });
  assert.deepEqual(reasons(missing.packet), ['road_missing']);
  await repo.write('akrs/scope/R-P6-1.jsonl', 'not json\n');
  const before = await everything(repo);
  const broken = await request(repo, { road: ID, add_reads: [readEntry('src/own.js')] });
  assert.deepEqual(reasons(broken.packet), ['ledger_unusable']);
  assertFindingsMatchCatalog(broken.packet);
  assert.deepEqual(await everything(repo), before);
});

test('rejection records a reason and grants nothing; it needs a reason', async (t) => {
  const repo = await seeded(t);
  await request(repo, { road: ID, add_reads: [readEntry('app/config/payment-status.ts')] });
  const road = await roadFile(repo, ID);
  const none = await resolve(repo, 'reject', ID);
  assert.equal(none.packet.data.kind, 'usage');
  const result = await resolve(repo, 'reject', ID, { reason: 'Out of scope for this Road.' });
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(result.packet.changed, ['scope/R-P6-1.jsonl']);
  assert.equal(await roadFile(repo, ID), road);
  const [first] = (await readScope({ ...repo.options, road: ID })).requests;
  assert.equal(first.state, 'rejected');
  assert.deepEqual([first.resolution.granted_by, first.resolution.reason, first.resolution.road_snapshot_after], ['leader', 'Out of scope for this Road.', null]);
  const again = await resolve(repo, 'reject', ID, { reason: 'x' });
  assert.deepEqual(reasons(again.packet), ['no_pending']);
});

test('approval applies the delta through a guarded Road update; it is byte-identical to the manual full update', async (t) => {
  const approved = await seeded(t);
  const manual = await seeded(t);
  const delta = { add_reads: [readEntry('app/config/payment-status.ts')], add_writes: [fileWrite('src/own.js')] };
  await request(approved, { road: ID, ...delta });
  const result = await resolve(approved, 'approve', ID, { reason: 'Agreed.' });
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(result.packet.changed, ['roads/R-P6-1.json', 'scope/R-P6-1.jsonl']);
  assert.notEqual(result.packet.snapshot.before, result.packet.snapshot.after);
  const base = await updateForm(manual, ID);
  const writes = [...base.writes, fileWrite('src/own.js')].sort((a, b) => (a.path < b.path ? -1 : 1));
  const done = await update(manual, ID, { ...base, reads: [...base.reads, delta.add_reads[0]], writes }, { expectedSnapshot: await snapshotOf(manual, 'road-update', ID) });
  assert.equal(done.outcome, 'committed');
  assert.equal(await roadFile(approved, ID), await roadFile(manual, ID));
  const [request1] = (await readScope({ ...approved.options, road: ID })).requests;
  assert.equal(request1.state, 'approved');
  assert.equal(request1.resolution.granted_by, 'leader');
  assert.equal(request1.resolution.road_snapshot_after, contentHash(await roadFile(approved, ID)));
});

test('approve targets: a Road with one pending request, otherwise a request ID; resolved and missing ones are refused', async (t) => {
  const repo = await seeded(t);
  const first = await request(repo, { road: ID, add_reads: [readEntry('src/own.js')] });
  const second = await request(repo, { road: ID, add_reads: [readEntry('SOT/02-rules.md')] });
  const ambiguous = await resolve(repo, 'approve', ID);
  assert.deepEqual(reasons(ambiguous.packet), ['request_ambiguous']);
  const id1 = first.packet.data.request.id;
  const id2 = second.packet.data.request.id;
  assert.equal(ambiguous.packet.findings[0].message.includes(id1) && ambiguous.packet.findings[0].message.includes(id2), true);
  const byId = await resolve(repo, 'approve', id1);
  assert.equal(byId.outcome, 'committed');
  const resolved = await resolve(repo, 'approve', id1);
  assert.deepEqual(reasons(resolved.packet), ['request_resolved']);
  const missing = await resolve(repo, 'approve', '01ARZ3NDEKTSV4RRFFQ69G5FAV');
  assert.deepEqual(reasons(missing.packet), ['request_missing']);
  const single = await resolve(repo, 'approve', ID);
  assert.equal(single.outcome, 'committed', 'one request left, so the Road ID is enough');
});

test('envelope: a request fully inside the envelope is granted at once as a recorded Road update', async (t) => {
  const repo = await seeded(t, { scope_policy: ENVELOPE });
  const result = await request(repo, { road: ID, add_reads: [readEntry('src/own.js')], add_writes: [fileWrite('src/gen/a.js')] });
  assert.equal(result.outcome, 'committed');
  assert.equal(result.packet.status, 'ok');
  assert.deepEqual(result.packet.changed, ['roads/R-P6-1.json', 'scope/R-P6-1.jsonl']);
  assert.deepEqual(result.packet.data.envelope, { granted: true, reasons: [] });
  assert.equal(result.packet.data.resolution.granted_by, 'envelope');
  const stored = await roadJson(repo, ID);
  assert.equal(stored.writes.some(({ path }) => path === 'src/gen/a.js'), true);
  assert.equal(stored.reads.some(({ path }) => path === 'src/own.js'), true);
  const [only] = (await readScope({ ...repo.options, road: ID })).requests;
  assert.equal(only.state, 'approved');
  assert.equal(only.resolution.road_snapshot_after, contentHash(await roadFile(repo, ID)));
});

test('envelope: every rule that fails keeps the request pending, and the reason says which', async (t) => {
  const cases = [
    ['writes outside auto_writes', {}, { add_writes: [fileWrite('src/other/b.js')] }, 'outside_envelope'],
    ['reads outside auto_reads', {}, { add_reads: [readEntry('SOT/02-rules.md')] }, 'outside_envelope'],
    ['a directory write', {}, { add_writes: [{ path: 'src/gen', class: 'dir', action: 'create' }] }, 'outside_envelope'],
    ['under forbidden', { forbidden: ['src/gen/secret.js'] }, { add_writes: [fileWrite('src/gen/secret.js')] }, 'forbidden'],
    ['weak class writes', { executor_class: 'weak' }, { add_writes: [fileWrite('src/gen/a.js')] }, 'weak_class_writes'],
  ];
  for (const [name, roadExtra, delta, reason] of cases) {
    const repo = await seeded(t, { scope_policy: ENVELOPE, ...roadExtra });
    const road = await roadFile(repo, ID);
    const result = await request(repo, { road: ID, ...delta });
    assert.equal(result.packet.data.envelope.granted, false, name);
    assert.equal(result.packet.data.envelope.reasons.includes(reason), true, `${name}: ${result.packet.data.envelope.reasons}`);
    assert.equal(await roadFile(repo, ID), road, name);
  }
  const weak = await seeded(t, { scope_policy: ENVELOPE, executor_class: 'weak' });
  const reads = await request(weak, { road: ID, add_reads: [readEntry('src/own.js')] });
  assert.equal(reads.packet.data.envelope.granted, true, 'weak class auto-grants reads');
});

test('envelope: the grant cap and a collision with another ACTIVE Road keep the request pending', async (t) => {
  const capped = await seeded(t, { scope_policy: ENVELOPE });
  for (let index = 0; index < ENVELOPE_GRANT_CAP; index += 1) {
    const granted = await request(capped, { road: ID, add_writes: [fileWrite(`src/gen/${index}.js`)] });
    assert.equal(granted.packet.data.envelope.granted, true, String(index));
  }
  const over = await request(capped, { road: ID, add_writes: [fileWrite('src/gen/over.js')] });
  assert.deepEqual(over.packet.data.envelope, { granted: false, reasons: ['grant_cap'] });

  const clash = await seeded(t, { scope_policy: ENVELOPE });
  await seedRoad(clash, { id: 'R-OTHER', writes: [fileWrite('src/gen/a.js')] }, { status: 'ACTIVE' });
  const result = await request(clash, { road: ID, add_writes: [fileWrite('src/gen/a.js')] });
  assert.deepEqual(result.packet.data.envelope, { granted: false, reasons: ['refused_by_guard'] });
  assert.equal(result.packet.status, 'warning');
});

test('envelope validation: the Road writer rejects akrs/**, SOT/** and a bare **', () => {
  for (const pattern of ['akrs/**', 'SOT/**', '**', 'akrs/log/*.jsonl']) {
    const verdict = validateRoadDocument(roadInput({ scope_policy: { auto_reads: [], auto_writes: [pattern] } }));
    assert.equal(verdict.ok, false, pattern);
    assert.equal(verdict.findings.some(({ detail }) => detail.issue.includes('invalid_envelope')), true, pattern);
  }
  assert.equal(validateRoadDocument(roadInput({ scope_policy: { auto_reads: ['src/**'], auto_writes: ['src/gen/*.js'] } })).ok, true);
});

test('scope list shows every request with its state through the real adapter (a query: no byte changes)', async (t) => {
  const repo = await seeded(t);
  await request(repo, { road: ID, add_reads: [readEntry('src/own.js')] });
  await request(repo, { road: ID, add_reads: [readEntry('SOT/02-rules.md')], blocking: false });
  const before = await everything(repo);
  const result = await runCommand(repo, ['scope', 'list', '--json']);
  assert.equal(result.exitCode, 0);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.data.pending, 2);
  assert.deepEqual(packet.data.requests.map(({ state, blocking }) => [state, blocking]), [['pending', true], ['pending', false]]);
  assert.deepEqual(packet.changed, []);
  assert.equal(packet.snapshot.before, packet.snapshot.after);
  assert.deepEqual(await everything(repo), before);
  const one = JSON.parse((await runCommand(repo, ['scope', 'list', 'R-OTHER', '--json'])).stdout);
  assert.equal(one.data.requests.length, 0);
  assert.equal(text.length >= 0 && codesOf(packet).length === 0, true);
});

test('a retry of a committed approval with the same request ID replays as a noop (and a different input conflicts) instead of finding nothing pending', async (t) => {
  const repo = await seeded(t);
  await request(repo, { road: ID, add_reads: [readEntry('app/config/payment-status.ts')] });
  const requestId = '01ARZ3NDEKTSV4RRFFQ6007777';
  const first = await resolve(repo, 'approve', ID, { reason: 'Agreed.', requestId });
  assert.equal(first.outcome, 'committed');
  const afterFirst = await everything(repo);
  const again = await resolve(repo, 'approve', ID, { reason: 'Agreed.', requestId });
  assert.equal(again.outcome, 'replayed');
  assert.equal(again.packet.status, 'noop');
  assert.equal(again.packet.request_id, requestId);
  assert.deepEqual(await everything(repo), afterFirst, 'a replay writes nothing');
  const different = await resolve(repo, 'approve', ID, { reason: 'Another reason.', requestId });
  assert.equal(different.outcome, 'conflict');
  assert.deepEqual(await everything(repo), afterFirst);
  const unrelated = await resolve(repo, 'approve', ID, { reason: 'Agreed.' });
  assert.deepEqual(reasons(unrelated.packet), ['no_pending'], 'without a request ID nothing is pending any more');
});
