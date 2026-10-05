// P2-W09: `log` renders the segmented closure ledger as a chronology, exactly as recorded, and never rewrites it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateLog } from '../../lib/schemas/navigation.js';
import { treeDigest } from '../road/support.js';
import { closableWorld, finish, navWorld, query } from '../navigation/support.js';
import { runCommand } from '../road/support.js';

const log = (repo, extra = []) => query(repo, ['log', ...extra]);
const ok = (out) => {
  assert.equal(out.exitCode, 0, out.text);
  assert.equal(validateLog(out.packet.data).ok, true, JSON.stringify(validateLog(out.packet.data).issues));
  return out.packet;
};
const append = (repo, kind, subject, extra = []) => runCommand(repo, ['log', 'append', '--kind', kind, '--subject', subject, '--outcome', 'DONE', ...extra, '--json'], { providers: repo.providers });

test('an empty ledger is an explicit empty chronology', async (t) => {
  const repo = await navWorld(t);
  const packet = ok(await log(repo));
  assert.deepEqual([packet.command, packet.status, packet.data.kind, packet.data.packet_version], ['log', 'ok', 'log', 'akrs.log/v1']);
  assert.deepEqual([packet.data.entries, packet.data.total, packet.data.empty], [[], 0, true]);
});

test('closures come in ledger order with their segment, line, outcome and operation, verified', async (t) => {
  const repo = await closableWorld(t);
  const closed = await finish(repo);
  assert.equal(closed.exitCode, 0, closed.text);
  const first = await append(repo, 'road', 'R-P5-6');
  assert.equal(first.exitCode, 0, first.stderr);
  const packet = ok(await log(repo));
  assert.equal(packet.data.total, 2);
  assert.deepEqual(packet.data.entries.map(({ kind, subject }) => `${kind}:${subject}`), ['plan:P6', 'road:R-P5-6']);
  const [plan, road] = packet.data.entries;
  assert.deepEqual([plan.segment, plan.line, plan.outcome, plan.verified], [1, 1, 'DONE', true]);
  assert.match(plan.operation.request, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(road.operation, null);
  assert.equal(road.line, 2);
});

test('--kind, --subject and --limit narrow the view; the limit keeps the newest entries in chronological order', async (t) => {
  const repo = await closableWorld(t);
  await finish(repo);
  await append(repo, 'road', 'R-P5-6');
  await append(repo, 'road', 'R-P6-1');
  assert.deepEqual(ok(await log(repo, ['--kind', 'road'])).data.entries.map(({ subject }) => subject), ['R-P5-6', 'R-P6-1']);
  assert.deepEqual(ok(await log(repo, ['--subject', 'P6'])).data.entries.map(({ subject }) => subject), ['P6']);
  const limited = ok(await log(repo, ['--limit', '2']));
  assert.deepEqual(limited.data.entries.map(({ subject }) => subject), ['R-P5-6', 'R-P6-1']);
  assert.deepEqual([limited.data.total, limited.data.shown], [3, 2]);
  for (const bad of [['--kind', 'plans'], ['--limit', '0'], ['--limit', 'many'], ['--subject', 'not an id']]) assert.equal((await log(repo, bad)).exitCode, 2, bad.join(' '));
});

test('the ledger is never rewritten and a record that does not verify is shown as unverified, not dropped', async (t) => {
  const repo = await closableWorld(t);
  await finish(repo);
  const before = await repo.read('akrs/log/0001.jsonl');
  const digest = await treeDigest(repo);
  ok(await log(repo));
  assert.deepEqual(await treeDigest(repo), digest);
  const tampered = before.replace('"outcome":"DONE"', '"outcome":"BLOCKED"');
  await repo.write('akrs/log/0001.jsonl', tampered);
  const packet = ok(await log(repo));
  assert.equal(packet.data.entries[0].verified, false);
  assert.equal(await repo.read('akrs/log/0001.jsonl'), tampered, 'the read did not repair it');
});

test('the output is stable: the same ledger gives the same chronology', async (t) => {
  const repo = await closableWorld(t);
  await finish(repo);
  assert.deepEqual((await log(repo)).packet.data, (await log(repo)).packet.data);
});
