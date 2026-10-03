// P1-W04 / F8: fault injection at every durability point, transaction recovery hand-off, index rebuild,
// retention, torn tails and corruption.
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeJsonl } from '../../lib/store/canonical/index.js';
import {
  JournalCorruptError,
  JOURNAL_POLICY,
  OP_SPEC,
  computeReplayKey,
  pruneJournal,
  readOp,
  rebuildJournalIndex,
} from '../../lib/store/journal/index.js';
import { acquireRepositoryLock, readLockOwner } from '../../lib/store/lock/index.js';
import { byteTreeHash } from '../helpers/byte-tree.js';
import {
  NO_TARGET,
  createHarness,
  createIdempotencyWorkflow,
  indexFile,
  journalDirectory,
  listNames,
  opFile,
  readRecords,
  ulid,
  walk,
} from './support.js';

const KEY = ulid(1);
const TX = ulid(500);
const boom = (label) => () => { throw new Error(`injected ${label}`); };

async function setup(t) {
  const workflow = await createIdempotencyWorkflow(t);
  return { workflow, harness: createHarness(workflow) };
}

const states = async (workflow, id) => (await readRecords(workflow, id)).map(({ state }) => state);
const pendingDirectory = (workflow) => join(journalDirectory(workflow), 'pending');

test('the fault points are the four durability points and unknown names are refused', async (t) => {
  const { harness } = await setup(t);
  assert.deepEqual(JOURNAL_POLICY.fault_points, ['after_prepared', 'after_apply', 'after_committed', 'after_index']);
  await assert.rejects(harness.run({ requestId: KEY, faults: { after_prepard: boom('typo') } }), TypeError);
  assert.equal(harness.applied.length, 0);
});

test('a fault receives the point, request and command, and the lock is released when it throws', async (t) => {
  const { workflow, harness } = await setup(t);
  const seen = [];
  await assert.rejects(harness.run({
    requestId: KEY,
    faults: { after_prepared: (context) => { seen.push(context); throw new Error('injected'); } },
  }), /injected/);
  assert.deepEqual(seen.map(({ point, request_id, command }) => ({ point, request_id, command })), [
    { point: 'after_prepared', request_id: KEY, command: 'memory-add' },
  ]);
  assert.equal((await readLockOwner(workflow.options)).status, 'absent');
});

test('a failure after the prepared record (before apply) stays retryable with the same ID', async (t) => {
  const { workflow, harness } = await setup(t);
  await assert.rejects(harness.run({ requestId: KEY, faults: { after_prepared: boom('prepared') } }), /injected prepared/);
  assert.deepEqual(await states(workflow, KEY), ['prepared']);
  assert.equal(harness.applied.length, 0);
  assert.equal((await readOp({ ...workflow.options, requestId: KEY })).status, 'prepared');

  const retry = await harness.run({ requestId: KEY });
  assert.equal(retry.outcome, 'committed');
  assert.equal(harness.applied.length, 1, 'applied exactly once');
  assert.deepEqual(await states(workflow, KEY), ['prepared', 'prepared', 'committed']);
  assert.equal((await harness.run({ requestId: KEY })).outcome, 'replayed');
});

test('a failure after apply without a transaction stays retryable (the apply must tolerate being re-run)', async (t) => {
  const { workflow, harness } = await setup(t);
  await assert.rejects(harness.run({ requestId: KEY, faults: { after_apply: boom('apply') } }), /injected apply/);
  assert.deepEqual(await states(workflow, KEY), ['prepared']);
  const retry = await harness.run({ requestId: KEY });
  assert.equal(retry.outcome, 'committed');
  assert.deepEqual(await states(workflow, KEY), ['prepared', 'prepared', 'committed']);
});

