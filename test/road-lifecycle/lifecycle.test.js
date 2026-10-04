// P2-W05: activate, finish and reopen under the shared safety stack: the expected snapshot, the request ID and its replay,
// the repository lock, the journal and one transaction; finish needs passing declared checks, a clean audit and writes the
// closure; finish and reopen release the lease; nothing is written when a guard refuses.
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { acquireRepositoryLock } from '../../lib/store/lock/index.js';
import { claimLease, readLease } from '../../lib/store/leases/index.js';
import { LEASE_CONTRACT_PROJECTION, computeSnapshot } from '../../lib/store/snapshots/index.js';
import { transitionRoad } from '../../lib/store/lifecycle/index.js';
import { everything, request, strict } from '../change/support.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { assertFindingsMatchCatalog } from '../road/support.js';
import { fileWrite, seedRoad } from '../road-details/support.js';
import {
  FAILING, KNOWN_COMMANDS, PASSING, closures, nodeCheck, codesOf, lifecycle, lifecycleWorld, put, reasonsOf, snapshotOf, statusOf, transition,
} from './support.js';

async function lease(repo, holder = 'flash') {
  const current = await computeSnapshot({ ...repo.options, projections: LEASE_CONTRACT_PROJECTION, target: { road: 'R-P6-1' } });
  const claimed = await claimLease({ ...repo.options, providers: repo.providers, kind: 'road', target: 'R-P6-1', holder, snapshot: current.snapshot, inventory: current.inventory });
  assert.equal(claimed.status, 'claimed');
}
const held = async (repo) => (await readLease({ ...repo.options, kind: 'road', target: 'R-P6-1' })).status === 'held';

test('a lifecycle mutation without --if-snapshot is a usage error and writes nothing; a dry run needs none and writes nothing', async (t) => {
  const { repo } = await lifecycleWorld(t, { status: 'QUEUED' });
  const before = await everything(repo);
  const missing = await lifecycle(repo, 'activate', ['R-P6-1']);
  assert.equal(missing.exitCode, 2);
  assert.equal(missing.packet.status, 'error');
  assert.equal(missing.packet.data.reason, 'invalid_input');
  assert.match(missing.packet.findings[0].message, /--if-snapshot/);
  const dry = await lifecycle(repo, 'activate', ['R-P6-1', '--dry-run']);
  assert.equal(dry.exitCode, 0, dry.stderr);
  assert.equal(dry.packet.data.dry_run, true);
  assert.deepEqual([dry.packet.data.road.from, dry.packet.data.road.to], ['QUEUED', 'ACTIVE']);
  assert.deepEqual(dry.packet.data.would_change, ['roads/P6/R-P6-1.json']);
  assert.equal(await everything(repo), before);
});

test('activate moves a ready QUEUED Road to ACTIVE in one journaled transaction and a retry with the same request ID is a noop', async (t) => {
  const { repo } = await lifecycleWorld(t, { status: 'QUEUED' });
  const requestId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const first = await transition(repo, 'activate', ['--request-id', requestId]);
  assert.equal(first.exitCode, 0, first.stderr);
  assert.equal(first.packet.status, 'ok');
  assert.deepEqual([first.packet.data.kind, first.packet.data.transition, first.packet.data.road.from, first.packet.data.road.to], ['road_lifecycle', 'activate', 'QUEUED', 'ACTIVE']);
  assert.equal(first.packet.request_id, requestId);
  assert.equal(await statusOf(repo), 'ACTIVE');
  assert.deepEqual(first.packet.data.readiness, { ready: true, blockers: [] });
  assert.notEqual(first.packet.snapshot.before, first.packet.snapshot.after, 'a fresh snapshot comes back');
  assert.deepEqual(first.packet.next_commands[0].command, 'road-details');
  const verdict = (await lifecycle(repo, 'check', ['R-P6-1'])).packet;
  assert.equal(verdict.data.road.contract, 'declared', 'the stored Road still verifies');
  const afterFirst = await strict(repo);
  const replay = await lifecycle(repo, 'activate', ['R-P6-1', '--if-snapshot', first.packet.snapshot.before, '--request-id', requestId]);
  assert.equal(replay.packet.status, 'noop');
  assert.equal(await strict(repo), afterFirst, 'a replay writes nothing');
  const conflict = await lifecycle(repo, 'reopen', ['R-P6-1', '--if-snapshot', first.packet.snapshot.before, '--request-id', requestId]);
  assert.equal(conflict.exitCode, 2, 'the same ID with a different request is a usage error');
  assert.equal(conflict.packet.data.reason, 'request_id_conflict');
});

test('a stale expected snapshot blocks and writes nothing', async (t) => {
  const { repo } = await lifecycleWorld(t, { status: 'QUEUED' });
  const stale = await snapshotOf(repo, 'road-activate');
  await seedRoad(repo, { id: 'R-P6-1', plan: 'P6', task: 'T-P6-1', deps: ['R-P5-6'], writes: [fileWrite('src/changed.js')], checks: [PASSING], executor_class: 'weak' }, { folder: 'roads/P6', status: 'QUEUED' });
  const before = await strict(repo);
  const blocked = await lifecycle(repo, 'activate', ['R-P6-1', '--if-snapshot', stale]);
  assert.equal(blocked.packet.status, 'blocked');
  assert.deepEqual(codesOf(blocked.packet), ['AKRS-C013']);
  assert.equal(await strict(repo), before);
});

