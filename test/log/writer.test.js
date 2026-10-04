import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLOSURE_SPEC } from '../../lib/schemas/closure.js';
import { validateMutationChanges } from '../../lib/schemas/packet.js';
import { decodeJsonl } from '../../lib/store/canonical/index.js';
import { LOG_FINDING_CODES, LOG_SEGMENT_LIMIT, readLog } from '../../lib/store/log/index.js';
import {
  assertFindingsMatchCatalog, closure, closureLine, codesOf, createRepo, listLog, logBytes, readLines, runCommand, seedSegment,
  treeDigest,
} from './support.js';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const logTree = (repo) => treeDigest(repo, { exclude: ['akrs/.ops'] });

test('append writes one complete canonical JSON line: declared hash, LF, first segment 0001', async (t) => {
  const repo = await createRepo(t);
  const result = await closure(repo, { deviations: 'Added a spinner — 🚀 تجربة' });
  assert.equal(result.outcome, 'committed');
  const { packet } = result;
  assert.equal(packet.status, 'ok');
  assert.equal(packet.command, 'log-append');
  assert.deepEqual(packet.changed, ['log/0001.jsonl']);
  assert.equal(validateMutationChanges(packet, ['log/0001.jsonl']).ok, true);
  assert.equal(packet.data.record.segment, 'akrs/log/0001.jsonl');
  assert.equal(packet.data.record.line, 1);
  assert.equal(packet.data.record.rotated, false);
  assert.match(packet.data.record.id, ULID);
  const text = await repo.read('akrs/log/0001.jsonl');
  assert.equal(text.endsWith('}\n'), true);
  assert.equal(text.split('\n').length, 2);
  const decoded = decodeJsonl(text, () => CLOSURE_SPEC);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.records[0].state, 'declared');
  assert.deepEqual(
    { ...decoded.records[0].value, id: null, hash: null, ts: null },
    { id: null, hash: null, ts: null, kind: 'road', subject: 'R-P6-1', outcome: 'DONE', deviations: 'Added a spinner — 🚀 تجربة', operation: null },
  );
  assert.equal(decoded.records[0].value.hash, packet.data.record.hash);
});

test('a dry run proposes the exact change and writes no byte', async (t) => {
  const repo = await createRepo(t);
  await seedSegment(repo, 1, 3);
  const before = await treeDigest(repo, { exclude: [] });
  const result = await closure(repo, {}, { dryRun: true });
  assert.equal(result.outcome, 'dry_run');
  assert.equal(result.packet.data.dry_run, true);
  assert.equal(result.packet.data.record.id, null);
  assert.equal(result.packet.data.record.hash, null);
  assert.equal(result.packet.data.record.line, 4);
  assert.deepEqual(result.packet.data.would_change, ['log/0001.jsonl']);
  assert.deepEqual(await treeDigest(repo, { exclude: [] }), before);
});

test('a duplicate closure is refused under the lock across all segments; BLOCKED may precede one DONE', async (t) => {
  const repo = await createRepo(t);
  await seedSegment(repo, 1, LOG_SEGMENT_LIMIT);
  await repo.write('akrs/log/0002.jsonl', closureLine(900, { subject: 'R-P6-1' }));
  const before = await logTree(repo);
  const refused = await closure(repo, { deviations: 'different text, same Road' });
  assert.equal(refused.outcome, 'rejected');
  assert.equal(refused.packet.status, 'error');
  assert.deepEqual(codesOf(refused.packet), [LOG_FINDING_CODES.duplicate]);
  assert.equal(refused.packet.findings[0].detail.path, 'akrs/log/0002.jsonl');
  assertFindingsMatchCatalog(refused.packet);
  assert.equal(refused.packet.next_commands.length > 0, true);
  assert.deepEqual(await logTree(repo), before);
  const blocked = await closure(repo, { subject: 'R-B', outcome: 'BLOCKED', deviations: 'waits' });
  assert.equal(blocked.outcome, 'committed');
  const again = await closure(repo, { subject: 'R-B', outcome: 'BLOCKED', deviations: 'still waits' });
  assert.equal(again.outcome, 'committed');
  const done = await closure(repo, { subject: 'R-B', outcome: 'DONE' });
  assert.equal(done.outcome, 'committed');
  const afterDone = await closure(repo, { subject: 'R-B', outcome: 'BLOCKED', deviations: 'late' });
  assert.deepEqual(codesOf(afterDone.packet), [LOG_FINDING_CODES.duplicate]);
  const plan = await closure(repo, { kind: 'plan', subject: 'R-P6-1' });
  assert.equal(plan.outcome, 'committed', 'a plan and a road with one ID are different subjects');
});