test('a thrown apply records failed, rethrows the original error and leaves the ID retryable', async (t) => {
  const { workflow, harness } = await setup(t);
  const failure = new Error('apply exploded');
  await assert.rejects(harness.run({ requestId: KEY, apply: async () => { throw failure; } }), (error) => error === failure);
  assert.deepEqual(await states(workflow, KEY), ['prepared', 'failed']);
  assert.equal((await readLockOwner(workflow.options)).status, 'absent');
  assert.equal((await readOp({ ...workflow.options, requestId: KEY })).status, 'failed');
  const retry = await harness.run({ requestId: KEY });
  assert.equal(retry.outcome, 'committed');
  assert.deepEqual(await states(workflow, KEY), ['prepared', 'failed', 'prepared', 'committed']);
});

test('a crash after the committed record then a retry with the same ID is a noop', async (t) => {
  const { workflow, harness } = await setup(t);
  await assert.rejects(harness.run({ requestId: KEY, faults: { after_committed: boom('committed') } }), /injected committed/);
  assert.deepEqual(await states(workflow, KEY), ['prepared', 'committed']);
  assert.deepEqual(await listNames(join(journalDirectory(workflow), 'by-key')), [], 'the index write never happened');

  const retry = await harness.run({ requestId: KEY });
  assert.equal(retry.outcome, 'replayed');
  assert.equal(retry.request_id, KEY);
  assert.equal(retry.packet.status, 'noop');
  assert.equal(harness.applied.length, 1);
  assert.deepEqual(await states(workflow, KEY), ['prepared', 'committed'], 'the replay appended nothing');
});

test('a crash after the committed record then a generated-ID retry is a noop with the original request ID', async (t) => {
  const { workflow, harness } = await setup(t);
  let original = null;
  await assert.rejects(harness.run({
    onRequestId: (id) => { original = id; },
    faults: { after_committed: boom('committed') },
  }), /injected committed/);
  assert.ok(original);
  assert.deepEqual(await listNames(join(journalDirectory(workflow), 'by-key')), [], 'the index is missing');

  const retry = await harness.run({});
  assert.equal(retry.outcome, 'replayed');
  assert.equal(retry.request_id, original, 'the original ID, found without an index entry');
  assert.equal(retry.packet.request_id, original);
  assert.equal(harness.applied.length, 1);
  const key = computeReplayKey({ command: 'memory-add', target: NO_TARGET, input: { name: 'note', body: 'hello' } });
  assert.equal(JSON.parse(await readFile(indexFile(workflow, key), 'utf8')).request_id, original, 'the replay repaired the index');
  assert.deepEqual(await listNames(join(journalDirectory(workflow), 'ops')), [`${original}.jsonl`]);
});

test('a crash after the index write loses nothing', async (t) => {
  const { workflow, harness } = await setup(t);
  let original = null;
  await assert.rejects(harness.run({
    onRequestId: (id) => { original = id; },
    faults: { after_index: boom('index') },
  }), /injected index/);
  const generated = await harness.run({});
  assert.equal(generated.outcome, 'replayed');
  assert.equal(generated.request_id, original);
  const supplied = await harness.run({ requestId: original });
  assert.equal(supplied.outcome, 'replayed');
  assert.equal(harness.applied.length, 1);
});

test('a corrupt or dangling index entry is ignored in favour of the ops and repaired by the replay', async (t) => {
  const { workflow, harness } = await setup(t);
  const first = await harness.run({});
  const key = computeReplayKey({ command: 'memory-add', target: NO_TARGET, input: { name: 'note', body: 'hello' } });
  const file = indexFile(workflow, key);
  const original = await readFile(file, 'utf8');

  await writeFile(file, '{ not json');
  const second = await harness.run({});
  assert.equal(second.outcome, 'replayed');
  assert.equal(second.request_id, first.request_id);
  assert.equal(await readFile(file, 'utf8'), original, 'a replay repairs a corrupt entry');

  await writeFile(file, original.replace(first.request_id, ulid(777)));
  const third = await harness.run({});
  assert.equal(third.outcome, 'replayed', 'an entry naming a missing op is ignored in favour of the ops');
  assert.equal(third.request_id, first.request_id);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal(harness.applied.length, 1);
});

