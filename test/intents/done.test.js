// P2-W12 `done`: the Worker's finish in one call. The checks and the audit run unlocked, then the handoff, the DONE status and the closure land
// in ONE transaction under the lock with the lease re-checked; any failure finishes nothing and lists every blocker with a fix; the class's
// failure count offers `yield`; a stale lease returns the delta and the fresh packet.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validateDone, validateDoneBlocked } from '../../lib/schemas/intents.js';
import { readHandoffs } from '../../lib/store/verification/index.js';
import { assertFindingsMatchCatalog } from '../road/support.js';
import { fileWrite, request } from '../change/support.js';
import {
  FAILING, PASSING, ROAD, closures, codesOf, done, edit, everything, guardFileOf, intent, leaseOf, put, reasonsOf, statusOf, strict, work, workWorld,
} from './support.js';

const claimAndEdit = async (repo) => {
  assert.equal((await work(repo)).packet.status, 'ok');
  await edit(repo);
};

test('work, edit, done: the handoff, the status and the closure are written together and the lease is gone', async (t) => {
  const { repo } = await workWorld(t);
  await claimAndEdit(repo);
  const result = await done(repo, ['--deviations', 'used the adapter']);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  const { packet } = result;
  assert.equal(packet.status, 'ok');
  assert.equal(validateDone(packet.data).ok, true, JSON.stringify(validateDone(packet.data).issues));
  assert.deepEqual([packet.data.kind, packet.data.holder, packet.data.transition], ['done', 'flash', 'finish']);
  assert.deepEqual(packet.data.road, { id: ROAD, plan: 'P6', from: 'ACTIVE', to: 'DONE', path: 'akrs/roads/P6/R-P6-1.json' });
  assert.deepEqual(packet.data.checks, { declared: 1, selected: 1, passed: 1, failed: 0, timed_out: 0, spawn_failed: 0, interrupted: 0, not_run: 0 });
  assert.equal(packet.data.audit.status, 'clean');
  assert.deepEqual(packet.data.changed_files.map(({ path }) => path), ['src/admin.js', 'src/own.js']);
  assert.equal(await statusOf(repo), 'DONE');
  assert.equal(await leaseOf(repo), null, 'the lease is released');
  assert.equal(await guardFileOf(repo), null, 'and so is its guard allowlist');
  const [closure] = (await closures(repo)).filter(({ subject }) => subject === ROAD);
  assert.deepEqual([closure.kind, closure.outcome, closure.deviations], ['road', 'DONE', 'used the adapter']);
  assert.equal(packet.data.closure.id, closure.id);
  // the baton the Tester reads: the CLI filled Road, snapshot and readiness
  const ledger = await readHandoffs({ ...repo.options, key: 'P6' });
  assert.equal(ledger.records.length, 1);
  const handoff = ledger.records[0].value;
  assert.deepEqual([handoff.road, handoff.result, handoff.reach, handoff.expect, handoff.ready], [ROAD, 'the admin page is ready', ['open /admin'], 'a table of users', true]);
  assert.match(handoff.snapshot, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual([packet.data.handoff.id, packet.data.handoff.hash, packet.data.handoff.line], [handoff.id, handoff.hash, 1]);
  assert.deepEqual(packet.next_commands.map(({ command }) => command), ['state-render']);
  assertFindingsMatchCatalog(packet);
});

test('a failing declared check finishes nothing, lists the blocker with its fix and counts as a failure', async (t) => {
  const { repo } = await workWorld(t, { checks: [PASSING, FAILING] });
  await claimAndEdit(repo);
  const before = await everything(repo);
  const result = await done(repo);
  assert.equal(result.exitCode, 1);
  const { packet } = result;
  assert.equal(packet.status, 'blocked');
  assert.equal(validateDoneBlocked(packet.data).ok, true, JSON.stringify(validateDoneBlocked(packet.data).issues));
  assert.deepEqual(packet.data.blockers.map(({ reason }) => reason), ['checks_not_passed']);
  assert.match(packet.data.blockers[0].fix, /Fix the failing check/);
  assert.deepEqual(packet.data.checks, { declared: 2, selected: 2, passed: 1, failed: 1, timed_out: 0, spawn_failed: 0, interrupted: 0, not_run: 0 });
  assert.deepEqual(packet.data.attempts, { failures: 1, limit: 2 });
  assert.deepEqual(codesOf(packet), ['AKRS-R023', 'AKRS-R025']);
  assert.deepEqual(packet.next_commands.map(({ command }) => command), ['verify']);
  assert.equal(await statusOf(repo), 'ACTIVE');
  assert.equal((await closures(repo)).length, 0);
  assert.equal((await readHandoffs({ ...repo.options, key: 'P6' })).records.length, 0, 'no handoff was written');
  assert.equal(await everything(repo), before, 'nothing in the workflow changed');
  assert.equal((await leaseOf(repo)).holder, 'flash', 'the lease is kept');
  assertFindingsMatchCatalog(packet);
});

test('after the class\'s failure count the refusal offers yield; a new holder starts the count again', async (t) => {
  const { repo } = await workWorld(t, { checks: [FAILING] });
  await claimAndEdit(repo);
  const first = await done(repo);
  assert.deepEqual([first.packet.data.attempts, first.packet.next_commands.map(({ command }) => command)], [{ failures: 1, limit: 2 }, ['verify']]);
  const second = await done(repo);
  assert.deepEqual(second.packet.data.attempts, { failures: 2, limit: 2 });
  assert.deepEqual(second.packet.next_commands.map(({ command }) => command), ['verify', 'yield']);
  const offered = second.packet.next_commands.at(-1);
  assert.deepEqual(offered.args.slice(0, 3), [ROAD, '--executor', 'flash']);
  assert.match(offered.args[offered.args.indexOf('--reason') + 1], /done was refused 2 times/);
  // taking the Road over starts the count again
  assert.equal((await intent(repo, ['work', ROAD, '--executor', 'flash2', '--takeover'])).packet.status, 'ok');
  const other = await intent(repo, ['done', ROAD, '--executor', 'flash2', '--result', 'r', '--reach', 'x', '--expect', 'y']);
  assert.deepEqual(other.packet.data.attempts, { failures: 1, limit: 2 });
});

test('an undeclared product change and a pending blocking scope request are both named', async (t) => {
  const { repo } = await workWorld(t);
  await claimAndEdit(repo);
  await put(repo, 'src/elsewhere.js', 'not declared\n');
  await request(repo, { road: ROAD, add_writes: [fileWrite('src/new.js')], reason: 'need one more file' });
  const result = await done(repo);
  assert.equal(result.packet.status, 'blocked');
  const blockers = result.packet.data.blockers.map(({ reason, subject }) => `${reason}:${subject}`).sort();
  assert.ok(blockers.some((entry) => entry === 'undeclared_change:src/elsewhere.js'), blockers.join());
  assert.ok(blockers.some((entry) => entry.startsWith('scope_request_pending:')), blockers.join());
  assert.ok(result.packet.data.blockers.every(({ fix }) => typeof fix === 'string' && fix.length > 0));
  assert.equal(await statusOf(repo), 'ACTIVE');
});

test('the baton is three flat flags or a file; a missing one is named and nothing runs', async (t) => {
  const { repo } = await workWorld(t);
  await claimAndEdit(repo);
  const before = await strict(repo);
  const missing = await intent(repo, ['done', ROAD, '--executor', 'flash', '--result', 'ready']);
  assert.equal(missing.exitCode, 2);
  assert.deepEqual([missing.packet.data.reason, missing.packet.data.missing_inputs], ['missing_input', ['--reach', '--expect']]);
  assert.equal(await strict(repo), before);
  const both = await intent(repo, ['done', ROAD, '--executor', 'flash', '--result', 'ready', '--handoff', 'akrs/drafts/baton.json']);
  assert.equal(both.packet.data.reason, 'two_input_channels');
  await repo.write('akrs/drafts/baton.json', `${JSON.stringify({ result: 'the page is ready', reach: ['open /admin', 'click Users'], expect: 'a table' })}\n`);
  const fromFile = await intent(repo, ['done', ROAD, '--executor', 'flash', '--handoff', 'akrs/drafts/baton.json']);
  assert.equal(fromFile.packet.status, 'ok', fromFile.stdout);
  const handoff = (await readHandoffs({ ...repo.options, key: 'P6' })).records[0].value;
  assert.deepEqual([handoff.result, handoff.reach], ['the page is ready', ['open /admin', 'click Users']]);
});

test('without a lease, with another holder\'s lease, or for a Road that is not ACTIVE, done refuses and says what to run', async (t) => {
  const { repo } = await workWorld(t);
  await edit(repo);
  const none = await done(repo);
  assert.deepEqual([none.packet.status, none.packet.data.reason], ['blocked', 'lease_missing']);
  assert.deepEqual(none.packet.next_commands.map(({ command, args }) => [command, args[0]]), [['work', ROAD]]);
  assert.equal((await work(repo)).packet.status, 'ok');
  const other = await intent(repo, ['done', ROAD, '--executor', 'flash2', '--result', 'r', '--reach', 'x', '--expect', 'y']);
  assert.deepEqual([other.packet.data.reason, other.packet.data.holder, codesOf(other.packet)], ['lease_held', 'flash', ['AKRS-C012']]);
  assert.equal(await statusOf(repo), 'ACTIVE');
  const first = await done(repo);
  assert.equal(first.packet.status, 'ok');
  // the same done again is the journal's noop: the original answer, nothing recorded twice
  const again = await done(repo);
  assert.deepEqual([again.packet.status, again.packet.data.kind, again.packet.data.handoff.id], ['noop', 'done', first.packet.data.handoff.id]);
  assert.equal((await closures(repo)).length, 1, 'a second done records nothing');
});

test('a changed contract is blocked with the delta and the fresh Worker packet, and the lease is not touched', async (t) => {
  const { repo } = await workWorld(t);
  await claimAndEdit(repo);
  const lease = await leaseOf(repo);
  await put(repo, 'SOT/09-use-cases.md', `${Array.from({ length: 50 }, (_, index) => `changed line ${index + 1}`).join('\n')}\n`);
  const before = await everything(repo);
  const result = await done(repo);
  assert.equal(result.exitCode, 1);
  const { packet } = result;
  assert.deepEqual([packet.status, packet.data.reason, codesOf(packet)], ['blocked', 'lease_stale', ['AKRS-C013']]);
  assert.equal(packet.findings[0].detail.source, 'lease');
  assert.ok(packet.data.delta.changed.some((key) => key.startsWith('road-reads:')), JSON.stringify(packet.data.delta));
  assert.equal(validateDoneBlocked(packet.data).ok, true, JSON.stringify(validateDoneBlocked(packet.data).issues));
  assert.equal(packet.data.fresh.data.road.id, ROAD);
  assert.ok(packet.data.fresh.data.reads[0].text.includes('changed line 28'), 'the fresh packet carries the new window');
  assert.deepEqual(packet.next_commands.map(({ command }) => command), ['work']);
  assert.equal(await everything(repo), before);
  assert.deepEqual(await leaseOf(repo), lease, 'only work refreshes the lease');
  // one call recovers: work refreshes, done finishes
  assert.equal((await work(repo)).packet.data.claim.action, 'refreshed');
  // (the changed SOT file is somebody else's change in the same tree: the audit baseline names it)
  assert.equal((await done(repo, ['--pre-existing', 'SOT/09-use-cases.md'])).packet.status, 'ok');
});

test('without git the audit is skipped, said so with its warning, and never counted as a pass', async (t) => {
  const { repo } = await workWorld(t, { git: false });
  await claimAndEdit(repo);
  const result = await done(repo);
  assert.equal(result.packet.status, 'warning');
  assert.equal(result.packet.data.audit.status, 'skipped');
  assert.notEqual(result.packet.data.audit.status, 'clean');
  assert.ok(result.packet.findings.length > 0, 'the posture warning is reported');
  assert.equal(await statusOf(repo), 'DONE');
});

test('a done dry run runs nothing, writes nothing and names the three files it would change', async (t) => {
  const { repo } = await workWorld(t, { checks: [FAILING] });
  await claimAndEdit(repo);
  const before = await strict(repo);
  const result = await done(repo, ['--dry-run']);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.equal(result.packet.status, 'ok');
  assert.deepEqual([result.packet.data.dry_run, result.packet.data.checks, result.packet.data.handoff.id], [true, null, null]);
  assert.deepEqual([...result.packet.data.would_change].sort(), ['log/0001.jsonl', 'roads/P6/R-P6-1.json', 'verifications/P6/handoff.jsonl']);
  assert.equal(validateDone(result.packet.data).ok, true, JSON.stringify(validateDone(result.packet.data).issues));
  assert.equal(await strict(repo), before, 'no check ran, no failure was counted');
});

test('a Road without a Plan hands off under its own ID', async (t) => {
  const { repo } = await workWorld(t, { overrides: { plan: null, task: null } });
  await claimAndEdit(repo);
  const result = await done(repo);
  assert.equal(result.packet.status, 'ok', result.stdout);
  assert.equal(result.packet.data.handoff.plan, ROAD);
  assert.equal((await readHandoffs({ ...repo.options, key: ROAD })).records.length, 1);
});

test('an executors.json that does not verify and an unknown Road are refused without writing', async (t) => {
  const { repo } = await workWorld(t);
  await claimAndEdit(repo);
  const missing = await intent(repo, ['done', 'R-NOPE', '--executor', 'flash', '--result', 'r', '--reach', 'x', '--expect', 'y']);
  assert.equal(missing.exitCode, 2);
  const unresolved = await intent(repo, ['done', ROAD, '--result', 'r', '--reach', 'x', '--expect', 'y']);
  assert.deepEqual([unresolved.packet.status, unresolved.packet.data.reason], ['blocked', 'holder_unresolved']);
  assert.ok(unresolved.packet.next_commands.every(({ command }) => command === 'work'));
  const text = await repo.read('akrs/executors.json');
  await writeFile(repo.path('akrs/executors.json'), text.replace('"user_answer": "weak"', '"user_answer": "weak!"'));
  const broken = await done(repo);
  assert.equal(broken.packet.data.reason, 'executors_unusable');
  assert.equal(await statusOf(repo), 'ACTIVE');
  assert.ok(reasonsOf);
});
