// P1-W04 / F8 + F17: request-ID journal semantics, in process and deterministic.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validatePacket } from '../../lib/schemas/packet.js';
import { LEASE_CONTRACT_PROJECTION, computeSnapshot } from '../../lib/store/snapshots/index.js';
import {
  buildReplayPacket,
  computeReplayKey,
  computeRequestHash,
  findCommittedAppend,
  readOp,
  resolveFromJournal,
  saltReplayKey,
} from '../../lib/store/journal/index.js';
import { acquireRepositoryLock, readLockOwner } from '../../lib/store/lock/index.js';
import { byteTreeHash } from '../helpers/byte-tree.js';
import {
  NO_TARGET,
  SENTINEL,
  createHarness,
  createIdempotencyWorkflow,
  indexFile,
  journalDirectory,
  listNames,
  opFile,
  readRecords,
  ulid,
  walk,
  workflowSnapshot,
} from './support.js';

const SHA = /^sha256:[0-9a-f]{64}$/;
const KEY = ulid(1);

async function setup(t, extra) {
  const workflow = await createIdempotencyWorkflow(t, extra);
  return { workflow, harness: createHarness(workflow) };
}

test('the first use of a request ID records prepared then committed and indexes the replay key', async (t) => {
  const { workflow, harness } = await setup(t);
  const before = await workflowSnapshot(workflow);
  const order = [];
  const result = await harness.run({ requestId: KEY, onRequestId: (id) => order.push(['id', id]) });

  assert.equal(result.outcome, 'committed');
  assert.equal(result.request_id, KEY);
  assert.equal(result.generated, false);
  assert.equal(result.replayed, null);
  assert.equal(result.packet.status, 'ok');
  assert.equal(result.packet.request_id, KEY);
  assert.equal(validatePacket(result.packet).ok, true);

  const [prepared, committed] = await readRecords(workflow, KEY);
  const request_hash = computeRequestHash({ command: 'memory-add', target: NO_TARGET, input: { name: 'note', body: 'hello' } });
  const replay_key = computeReplayKey({ command: 'memory-add', target: NO_TARGET, input: { name: 'note', body: 'hello' } });
  assert.deepEqual(Object.keys(committed), [
    'id', 'hash', 'ts', 'request_id', 'command', 'target', 'request_hash', 'replay_key', 'state', 'expected_snapshot',
    'before', 'after', 'changed', 'packet_hash', 'packet', 'transaction', 'draft',
  ]);
  assert.equal(prepared.state, 'prepared');
  assert.equal(prepared.before, before);
  assert.equal(prepared.after, null);
  assert.equal(prepared.packet, null);
  assert.equal(prepared.packet_hash, null);
  assert.deepEqual(prepared.changed, []);
  assert.equal(committed.state, 'committed');
  assert.equal(committed.request_id, KEY);
  assert.equal(committed.command, 'memory-add');
  assert.deepEqual(committed.target, NO_TARGET);
  assert.equal(committed.request_hash, request_hash);
  assert.equal(committed.replay_key, replay_key);
  assert.equal(committed.expected_snapshot, null);
  assert.equal(committed.before, before);
  assert.equal(committed.after, result.packet.snapshot.after);
  assert.notEqual(committed.after, before);
  assert.deepEqual(committed.changed, ['memory/note.md']);
  assert.deepEqual(committed.packet, result.packet);
  assert.match(committed.packet_hash, SHA);
  assert.equal(committed.transaction, null);
  assert.equal(committed.draft, null);
  assert.notEqual(prepared.id, committed.id);
  assert.equal(result.record.id, committed.id);

  const index = JSON.parse(await readFile(indexFile(workflow, replay_key), 'utf8'));
  assert.deepEqual(index, { schema: 'akrs.op-index/v1', replay_key, request_id: KEY });
  assert.deepEqual(order, [['id', KEY]]);
});