test('a removed by-key directory is rebuilt from ops/* by the next mutation', async (t) => {
  const { workflow, harness } = await setup(t);
  const first = await harness.run({});
  const key = computeReplayKey({ command: 'memory-add', target: NO_TARGET, input: { name: 'note', body: 'hello' } });
  const original = await readFile(indexFile(workflow, key), 'utf8');
  await rm(join(journalDirectory(workflow), 'by-key'), { recursive: true });
  const again = await harness.run({});
  assert.equal(again.outcome, 'replayed');
  assert.equal(again.request_id, first.request_id);
  assert.equal(await readFile(indexFile(workflow, key), 'utf8'), original, 'rebuilding from ops/* reproduces the same bytes');
});

test('rebuildJournalIndex restores a single removed entry from ops/*', async (t) => {
  const { workflow, harness } = await setup(t);
  const first = await harness.run({});
  const key = computeReplayKey({ command: 'memory-add', target: NO_TARGET, input: { name: 'note', body: 'hello' } });
  const file = indexFile(workflow, key);
  const original = await readFile(file, 'utf8');
  await rm(file);
  const rebuilt = await rebuildJournalIndex(workflow.options);
  assert.deepEqual(rebuilt, { status: 'rebuilt', keys: 1 });
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal((await harness.run({})).request_id, first.request_id);
  assert.equal(harness.applied.length, 1);
  const held = await acquireRepositoryLock({ ...workflow.options, command: 'holder' });
  t.after(() => held.handle.release());
  const blocked = await rebuildJournalIndex({ ...workflow.options, lockOptions: { timeoutMs: 30, retryMs: 10 } });
  assert.equal(blocked.status, 'lock_blocked');
  assert.equal(blocked.finding.code, 'AKRS-C009');
});

test('the dirty flag brackets the commit-to-index window and a missing entry is trusted only while it is clear', async (t) => {
  const { workflow, harness } = await setup(t);
  const seen = [];
  await harness.run({
    requestId: KEY,
    faults: {
      after_prepared: async () => { seen.push(['prepared', (await listNames(journalDirectory(workflow))).includes('index.dirty')]); },
      after_apply: async () => { seen.push(['apply', (await listNames(journalDirectory(workflow))).includes('index.dirty')]); },
      after_committed: async () => { seen.push(['committed', (await listNames(journalDirectory(workflow))).includes('index.dirty')]); },
      after_index: async () => { seen.push(['index', (await listNames(journalDirectory(workflow))).includes('index.dirty')]); },
    },
  });
  assert.deepEqual(seen, [['prepared', false], ['apply', false], ['committed', true], ['index', false]]);
  assert.equal((await listNames(journalDirectory(workflow))).includes('index.dirty'), false);

  // a fresh request is a trusted miss while the flag is clear: ops/* is not read to find that out
  const garbage = join(journalDirectory(workflow), 'ops', `${ulid(2)}.jsonl`);
  await writeFile(garbage, 'garbage that would be a corrupt journal if it were read\n');
  const fresh = await harness.run({ input: { name: 'fresh', body: 'fresh' } });
  assert.equal(fresh.outcome, 'committed');

  // after a crash inside the window the flag stays, and the next mutation scans (and so meets the garbage)
  await assert.rejects(harness.run({ input: { name: 'crash', body: 'crash' }, faults: { after_committed: boom('window') } }), /injected window/);
  assert.equal((await listNames(journalDirectory(workflow))).includes('index.dirty'), true);
  await assert.rejects(harness.run({ input: { name: 'next', body: 'next' } }), JournalCorruptError);
  await rm(garbage);
  const settled = await harness.run({ input: { name: 'next', body: 'next' } });
  assert.equal(settled.outcome, 'committed');
  assert.equal((await listNames(journalDirectory(workflow))).includes('index.dirty'), false, 'rebuilding clears the flag');
});