test('every illegal edge is refused with the status named, and nothing is written', async (t) => {
  const cases = [['QUEUED', 'finish'], ['QUEUED', 'reopen'], ['ACTIVE', 'activate'], ['DONE', 'activate'], ['DONE', 'finish']];
  for (const [status, verb] of cases) {
    const { repo } = await lifecycleWorld(t, { status });
    const before = await strict(repo);
    const result = await transition(repo, verb);
    assert.equal(result.packet.status, 'error', `${status} ${verb}`);
    assert.deepEqual(reasonsOf(result.packet), ['illegal_transition'], `${status} ${verb}`);
    assert.equal(result.packet.findings[0].detail.subject, status);
    assertFindingsMatchCatalog(result.packet);
    assert.equal(await strict(repo), before, `${status} ${verb} writes nothing`);
  }
});

test('activate is blocked by readiness: an unfinished dependency names itself and nothing is written', async (t) => {
  const { repo } = await lifecycleWorld(t, { status: 'QUEUED' });
  await seedRoad(repo, { id: 'R-P5-6', plan: null, executor_class: 'medium' }, { status: 'ACTIVE' });
  const before = await strict(repo);
  const result = await transition(repo, 'activate');
  assert.equal(result.packet.status, 'blocked');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(reasonsOf(result.packet), ['dependency_not_done']);
  assert.deepEqual(result.packet.data.readiness.blockers, [{ reason: 'dependency_not_done', subject: 'R-P5-6' }]);
  assert.equal(await strict(repo), before);
});

test('finish runs the declared checks and the audit, writes the Road, the closure and lists every changed file; the lease is released', async (t) => {
  const { repo } = await lifecycleWorld(t, { status: 'ACTIVE', git: true });
  await put(repo, 'src/own.js', 'after\n');
  await put(repo, 'src/admin.js', 'new\n');
  await lease(repo);
  const result = await transition(repo, 'finish', ['--deviations', 'used the adapter']);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  assert.equal(result.packet.status, 'ok');
  const { data } = result.packet;
  assert.deepEqual([data.transition, data.road.from, data.road.to], ['finish', 'ACTIVE', 'DONE']);
  assert.deepEqual(data.checks, { declared: 1, selected: 1, passed: 1, failed: 0, timed_out: 0, spawn_failed: 0, interrupted: 0, not_run: 0 });
  assert.equal(data.audit.status, 'clean');
  assert.deepEqual(data.changed_files.map(({ path, category }) => [path, category]), [['src/admin.js', 'declared'], ['src/own.js', 'declared']]);
  assert.equal(data.closure.action, 'appended');
  assert.deepEqual(data.lease, { holder: 'flash', released: true });
  assert.equal(await statusOf(repo), 'DONE');
  assert.equal(await held(repo), false, 'the lease is gone after the commit');
  const [record] = (await closures(repo)).filter(({ subject }) => subject === 'R-P6-1');
  assert.deepEqual([record.kind, record.outcome, record.deviations], ['road', 'DONE', 'used the adapter']);
  assert.equal(data.closure.id, record.id);
  assertFindingsMatchCatalog(result.packet);
});

test('a failing declared check blocks finish: no status change, no closure, the check named', async (t) => {
  const { repo } = await lifecycleWorld(t, { status: 'ACTIVE', checks: [PASSING, FAILING], git: true });
  const before = await strict(repo);
  const result = await transition(repo, 'finish');
  assert.equal(result.packet.status, 'blocked');
  assert.deepEqual(reasonsOf(result.packet), ['checks_not_passed']);
  assert.deepEqual(codesOf(result.packet), ['AKRS-R023', 'AKRS-R025']);
  assert.deepEqual(result.packet.data.checks, { declared: 2, selected: 2, passed: 1, failed: 1, timed_out: 0, spawn_failed: 0, interrupted: 0, not_run: 0 });
  assert.equal(await statusOf(repo), 'ACTIVE');
  assert.equal((await closures(repo)).length, 0);
  assert.equal(await strict(repo), before, 'nothing but the unlocked check run happened');
  assertFindingsMatchCatalog(result.packet);
});

test('an undeclared product change blocks finish', async (t) => {
  const { repo } = await lifecycleWorld(t, { status: 'ACTIVE', git: true });
  await put(repo, 'src/own.js', 'after\n');
  await put(repo, 'src/elsewhere.js', 'not declared\n');
  const result = await transition(repo, 'finish');
  assert.equal(result.packet.status, 'blocked');
  assert.deepEqual(reasonsOf(result.packet), ['undeclared_change']);
  assert.equal(result.packet.findings.find(({ code }) => code === 'AKRS-R025').detail.subject, 'src/elsewhere.js');
  assert.equal(await statusOf(repo), 'ACTIVE');
  assert.equal((await closures(repo)).length, 0);
});