test('a generated request ID is reported before the first write and carried by the packet', async (t) => {
  const { workflow, harness } = await setup(t);
  let reportedAt = null;
  const result = await harness.run({
    onRequestId: async (id) => {
      reportedAt = { id, journalExisted: (await listNames(journalDirectory(workflow))).length > 0 };
    },
  });
  assert.equal(result.outcome, 'committed');
  assert.equal(result.generated, true);
  assert.equal(reportedAt.id, result.request_id);
  assert.equal(reportedAt.journalExisted, false, 'reported before any journal write');
  assert.equal(result.packet.request_id, result.request_id);
  assert.match(result.request_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('same ID and same request returns the recorded packet as noop and changes no byte', async (t) => {
  const { workflow, harness } = await setup(t);
  const first = await harness.run({ requestId: KEY });
  const treeBefore = await byteTreeHash(workflow.root);
  const snapshotBefore = await workflowSnapshot(workflow);
  const second = await harness.run({ requestId: KEY });

  assert.equal(await byteTreeHash(workflow.root), treeBefore, 'no byte of the repository changed');
  assert.equal(harness.applied.length, 1, 'apply ran once');
  assert.equal(second.outcome, 'replayed');
  assert.equal(second.request_id, KEY);
  assert.deepEqual(second.replayed, { request_id: KEY, committed_at: first.record.ts });
  assert.equal(second.exit_code, null, "pass-through packets leave the exit code to the adapter");
  assert.equal(validatePacket(second.packet).ok, true);

  // the frozen replay-packet rule
  const original = first.packet;
  const packet = second.packet;
  assert.equal(packet.status, 'noop');
  assert.equal(packet.command, original.command);
  assert.equal(packet.request_id, original.request_id);
  assert.deepEqual(packet.data, original.data);
  assert.deepEqual(packet.findings, original.findings);
  assert.deepEqual(packet.next_commands, original.next_commands);
  assert.notEqual(packet.run_id, original.run_id, 'a replay is a new run');
  assert.notEqual(packet.timestamp, original.timestamp);
  assert.deepEqual(packet.snapshot, { before: snapshotBefore, after: snapshotBefore });
  assert.equal(packet.snapshot.after, original.snapshot.after);
  assert.deepEqual(packet.changed, []);
  assert.equal(packet.root, original.root);
  assert.equal('replayed' in packet, false, 'the packet schema is closed: the flag lives beside the packet');

  const records = await readRecords(workflow, KEY);
  assert.equal(records.length, 2, 'a replay appends nothing');
});

test('a replay with a caller-supplied ID does not need the projection to still equal the recorded after', async (t) => {
  const { workflow, harness } = await setup(t);
  await harness.run({ requestId: KEY });
  await workflow.write('akrs/memory/other.md', 'someone else changed the workflow');
  const result = await harness.run({ requestId: KEY });
  assert.equal(result.outcome, 'replayed');
  assert.equal(harness.applied.length, 1);
  assert.equal(result.packet.snapshot.before, await workflowSnapshot(workflow));
  assert.equal(result.packet.snapshot.after, result.packet.snapshot.before);
});

test('same ID with a different command, input, target or snapshot is a usage error that writes nothing', async (t) => {
  const { workflow, harness } = await setup(t);
  const first = await harness.run({ requestId: KEY, expectedSnapshot: await workflowSnapshot(workflow) });
  assert.equal(first.outcome, 'committed');
  const treeBefore = await byteTreeHash(workflow.root);
  const originalHash = (await readRecords(workflow, KEY))[1].request_hash;

  const variants = {
    input: { input: { name: 'note', body: 'different' } },
    command: { command: 'log-append' },
    target: { target: { road: 'R1', plan: null } },
    'expected snapshot': { expectedSnapshot: `sha256:${'b'.repeat(64)}` },
    'missing expected snapshot': { expectedSnapshot: null },
  };
  for (const [label, overrides] of Object.entries(variants)) {
    const result = await harness.run({ requestId: KEY, expectedSnapshot: await workflowSnapshot(workflow), ...overrides });
    assert.equal(result.outcome, 'conflict', label);
    assert.equal(result.exit_code, 2, label);
    assert.equal(result.packet.status, 'error', label);
    assert.equal(result.packet.data.kind, 'usage', label);
    assert.equal(result.packet.request_id, KEY, label);
    assert.equal(result.packet.findings.length, 1, label);
    const [finding] = result.packet.findings;
    assert.equal(finding.code, 'AKRS-C010', label);
    assert.equal(finding.severity, 'error', label);
    assert.equal(finding.detail.request_id, KEY, label);
    assert.equal(finding.detail.recorded_request_hash, originalHash, label);
    assert.match(finding.detail.supplied_request_hash, SHA, label);
    assert.notEqual(finding.detail.supplied_request_hash, originalHash, label);
    assert.equal(result.replayed, null, label);
    assert.equal(validatePacket(result.packet).ok, true, label);
    assert.equal(await byteTreeHash(workflow.root), treeBefore, `${label}: nothing written`);
  }
  assert.equal(harness.applied.length, 1);
});

test('a conflicting reuse is refused even while the first attempt has not committed', async (t) => {
  const { workflow, harness } = await setup(t);
  const failing = await harness.run({
    requestId: KEY,
    apply: async (context) => harness.rejection(context, 'error', 'AKRS-C004'),
  });
  assert.equal(failing.outcome, 'failed');
  const treeBefore = await byteTreeHash(workflow.root);
  const conflict = await harness.run({ requestId: KEY, input: { name: 'note', body: 'changed' } });
  assert.equal(conflict.outcome, 'conflict');
  assert.equal(await byteTreeHash(workflow.root), treeBefore);
});

test('an invalid caller request ID is a usage error and consumes nothing', async (t) => {
  const { workflow, harness } = await setup(t);
  const treeBefore = await byteTreeHash(workflow.root);
  for (const requestId of ['nope', '01ARZ3NDEKTSV4RRFFQ6', ulid(1).toLowerCase(), 'Z'.repeat(26), '']) {
    const result = await harness.run({ requestId });
    assert.equal(result.outcome, 'invalid_request', requestId);
    assert.equal(result.exit_code, 2);
    assert.equal(result.packet.findings[0].code, 'AKRS-C001');
    assert.equal(result.packet.data.kind, 'usage');
  }
  assert.equal(harness.applied.length, 0);
  assert.equal(await byteTreeHash(workflow.root), treeBefore);
});

test('the frozen order is lock, authorize, conflict, replay, validate, apply and callbacks run under the lock', async (t) => {
  const { workflow, harness } = await setup(t);
  const trace = [];
  const underLock = async (label) => {
    const owner = await readLockOwner(workflow.options);
    trace.push([label, owner.status]);
  };
  const callbacks = {
    authorize: async () => { await underLock('authorize'); return null; },
    validate: async () => { await underLock('validate'); return null; },
    apply: async (context) => { await underLock('apply'); return harness.apply(context); },
  };
  await harness.run({ requestId: KEY, ...callbacks });
  assert.deepEqual(trace, [['authorize', 'valid'], ['validate', 'valid'], ['apply', 'valid']]);

  trace.length = 0;
  const replay = await harness.run({ requestId: KEY, ...callbacks });
  assert.equal(replay.outcome, 'replayed');
  assert.deepEqual(trace, [['authorize', 'valid']], 'a replay re-runs only the cheap authorization gate');
  assert.equal((await readLockOwner(workflow.options)).status, 'absent', 'the lock is released');

  trace.length = 0;
  const conflict = await harness.run({ requestId: KEY, input: { name: 'note', body: 'x' }, ...callbacks });
  assert.equal(conflict.outcome, 'conflict');
  assert.deepEqual(trace, [['authorize', 'valid']], 'conflict stops before validate and apply');
});

test('validation still runs: authorization is re-checked on replay and validate failures are never masked', async (t) => {
  const { workflow, harness } = await setup(t);
  await harness.run({ requestId: KEY });

  // role gate: a different role cannot replay someone else's operation
  const denied = await harness.run({
    requestId: KEY,
    authorize: async (context) => ({ packet: harness.rejection(context, 'blocked', 'AKRS-C005') }),
  });
  assert.equal(denied.outcome, 'rejected');
  assert.equal(denied.packet.status, 'blocked');
  assert.equal(denied.replayed, null);
  assert.equal(harness.applied.length, 1);

  // a validation failure on a fresh request leaves no journal trace and does not consume the ID
  const second = ulid(2);
  const treeBefore = await byteTreeHash(workflow.root);
  const invalid = await harness.run({
    requestId: second,
    input: { name: 'other', body: 'x' },
    validate: async (context) => ({ packet: harness.rejection(context, 'error', 'AKRS-C008') }),
  });
  assert.equal(invalid.outcome, 'rejected');
  assert.equal(invalid.packet.status, 'error');
  assert.equal(await byteTreeHash(workflow.root), treeBefore, 'a rejected request writes nothing');
  assert.equal((await readOp({ ...workflow.options, requestId: second })).status, 'none');
  const fixed = await harness.run({ requestId: second, input: { name: 'other', body: 'x' } });
  assert.equal(fixed.outcome, 'committed', 'the ID is still free after a validation failure');
});

test('an explicit expected snapshot that no longer matches is blocked, not masked by an earlier identical request', async (t) => {
  const { workflow, harness } = await setup(t);
  const stale = await workflowSnapshot(workflow);
  await harness.run({ requestId: KEY, expectedSnapshot: stale });
  const current = await workflowSnapshot(workflow);
  assert.notEqual(stale, current);

  const treeBefore = await byteTreeHash(workflow.root);
  const blocked = await harness.run({ requestId: ulid(2), expectedSnapshot: stale });
  assert.equal(blocked.outcome, 'stale');
  assert.equal(blocked.exit_code, 1);
  assert.equal(blocked.packet.status, 'blocked');
  const [finding] = blocked.packet.findings;
  assert.equal(finding.code, 'AKRS-C013');
  assert.deepEqual(
    { source: finding.detail.source, expected: finding.detail.expected, current: finding.detail.current },
    { source: 'explicit', expected: stale, current },
  );
  assert.equal(await byteTreeHash(workflow.root), treeBefore);
  assert.equal(harness.applied.length, 1);
  assert.equal((await readOp({ ...workflow.options, requestId: ulid(2) })).status, 'none');

  const ok = await harness.run({ requestId: ulid(2), expectedSnapshot: current, input: { name: 'two', body: 'y' } });
  assert.equal(ok.outcome, 'committed');
  assert.equal((await readRecords(workflow, ulid(2)))[1].expected_snapshot, current);
});

test('a generated-ID replay needs a committed op with the same command, target and input and current equal to its after', async (t) => {
  const { workflow, harness } = await setup(t);
  const first = await harness.run({});
  assert.equal(first.generated, true);

  const again = await harness.run({});
  assert.equal(again.outcome, 'replayed');
  assert.equal(again.request_id, first.request_id, 'the original request ID is returned');
  assert.equal(again.generated, true);
  assert.deepEqual(again.replayed, { request_id: first.request_id, committed_at: first.record.ts });
  assert.equal(again.packet.request_id, first.request_id);
  assert.equal(again.packet.status, 'noop');
  assert.deepEqual(again.packet.changed, []);
  assert.equal(harness.applied.length, 1);
  assert.equal(await listNames(`${journalDirectory(workflow)}/ops`).then((names) => names.length), 1, 'no second ID was consumed');

  // different command, target or input: not a replay
  for (const overrides of [
    { input: { name: 'note', body: 'bye' } }, { command: 'log-append' }, { target: { road: 'R1', plan: null } },
  ]) {
    const result = await harness.run(overrides);
    assert.equal(result.outcome, 'committed', JSON.stringify(overrides));
  }
});

test('when the projection changed since the recorded after, a generated-ID repeat is NOT a noop', async (t) => {
  const { workflow, harness } = await setup(t);
  const first = await harness.run({});
  await workflow.write('akrs/memory/elsewhere.md', 'another writer moved the workflow');
  const second = await harness.run({});
  assert.equal(second.outcome, 'committed');
  assert.notEqual(second.request_id, first.request_id);
  assert.equal(harness.applied.length, 2);
  assert.equal(second.replayed, null);

  // the index now names the newest committed op, and an immediate repeat replays that one
  const third = await harness.run({});
  assert.equal(third.outcome, 'replayed');
  assert.equal(third.request_id, second.request_id);
});

test('dry runs are never journaled and never consume an ID', async (t) => {
  const { workflow, harness } = await setup(t);
  const treeBefore = await byteTreeHash(workflow.root);
  const runIdCalls = harness.providers.calls.runId;
  const result = await harness.run({ dryRun: true, requestId: KEY });
  assert.equal(result.outcome, 'dry_run');
  assert.equal(result.request_id, null);
  assert.equal(result.rejection, null);
  assert.equal(harness.applied.length, 0);
  assert.equal(harness.providers.calls.runId, runIdCalls);
  assert.equal(await byteTreeHash(workflow.root), treeBefore);
  assert.equal((await readOp({ ...workflow.options, requestId: KEY })).status, 'none');

  const rejected = await harness.run({
    dryRun: true,
    validate: async (context) => ({ packet: harness.rejection(context, 'error', 'AKRS-C008') }),
  });
  assert.equal(rejected.outcome, 'rejected', 'a dry run still validates');
  assert.equal(await byteTreeHash(workflow.root), treeBefore);
  assert.equal((await harness.run({ requestId: KEY })).outcome, 'committed', 'the ID was never consumed');
});

test('two different appends both land; an exact-duplicate append is a noop that offers --again', async (t) => {
  const { workflow, harness } = await setup(t);
  const again = [{ command: 'memory-add', args: ['--again'] }];
  const append = (name, overrides = {}) => harness.run({
    dedupe: 'append', input: { name, body: `body ${name}` }, replayNextCommands: again, ...overrides,
  });
  const a = await append('a');
  const b = await append('b');
  assert.deepEqual([a.outcome, b.outcome], ['committed', 'committed']);
  assert.equal(harness.applied.length, 2);

  const baseInput = { name: 'a', body: 'body a' };
  const match = await findCommittedAppend({ ...workflow.options, command: 'memory-add', target: NO_TARGET, input: baseInput });
  assert.equal(match.request_id, a.request_id);
  assert.equal(match.committed_at, a.record.ts);
  assert.equal(await findCommittedAppend({ ...workflow.options, command: 'memory-add', target: NO_TARGET, input: { name: 'zzz', body: 'x' } }), null);

  // A, B, A: the projection moved on, but an exact duplicate append is still a duplicate
  const duplicate = await append('a');
  assert.equal(duplicate.outcome, 'replayed');
  assert.equal(duplicate.request_id, a.request_id);
  assert.equal(harness.applied.length, 2);
  assert.equal(duplicate.packet.status, 'noop');
  assert.deepEqual(duplicate.packet.next_commands.slice(-1), again, '--again is offered');
  assert.deepEqual(duplicate.packet.next_commands.slice(0, 1), a.packet.next_commands.slice(0, 1), 'the original next commands survive');
  assert.equal(validatePacket(duplicate.packet).ok, true);
});

test('--again performs a new op whose replay key is salted with the new request ID', async (t) => {
  const { workflow, harness } = await setup(t);
  const append = (overrides = {}) => harness.run({ dedupe: 'append', input: { name: 'a', body: 'same' }, ...overrides });
  const first = await append();
  const deliberate = await append({ again: true });
  assert.equal(deliberate.outcome, 'committed');
  assert.notEqual(deliberate.request_id, first.request_id);
  assert.equal(harness.applied.length, 2);

  const base = computeReplayKey({ command: 'memory-add', target: NO_TARGET, input: { name: 'a', body: 'same' } });
  const records = await readRecords(workflow, deliberate.request_id);
  assert.equal(records[1].replay_key, saltReplayKey(base, deliberate.request_id));
  assert.equal(records[1].request_hash, computeRequestHash({ command: 'memory-add', target: NO_TARGET, input: { name: 'a', body: 'same' } }));

  // the next plain duplicate still points at the original append
  const duplicate = await append();
  assert.equal(duplicate.outcome, 'replayed');
  assert.equal(duplicate.request_id, first.request_id);

  // retrying the --again op with its own request ID is a noop, not a third append
  const retry = await append({ again: true, requestId: deliberate.request_id });
  assert.equal(retry.outcome, 'replayed');
  assert.equal(retry.request_id, deliberate.request_id);
  assert.equal(harness.applied.length, 2);
});

test('executions are never deduplicated and never recorded', async (t) => {
  const { workflow, harness } = await setup(t);
  const run = (overrides = {}) => harness.run({ dedupe: 'none', command: 'verify', ...overrides });
  const one = await run();
  const two = await run();
  assert.deepEqual([one.outcome, two.outcome], ['executed', 'executed']);
  assert.equal(harness.applied.length, 2, 'two runs');
  assert.notEqual(one.request_id, two.request_id);
  assert.equal(one.packet.request_id, one.request_id);

  // the same caller ID twice, even with different input, is still two runs: nothing was recorded to conflict with
  const third = await run({ requestId: KEY });
  const fourth = await run({ requestId: KEY, input: { name: 'note', body: 'other' } });
  assert.deepEqual([third.outcome, fourth.outcome], ['executed', 'executed']);
  assert.equal(harness.applied.length, 4);
  assert.deepEqual(await listNames(journalDirectory(workflow)), [], 'no journal file exists for executions');
});

test('a missing draft is resolved through the journal before any usage error', async (t) => {
  const { workflow, harness } = await setup(t);
  const draft = 'akrs/drafts/note.json';
  const first = await harness.run({ draft });
  assert.equal((await readRecords(workflow, first.request_id))[1].draft, draft);
  assert.equal((await readRecords(workflow, first.request_id))[0].draft, draft);

  const resolved = await resolveFromJournal({
    ...workflow.options, command: 'memory-add', target: NO_TARGET, draftPath: draft,
    currentSnapshot: await workflowSnapshot(workflow),
  });
  assert.equal(resolved.status, 'committed');
  assert.equal(resolved.request_id, first.request_id);
  assert.equal(resolved.committed_at, first.record.ts);
  assert.equal(resolved.projection_matches, true);
  assert.equal(resolved.record.packet_hash, first.record.packet_hash);

  const replay = await buildReplayPacket({
    record: resolved.record, root: harness.root, currentSnapshot: await workflowSnapshot(workflow), providers: harness.providers,
  });
  assert.equal(replay.status, 'noop');
  assert.equal(replay.request_id, first.request_id);
  assert.deepEqual(replay.data, first.packet.data);

  // other command, other target, other draft path: nothing to resolve (the caller then raises its usage error)
  for (const overrides of [{ command: 'log-append' }, { target: { road: 'R1', plan: null } }, { draftPath: 'akrs/drafts/other.json' }]) {
    const none = await resolveFromJournal({
      ...workflow.options, command: 'memory-add', target: NO_TARGET, draftPath: draft, ...overrides,
    });
    assert.equal(none.status, 'none', JSON.stringify(overrides));
  }

  // once the projection moved on, the journal reports it so the caller does not replay stale news
  await workflow.write('akrs/memory/elsewhere.md', 'changed');
  const moved = await resolveFromJournal({
    ...workflow.options, command: 'memory-add', target: NO_TARGET, draftPath: draft,
    currentSnapshot: await workflowSnapshot(workflow),
  });
  assert.equal(moved.status, 'committed');
  assert.equal(moved.projection_matches, false);

  // the narrowing replay key (computed from the input when it is still known)
  const key = computeReplayKey({ command: 'memory-add', target: NO_TARGET, input: { name: 'note', body: 'hello' } });
  assert.equal((await resolveFromJournal({
    ...workflow.options, command: 'memory-add', target: NO_TARGET, draftPath: draft, replayKey: key,
  })).status, 'committed');
  assert.equal((await resolveFromJournal({
    ...workflow.options, command: 'memory-add', target: NO_TARGET, draftPath: draft, replayKey: saltReplayKey(key, ulid(9)),
  })).status, 'none');
});

test('the journal never contains input bodies, prompts or product contents', async (t) => {
  const { workflow, harness } = await setup(t, { 'src/own.js': `export const own = '${SENTINEL}';\n` });
  const input = { name: 'secret', body: `body with ${SENTINEL}` };
  await harness.run({ input, draft: 'akrs/drafts/secret.json', requestId: KEY });
  await harness.run({ input, draft: 'akrs/drafts/secret.json' });
  await harness.run({ input, requestId: ulid(2), dedupe: 'append', again: true });

  const files = await walk(workflow.path('akrs', '.ops'));
  assert.ok(files.some((file) => file.startsWith('journal/ops/')), 'the journal was written');
  assert.ok(files.some((file) => file.startsWith('journal/by-key/')));
  for (const file of files) {
    const text = await readFile(workflow.path('akrs', '.ops', file), 'utf8');
    assert.equal(text.includes(SENTINEL), false, `${file} must not contain the sentinel`);
    assert.equal(text.includes('body with'), false, `${file} must not contain input text`);
  }
  // the product file really does hold the sentinel, so the search above could have found it
  assert.match(await readFile(workflow.path('src/own.js'), 'utf8'), new RegExp(SENTINEL));
  assert.match(await readFile(workflow.path('akrs/memory/secret.md'), 'utf8'), new RegExp(SENTINEL));
});

test('journal writes, replays and conflicts never change any command snapshot', async (t) => {
  const { workflow, harness } = await setup(t);
  const views = async () => ({
    workflow: await workflowSnapshot(workflow),
    lease: (await computeSnapshot({ ...workflow.options, projections: LEASE_CONTRACT_PROJECTION, target: { road: 'R1' } })).snapshot,
  });
  const before = await views();
  await harness.run({ requestId: KEY, apply: harness.applyNothing });
  assert.deepEqual(await views(), before, 'a commit that changes nothing leaves both projections identical');
  await harness.run({ requestId: KEY });
  assert.deepEqual(await views(), before, 'a replay does too');
  await harness.run({ requestId: KEY, input: { name: 'note', body: 'x' } });
  assert.deepEqual(await views(), before, 'and so does a conflict');
  assert.ok((await walk(workflow.path('akrs', '.ops'))).length > 0);
});

test('a blocked repository lock yields a lock_blocked outcome and writes nothing', async (t) => {
  const { workflow, harness } = await setup(t);
  const held = await acquireRepositoryLock({ ...workflow.options, command: 'someone else' });
  assert.equal(held.status, 'acquired');
  t.after(() => held.handle.release());
  const result = await harness.run({ requestId: KEY, lockOptions: { timeoutMs: 40, retryMs: 10 } });
  assert.equal(result.outcome, 'lock_blocked');
  assert.equal(result.exit_code, 1);
  assert.equal(result.packet.status, 'blocked');
  assert.equal(result.packet.findings[0].code, 'AKRS-C009');
  assert.equal(harness.applied.length, 0);
  assert.deepEqual(await listNames(journalDirectory(workflow)), []);
});

test('apply that returns an error or blocked packet records failed and stays retryable', async (t) => {
  const { workflow, harness } = await setup(t);
  for (const status of ['error', 'blocked']) {
    const id = status === 'error' ? ulid(5) : ulid(6);
    const indexed = await listNames(`${journalDirectory(workflow)}/by-key`).then((names) => names.length);
    const failed = await harness.run({
      requestId: id,
      apply: async (context) => harness.rejection(context, status, 'AKRS-C004'),
    });
    assert.equal(failed.outcome, 'failed', status);
    assert.equal(failed.packet.status, status);
    const records = await readRecords(workflow, id);
    assert.deepEqual(records.map(({ state }) => state), ['prepared', 'failed']);
    assert.equal(records[1].packet, null, 'only committed records carry a packet');
    assert.equal(records[1].packet_hash, null);
    assert.equal(await listNames(`${journalDirectory(workflow)}/by-key`).then((names) => names.length), indexed, 'no index for a failure');

    const retry = await harness.run({ requestId: id });
    assert.equal(retry.outcome, 'committed', status);
    assert.deepEqual((await readRecords(workflow, id)).map(({ state }) => state), ['prepared', 'failed', 'prepared', 'committed']);
  }
});

test('an apply result that does not belong to the request is a programming error and is not committed', async (t) => {
  const { workflow, harness } = await setup(t);
  await assert.rejects(harness.run({
    requestId: KEY,
    apply: async (context) => {
      const packet = await harness.apply(context);
      return { ...packet, request_id: ulid(99) };
    },
  }), TypeError);
  assert.deepEqual((await readRecords(workflow, KEY)).map(({ state }) => state), ['prepared', 'failed']);
  assert.equal((await readLockOwner(workflow.options)).status, 'absent');
  await assert.rejects(harness.run({ requestId: ulid(7), apply: async () => null }), TypeError);
  await assert.rejects(harness.run({ requestId: ulid(8), apply: async (context) => ({ ...(await harness.apply(context)), command: 'other-command' }) }), TypeError);
});

test('readOp reports none, the last state and the records of an op', async (t) => {
  const { workflow, harness } = await setup(t);
  assert.deepEqual(await readOp({ ...workflow.options, requestId: KEY }), { status: 'none' });
  await harness.run({ requestId: KEY });
  const op = await readOp({ ...workflow.options, requestId: KEY });
  assert.equal(op.status, 'committed');
  assert.equal(op.request_id, KEY);
  assert.equal(op.records.length, 2);
  assert.equal(op.committed.state, 'committed');
  assert.equal(opFile(workflow, KEY).endsWith(`${KEY}.jsonl`), true);
  await assert.rejects(readOp({ ...workflow.options, requestId: '../escape' }), TypeError);
});

test('a packet the canonical codec cannot encode is a failure before the commit, not a half-written commit', async (t) => {
  const { workflow, harness } = await setup(t);
  await assert.rejects(harness.run({
    requestId: KEY,
    apply: async (context) => {
      const packet = await harness.apply(context);
      return { ...packet, data: { ratio: 1.5 } };
    },
  }), TypeError);
  assert.deepEqual((await readRecords(workflow, KEY)).map(({ state }) => state), ['prepared', 'failed']);
  assert.deepEqual(await listNames(`${journalDirectory(workflow)}/by-key`), []);
  assert.equal((await readLockOwner(workflow.options)).status, 'absent');
});