test('rebuilding points every key at its newest committed op and ignores prepared and failed ones', async (t) => {
  const { workflow, harness } = await setup(t);
  const one = await harness.run({ requestId: ulid(10) });
  await workflow.write('akrs/memory/elsewhere.md', 'moved');
  const two = await harness.run({ requestId: ulid(11) });
  await assert.rejects(harness.run({ requestId: ulid(12), input: { name: 'x', body: 'y' }, faults: { after_prepared: boom('x') } }));
  await harness.run({ requestId: ulid(13), input: { name: 'z', body: 'z' }, apply: async (context) => harness.rejection(context, 'error', 'AKRS-C004') });
  assert.notEqual(one.request_id, two.request_id);

  await rm(join(journalDirectory(workflow), 'by-key'), { recursive: true });
  const rebuilt = await rebuildJournalIndex(workflow.options);
  assert.equal(rebuilt.keys, 1, 'only the committed key is indexed');
  const key = computeReplayKey({ command: 'memory-add', target: NO_TARGET, input: { name: 'note', body: 'hello' } });
  assert.equal(JSON.parse(await readFile(indexFile(workflow, key), 'utf8')).request_id, ulid(11));
});

test('a transaction ID is recorded and tracked as pending until the commit', async (t) => {
  const { workflow, harness } = await setup(t);
  let pendingDuringApply = null;
  const result = await harness.run({
    requestId: KEY,
    beginTransaction: async () => TX,
    apply: async (context) => {
      assert.equal(context.transaction, TX);
      pendingDuringApply = await listNames(pendingDirectory(workflow));
      return harness.apply(context);
    },
  });
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(pendingDuringApply, [`${KEY}.json`]);
  assert.deepEqual(await listNames(pendingDirectory(workflow)), [], 'cleared by the commit');
  const records = await readRecords(workflow, KEY);
  assert.equal(records[0].transaction, TX);
  assert.equal(records[1].transaction, TX);
});

test('failure after a prepared record with a transaction ID is blocked as recovery required: no second mutation', async (t) => {
  const { workflow, harness } = await setup(t);
  await assert.rejects(harness.run({
    requestId: KEY, beginTransaction: async () => TX, faults: { after_apply: boom('crash') },
  }), /injected crash/);
  assert.equal(harness.applied.length, 1);
  assert.deepEqual(await listNames(pendingDirectory(workflow)), [`${KEY}.json`]);
  const treeBefore = await byteTreeHash(workflow.root);

  const retry = await harness.run({ requestId: KEY, beginTransaction: async () => ulid(501) });
  assert.equal(retry.outcome, 'recovery_required');
  assert.equal(retry.exit_code, 1);
  assert.equal(retry.packet.status, 'blocked');
  assert.equal(retry.packet.findings[0].code, 'AKRS-C011');
  assert.deepEqual(retry.packet.findings[0].detail, { request_id: KEY, transaction: TX });
  assert.equal(harness.applied.length, 1, 'no second mutation');
  assert.equal(await byteTreeHash(workflow.root), treeBefore, 'nothing was written');

  // recovery blocks every other mutation too, including executions
  const unrelated = await harness.run({ requestId: ulid(2), input: { name: 'other', body: 'x' } });
  assert.equal(unrelated.outcome, 'recovery_required');
  assert.deepEqual(unrelated.packet.findings[0].detail, { request_id: KEY, transaction: TX });
  const execution = await harness.run({ dedupe: 'none', command: 'verify' });
  assert.equal(execution.outcome, 'recovery_required');
  assert.equal(harness.applied.length, 1);
  assert.equal(await byteTreeHash(workflow.root), treeBefore);
  assert.equal((await readOp({ ...workflow.options, requestId: KEY })).status, 'prepared');
});