test('a pending blocking scope request blocks finish', async (t) => {
  const { repo } = await lifecycleWorld(t, { status: 'ACTIVE', git: true });
  await request(repo, { road: 'R-P6-1', add_writes: [fileWrite('src/new.js')], reason: 'need one more file' });
  const result = await transition(repo, 'finish');
  assert.equal(result.packet.status, 'blocked');
  assert.deepEqual(reasonsOf(result.packet), ['scope_request_pending']);
  assert.equal(await statusOf(repo), 'ACTIVE');
});

test('without git the audit is skipped, said so, and does not block; a finish dry run runs no check', async (t) => {
  const { repo } = await lifecycleWorld(t, { status: 'ACTIVE' });
  const dry = await lifecycle(repo, 'finish', ['R-P6-1', '--dry-run']);
  assert.equal(dry.packet.data.checks, null);
  assert.deepEqual(dry.packet.data.would_change.sort(), ['log/0001.jsonl', 'roads/P6/R-P6-1.json']);
  assert.equal(await statusOf(repo), 'ACTIVE');
  const result = await transition(repo, 'finish');
  assert.equal(result.packet.status, 'warning');
  assert.equal(result.packet.data.audit.status, 'skipped');
  assert.equal(await statusOf(repo), 'DONE');
});

test('reopen returns a DONE Road to QUEUED and keeps its closure; finishing again does not record a second closure', async (t) => {
  const { repo } = await lifecycleWorld(t, { status: 'ACTIVE' });
  assert.equal((await transition(repo, 'finish')).packet.data.closure.action, 'appended');
  const reopened = await transition(repo, 'reopen');
  assert.equal(reopened.packet.status, 'ok');
  assert.deepEqual([reopened.packet.data.road.from, reopened.packet.data.road.to], ['DONE', 'QUEUED']);
  assert.equal(await statusOf(repo), 'QUEUED');
  assert.equal((await closures(repo)).length, 1, 'the ledger is append-only');
  assert.equal((await transition(repo, 'activate')).packet.status, 'ok');
  const again = await transition(repo, 'finish');
  assert.equal(again.packet.data.closure.action, 'already_recorded');
  assert.equal((await closures(repo)).length, 1);
  assert.equal(await statusOf(repo), 'DONE');
});

test('reopening an ACTIVE Road takes it back from its Worker: QUEUED and the lease released', async (t) => {
  const { repo } = await lifecycleWorld(t, { status: 'ACTIVE' });
  await lease(repo);
  const result = await transition(repo, 'reopen');
  assert.equal(result.packet.status, 'ok');
  assert.deepEqual(result.packet.data.lease, { holder: 'flash', released: true });
  assert.equal(await held(repo), false);
  assert.equal(await statusOf(repo), 'QUEUED');
});

test('a held repository lock blocks the transition and nothing is written', async (t) => {
  const { repo } = await lifecycleWorld(t, { status: 'QUEUED' });
  const acquired = await acquireRepositoryLock({ ...repo.options, command: 'test' });
  t.after(() => acquired.handle?.release());
  const before = await strict(repo);
  const result = await transitionRoad({
    ...repo.options, providers: repo.providers, knownCommands: KNOWN_COMMANDS, command: 'road-activate', id: 'R-P6-1',
    expectedSnapshot: await snapshotOf(repo, 'road-activate'), lockOptions: { timeoutMs: 40, retryMs: 10 },
  });
  assert.equal(result.outcome, 'lock_blocked');
  assert.equal(result.packet.status, 'blocked');
  assert.equal(await strict(repo), before);
});

test('a stale finish request is refused without running a single declared check', async (t) => {
  const marker = join(tmpdir(), `akrs-lifecycle-marker-${process.pid}-${Date.now()}`);
  t.after(() => rm(marker, { force: true }));
  const { repo } = await lifecycleWorld(t, { status: 'ACTIVE', checks: [nodeCheck('mark', 'require("node:fs").writeFileSync(process.argv[1], "ran")', [marker])] });
  const stale = await snapshotOf(repo, 'road-finish');
  await seedRoad(repo, { id: 'R-P6-1', plan: 'P6', task: 'T-P6-1', deps: ['R-P5-6'], writes: [fileWrite('src/changed.js')], checks: [nodeCheck('mark', 'require("node:fs").writeFileSync(process.argv[1], "ran")', [marker])], executor_class: 'weak' }, { folder: 'roads/P6', status: 'ACTIVE' });
  const blocked = await lifecycle(repo, 'finish', ['R-P6-1', '--if-snapshot', stale]);
  assert.equal(blocked.packet.status, 'blocked');
  assert.deepEqual(codesOf(blocked.packet), ['AKRS-C013']);
  assert.equal(existsSync(marker), false, 'no check ran for a stale request');
  assert.equal((await transition(repo, 'finish')).packet.status === 'warning', true);
  assert.equal(existsSync(marker), true, 'a current request runs the check');
});