test('rotation: the 80th line stays in the segment, the 81st opens the next; archives stay byte-identical', async (t) => {
  const repo = await createRepo(t);
  await seedSegment(repo, 1, LOG_SEGMENT_LIMIT - 1);
  const last = await closure(repo, { subject: 'R-last' });
  assert.deepEqual(last.packet.changed, ['log/0001.jsonl']);
  assert.equal(last.packet.data.record.line, LOG_SEGMENT_LIMIT);
  const archived = await logBytes(repo, '0001.jsonl');
  assert.equal((await readLines(repo, '0001.jsonl')).length, LOG_SEGMENT_LIMIT);
  const next = await closure(repo, { subject: 'R-next' });
  assert.deepEqual(next.packet.changed, ['log/0002.jsonl']);
  assert.equal(next.packet.data.record.rotated, true);
  assert.equal(next.packet.data.record.line, 1);
  const more = await closure(repo, { subject: 'R-more' });
  assert.deepEqual(more.packet.changed, ['log/0002.jsonl']);
  assert.equal(more.packet.data.record.rotated, false);
  assert.equal(Buffer.compare(await logBytes(repo, '0001.jsonl'), archived), 0);
  assert.deepEqual(await listLog(repo), ['0001.jsonl', '0002.jsonl']);
});

test('an unusable ledger writes nothing: bad line, missing final newline, not text', async (t) => {
  for (const [name, content, reason] of [
    ['garbage', `${closureLine(1)}not json\n`, 'invalid_record'],
    ['newline', closureLine(1).trimEnd(), 'no_final_newline'],
    ['binary', Buffer.from([0xff, 0xfe, 0x00]), 'not_text'],
  ]) {
    const repo = await createRepo(t);
    await repo.write('akrs/log/0001.jsonl', content);
    const before = await logTree(repo);
    const result = await closure(repo, {});
    assert.equal(result.outcome, 'rejected', name);
    assert.deepEqual(codesOf(result.packet), [LOG_FINDING_CODES.segment], name);
    assert.equal(result.packet.findings[0].detail.reason, reason, name);
    assertFindingsMatchCatalog(result.packet);
    assert.deepEqual(await logTree(repo), before, name);
  }
});

test('invalid flags are usage errors and write nothing', async (t) => {
  const repo = await createRepo(t);
  for (const document of [{ kind: 'task' }, { outcome: 'done' }, { subject: '../x' }, { deviations: '' }]) {
    const result = await closure(repo, document);
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.packet.data.kind, 'usage');
  }
  assert.deepEqual(await listLog(repo), []);
});

test('the same request again adds no line: with and without a request ID', async (t) => {
  const repo = await createRepo(t);
  const first = await closure(repo, { subject: 'R-once' });
  assert.equal(first.outcome, 'committed');
  const same = await closure(repo, { subject: 'R-once' });
  assert.equal(same.outcome, 'replayed');
  assert.equal(same.packet.status, 'noop');
  assert.equal(same.packet.request_id, first.packet.request_id);
  const withId = await closure(repo, { subject: 'R-id' }, { requestId: '01JAAAAAAAAAAAAAAAAAAAAAAA' });
  const withIdAgain = await closure(repo, { subject: 'R-id' }, { requestId: '01JAAAAAAAAAAAAAAAAAAAAAAA' });
  assert.equal(withId.outcome, 'committed');
  assert.equal(withIdAgain.packet.status, 'noop');
  assert.equal((await readLines(repo, '0001.jsonl')).length, 2);
});

test('readLog orders records chronologically across segments and reports unverified records', async (t) => {
  const repo = await createRepo(t);
  await seedSegment(repo, 1, 2, 0);
  await seedSegment(repo, 2, 2, 10);
  const tampered = closureLine(20).replace('"DONE"', '"BLOCKED"');
  await repo.write('akrs/log/0003.jsonl', tampered);
  await repo.write('akrs/log/notes.txt', 'ignored');
  const log = await readLog(repo.options);
  assert.deepEqual(log.records.map(({ segment, line }) => [segment, line]), [[1, 1], [1, 2], [2, 1], [2, 2], [3, 1]]);
  assert.deepEqual(log.records.map(({ subject }) => subject), ['R-seed-0', 'R-seed-1', 'R-seed-10', 'R-seed-11', 'R-seed-20']);
  assert.deepEqual(log.unverified.map(({ subject }) => subject), ['R-seed-20']);
  assert.equal(log.segments.length, 3);
});

test('the CLI: `log append` flags through the real adapter; missing flags are exit 2', async (t) => {
  const repo = await createRepo(t);
  const ok = await runCommand(repo, ['log', 'append', '--kind', 'road', '--subject', 'R-1', '--outcome', 'DONE', '--json']);
  assert.equal(ok.exitCode, 0);
  const missing = await runCommand(repo, ['log', 'append', '--kind', 'road', '--json']);
  assert.equal(missing.exitCode, 2);
  const duplicate = await runCommand(repo, ['log', 'append', '--kind', 'road', '--subject', 'R-1', '--outcome', 'DONE', '--deviations', 'x', '--json']);
  assert.equal(duplicate.exitCode, 1);
});