test('the recovery hook is the P1-W05 hand-off: a rolled-back transaction becomes failed and the retry proceeds', async (t) => {
  const { workflow, harness } = await setup(t);
  await assert.rejects(harness.run({
    requestId: KEY, beginTransaction: async () => TX, faults: { after_apply: boom('crash') },
  }));
  const calls = [];
  const recoverNothing = async (context) => { calls.push(context); return { status: 'unrecoverable' }; };
  const blocked = await harness.run({ requestId: KEY, recover: recoverNothing });
  assert.equal(blocked.outcome, 'recovery_required');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request_id, KEY);
  assert.equal(calls[0].transaction, TX);
  assert.equal(calls[0].record.state, 'prepared');
  assert.equal((await harness.run({ requestId: KEY, recover: async () => undefined })).outcome, 'recovery_required');

  const retry = await harness.run({ requestId: KEY, recover: async () => ({ status: 'rolled_back' }) });
  assert.equal(retry.outcome, 'committed');
  assert.deepEqual(await states(workflow, KEY), ['prepared', 'failed', 'prepared', 'committed']);
  assert.deepEqual(await listNames(pendingDirectory(workflow)), []);
});

test('a leftover pending marker for an op that already finished is cleaned up, not treated as recovery', async (t) => {
  const { workflow, harness } = await setup(t);
  await harness.run({ requestId: KEY, beginTransaction: async () => TX });
  await mkdir(pendingDirectory(workflow), { recursive: true });
  const marker = join(pendingDirectory(workflow), `${KEY}.json`);
  await writeFile(marker, `${JSON.stringify({ schema: 'akrs.op-pending/v1', request_id: KEY, transaction: TX }, null, 2)}\n`);
  const next = await harness.run({ requestId: ulid(2), input: { name: 'two', body: 'two' } });
  assert.equal(next.outcome, 'committed');
  assert.deepEqual(await listNames(pendingDirectory(workflow)), []);

  await writeFile(join(pendingDirectory(workflow), `${ulid(3)}.json`), '{ garbage');
  await assert.rejects(harness.run({ requestId: ulid(4), input: { name: 'four', body: 'four' } }), JournalCorruptError);
  assert.equal((await readLockOwner(workflow.options)).status, 'absent');
});

test('retention keeps a finished op that is within the newest N or younger than the age, and never prunes prepared ops', async (t) => {
  const { workflow, harness } = await setup(t);
  const ids = [];
  for (let n = 0; n < 5; n += 1) {
    const result = await harness.run({ requestId: ulid(20 + n), input: { name: `n${n}`, body: `b${n}` } });
    ids.push(result.request_id);
  }
  await assert.rejects(harness.run({ requestId: ulid(30), input: { name: 'crash', body: 'x' }, faults: { after_prepared: boom('p') } }));
  await harness.run({ requestId: ulid(31), input: { name: 'bad', body: 'x' }, apply: async (context) => harness.rejection(context, 'error', 'AKRS-C004') });
  const later = { now: () => '2027-01-01T00:00:00.000Z', runId: harness.providers.runId };
  const opsDir = join(journalDirectory(workflow), 'ops');
  assert.equal((await listNames(opsDir)).length, 7);

  const keepYoung = await pruneJournal({ ...workflow.options, providers: later, retention: { maxOps: 2, maxAgeMs: 400 * 24 * 3600 * 1000 } });
  assert.deepEqual(keepYoung.removed, [], 'within the age: kept although beyond the count');
  const keepCount = await pruneJournal({ ...workflow.options, providers: later, retention: { maxOps: 100, maxAgeMs: 0 } });
  assert.deepEqual(keepCount.removed, [], 'within the count: kept although older than the age');

  const pruned = await pruneJournal({ ...workflow.options, providers: later, retention: { maxOps: 2, maxAgeMs: 0 } });
  assert.deepEqual([...pruned.removed].sort(), [ids[0], ids[1], ids[2], ids[3]].sort(), 'only finished ops beyond the newest two go');
  assert.deepEqual(await listNames(opsDir), [`${ids[4]}.jsonl`, `${ulid(30)}.jsonl`, `${ulid(31)}.jsonl`].sort(), 'the prepared op survives');
  assert.equal(pruned.kept, 3);
  assert.equal((await readOp({ ...workflow.options, requestId: ids[0] })).status, 'none');
  assert.equal((await listNames(join(journalDirectory(workflow), 'by-key'))).length, 1, 'index entries of pruned ops are dropped');

  // a prepared op is kept however old and however small the limits
  const strict = await pruneJournal({ ...workflow.options, providers: later, retention: { maxOps: 0, maxAgeMs: 0 } });
  assert.deepEqual([...strict.removed].sort(), [ids[4], ulid(31)].sort());
  assert.deepEqual(await listNames(opsDir), [`${ulid(30)}.jsonl`]);
  assert.deepEqual(await listNames(join(journalDirectory(workflow), 'by-key')), []);

  const defaults = await pruneJournal({ ...workflow.options, providers: later });
  assert.deepEqual(defaults.removed, [], 'the default policy keeps recent ops');
  assert.deepEqual(JOURNAL_POLICY.retention, { max_ops: 1000, max_age_days: 30 });
});

test('pruning waits for the repository lock like every other journal write', async (t) => {
  const { workflow, harness } = await setup(t);
  await harness.run({ requestId: KEY });
  const held = await acquireRepositoryLock({ ...workflow.options, command: 'holder' });
  t.after(() => held.handle.release());
  const blocked = await pruneJournal({ ...workflow.options, retention: { maxOps: 0, maxAgeMs: 0 }, lockOptions: { timeoutMs: 30, retryMs: 10 } });
  assert.equal(blocked.status, 'lock_blocked');
  assert.equal(blocked.finding.code, 'AKRS-C009');
  assert.equal((await readOp({ ...workflow.options, requestId: KEY })).status, 'committed');
  const inside = await pruneJournal({
    ...workflow.options, heldLock: held.handle, retention: { maxOps: 0, maxAgeMs: 0 },
  });
  assert.deepEqual(inside.removed, [KEY], 'a caller that already holds the lock passes its handle');
});

test('a commit applies the retention policy under the same lock and reports what it removed', async (t) => {
  const { workflow, harness } = await setup(t);
  const retention = { maxOps: 1, maxAgeMs: 0 };
  const run = (n) => harness.run({ requestId: ulid(n), input: { name: `p${n}`, body: `b${n}` }, retention });
  assert.deepEqual((await run(1)).prune.removed, []);
  assert.deepEqual((await run(2)).prune.removed, [ulid(1)]);
  const third = await run(3);
  assert.deepEqual(third.prune.removed, [ulid(2)]);
  assert.equal(third.prune.kept, 1);
  assert.deepEqual(await listNames(join(journalDirectory(workflow), 'ops')), [`${ulid(3)}.jsonl`], 'the op just committed is always kept');
  assert.equal((await listNames(join(journalDirectory(workflow), 'by-key'))).length, 1);
  assert.equal((await harness.run({ requestId: ulid(3), input: { name: 'p3', body: 'b3' }, retention })).outcome, 'replayed');
});

test('a torn trailing line is ignored when reading and repaired before the next append', async (t) => {
  const { workflow, harness } = await setup(t);
  await assert.rejects(harness.run({ requestId: KEY, faults: { after_prepared: boom('p') } }));
  const file = opFile(workflow, KEY);
  await appendFile(file, '{"id":"01ARZ3NDEKTSV4RRFFQ6TORN');
  const op = await readOp({ ...workflow.options, requestId: KEY });
  assert.equal(op.status, 'prepared');
  assert.equal(op.records.length, 1);

  const retry = await harness.run({ requestId: KEY });
  assert.equal(retry.outcome, 'committed');
  const text = await readFile(file, 'utf8');
  assert.equal(text.includes('TORN'), false, 'the torn bytes were removed');
  assert.equal(text.endsWith('\n'), true);
  const decoded = decodeJsonl(text, () => OP_SPEC);
  assert.equal(decoded.ok, true, JSON.stringify(decoded.issues));
  assert.deepEqual(decoded.records.map(({ value }) => value.state), ['prepared', 'prepared', 'committed']);
  assert.deepEqual(decoded.records.map(({ state }) => state), ['declared', 'declared', 'declared']);
});

test('a corrupt journal record is an internal failure, never a replay, and the lock is released', async (t) => {
  const { workflow, harness } = await setup(t);
  await harness.run({ requestId: KEY });
  const file = opFile(workflow, KEY);
  const good = await readFile(file, 'utf8');
  const tampered = good.replace('"command":"memory-add"', '"command":"memory-adx"');
  assert.notEqual(tampered, good);

  const cases = {
    'bad hash': tampered,
    'blank line': good.replace('\n', '\n\n'),
    'not json': `${good}garbage line\n`,
    'prepared after committed': `${good}${good.split('\n')[0]}\n`,
    'committed first': good.split('\n').slice(1).join('\n'),
  };
  for (const [label, text] of Object.entries(cases)) {
    await writeFile(file, text);
    await assert.rejects(readOp({ ...workflow.options, requestId: KEY }), JournalCorruptError, label);
    await assert.rejects(harness.run({ requestId: KEY }), (error) => {
      assert.ok(error instanceof JournalCorruptError, label);
      assert.equal(typeof error.reason, 'string');
      assert.equal(error.path.includes(workflow.root), false, 'no machine path in the error');
      return true;
    }, label);
    assert.equal((await readLockOwner(workflow.options)).status, 'absent', label);
  }
  assert.equal(harness.applied.length, 1);
});

test('concurrent identical requests in one process are serialized: one commit, the rest replay', async (t) => {
  const { workflow, harness } = await setup(t);
  const results = await Promise.all(Array.from({ length: 5 }, () => harness.run({
    requestId: KEY, lockOptions: { timeoutMs: 20_000, retryMs: 5 },
  })));
  assert.equal(results.filter(({ outcome }) => outcome === 'committed').length, 1);
  assert.equal(results.filter(({ outcome }) => outcome === 'replayed').length, 4);
  assert.equal(harness.applied.length, 1);
  assert.deepEqual(await states(workflow, KEY), ['prepared', 'committed']);

  const generated = await Promise.all(Array.from({ length: 5 }, () => harness.run({
    input: { name: 'g', body: 'g' }, lockOptions: { timeoutMs: 20_000, retryMs: 5 },
  })));
  const committed = generated.filter(({ outcome }) => outcome === 'committed');
  assert.equal(committed.length, 1);
  for (const result of generated) assert.equal(result.request_id, committed[0].request_id);
  assert.equal(harness.applied.length, 2);
  assert.equal((await walk(workflow.path('akrs', '.ops'))).filter((file) => file.startsWith('journal/ops/')).length, 2);
});

test('the journal is created with real directories under .ops and refuses link escapes', async (t) => {
  const { workflow, harness } = await setup(t);
  await harness.run({ requestId: KEY });
  assert.deepEqual(await listNames(journalDirectory(workflow)), ['by-key', 'ops']);
  const entries = await readdir(join(journalDirectory(workflow), 'ops'));
  assert.deepEqual(entries, [`${KEY}.jsonl`]);

  if (process.platform !== 'win32') {
    const { symlink } = await import('node:fs/promises');
    await rm(join(journalDirectory(workflow), 'ops'), { recursive: true });
    await mkdir(workflow.path('outside'), { recursive: true });
    await symlink(workflow.path('outside'), join(journalDirectory(workflow), 'ops'));
    await assert.rejects(harness.run({ requestId: ulid(2), input: { name: 'x', body: 'x' } }), /unsafe|symbolic/i);
    assert.deepEqual(await readdir(workflow.path('outside')), [], 'nothing escaped the workflow');
  }
});
