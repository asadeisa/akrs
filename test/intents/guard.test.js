// P2-W12 `guard`: the pre-write decision for hooks. With no matching lease it allows; a write outside the lease's declared writes, or under
// forbidden, is denied with a reason; CLI-owned workflow state is denied (drafts excepted); a crash of the guard allows (fail-open); the
// entry point is a minimal module that never loads the manifest or the snapshot engine and answers within its latency budget.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { decideWrite, globMatches, locateRoots, writeCovers } from '../../lib/store/intents/guard-core.js';
import { validateGuardCheck } from '../../lib/schemas/intents.js';
import { assertFindingsMatchCatalog } from '../road/support.js';
import { GUARD_BIN, ROAD, intent, runGuard, work, workWorld } from './support.js';

const ask = (repo, path, executor = 'flash') => intent(repo, ['guard', path, ...(executor === null ? [] : ['--executor', executor])]);

test('with no lease the guard allows every product path, for any identity', async (t) => {
  const { repo } = await workWorld(t);
  for (const [path, executor] of [['src/admin.js', 'flash'], ['src/anything/at/all.js', 'flash'], ['src/elsewhere.js', null]]) {
    const result = await ask(repo, path, executor);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.packet.status, 'ok');
    assert.equal(result.packet.data.decision, 'allow');
    assert.equal(validateGuardCheck(result.packet.data).ok, true);
  }
  assert.equal((await ask(repo, 'src/admin.js', 'flash')).packet.data.reason, 'no_lease');
  assert.equal((await ask(repo, 'src/admin.js', null)).packet.data.reason, 'no_identity');
});

test('a lease holder may write its declared writes and is denied everything else, with the reason', async (t) => {
  const { repo } = await workWorld(t);
  assert.equal((await work(repo)).packet.status, 'ok');
  const allowed = await ask(repo, 'src/admin.js');
  assert.deepEqual([allowed.packet.status, allowed.packet.data.decision, allowed.packet.data.reason, allowed.packet.data.road], ['ok', 'allow', 'writes', ROAD]);
  const outside = await ask(repo, 'src/other.js');
  assert.equal(outside.exitCode, 1);
  assert.deepEqual([outside.packet.status, outside.packet.data.decision, outside.packet.data.reason, outside.packet.data.road], ['blocked', 'deny', 'outside_writes', ROAD]);
  assert.match(outside.packet.findings[0].message, /outside the declared writes/);
  assertFindingsMatchCatalog(outside.packet);
  const forbidden = await ask(repo, 'server/api.js');
  assert.equal(forbidden.packet.data.reason, 'forbidden', 'forbidden wins and is named');
  // another executor is not the holder: the lease does not bind it
  assert.equal((await ask(repo, 'src/other.js', 'flash2')).packet.data.decision, 'allow');
});

test('CLI-owned workflow state is denied to everyone; drafts are the agent\'s to write', async (t) => {
  const { repo } = await workWorld(t);
  for (const path of ['akrs/roads/P6/R-P6-1.json', 'akrs/executors.json', 'akrs/.ops/leases/R-P6-1.lease.json', 'akrs/STATE.md']) {
    const denied = await ask(repo, path, null);
    assert.equal(denied.packet.data.decision, 'deny', path);
    assert.equal(denied.packet.data.reason, 'cli_owned', path);
  }
  const draft = await ask(repo, 'akrs/drafts/road-new.json', null);
  assert.deepEqual([draft.packet.data.decision, draft.packet.data.reason], ['allow', 'drafts']);
  // an absolute path inside the repository is judged the same way
  const absolute = await ask(repo, repo.path('akrs/roads/P6/R-P6-1.json'), null);
  assert.equal(absolute.packet.data.reason, 'cli_owned');
});

test('the pure decision handles classes, globs and case, and answers allow for what it cannot judge', () => {
  assert.equal(writeCovers({ path: 'src/admin.js', class: 'file' }, 'src/admin.js'), true);
  assert.equal(writeCovers({ path: 'src/admin.js', class: 'file' }, 'src/admin.jsx'), false);
  assert.equal(writeCovers({ path: 'src/ui', class: 'dir' }, 'src/ui/deep/x.js'), true);
  assert.equal(writeCovers({ path: 'src/ui', class: 'dir' }, 'src/uix/x.js'), false);
  assert.equal(writeCovers({ path: 'src/**/*.test.js', class: 'glob' }, 'src/a/b/c.test.js'), true);
  assert.equal(writeCovers({ path: 'src/*.js', class: 'glob' }, 'src/a/b.js'), false);
  assert.equal(writeCovers({ path: 'SRC/Admin.js', class: 'file' }, 'src/admin.js'), true, 'comparison is case-folded');
  assert.equal(globMatches('**', 'a/b/c'), true);
  assert.equal(globMatches('a/?/c', 'a/b/c'), true);
  assert.equal(globMatches('a/?/c', 'a/bb/c'), false);
  const nowhere = { repositoryRoot: '/nonexistent-akrs-root', workflowRoot: '/nonexistent-akrs-root/akrs' };
  assert.equal(decideWrite({ path: 'src/x.js', executor: 'flash', ...nowhere }).decision, 'allow');
  assert.equal(decideWrite({ path: '../escape.js', executor: 'flash', ...nowhere }).reason, 'outside_repository');
  assert.equal(decideWrite({ path: null, ...nowhere }).reason, 'guard_error');
  assert.deepEqual(Object.keys(locateRoots({ cwd: process.cwd() })), ['repositoryRoot', 'workflowRoot']);
});

test('a corrupt or foreign allowlist file never blocks: the guard allows what it cannot read', async (t) => {
  const { repo } = await workWorld(t);
  assert.equal((await work(repo)).packet.status, 'ok');
  await repo.write('akrs/.ops/leases/R-X.guard.json', '{ not json');
  await repo.write('akrs/.ops/leases/R-Y.guard.json', JSON.stringify({ schema: 'something-else', holder: 'flash', writes: [], forbidden: [] }));
  assert.equal((await ask(repo, 'src/admin.js')).packet.data.decision, 'allow');
  assert.equal((await ask(repo, 'src/other.js')).packet.data.decision, 'deny', 'the valid allowlist still applies');
});

test('bin/akrs-guard.js: exit 0 allow, exit 2 deny with the reason on stderr, one JSON line on stdout', async (t) => {
  const { repo } = await workWorld(t);
  assert.equal((await work(repo)).packet.status, 'ok');
  const allow = await runGuard(repo, ['src/admin.js', '--executor', 'flash']);
  assert.equal(allow.code, 0, allow.stderr);
  assert.deepEqual([JSON.parse(allow.stdout).decision, JSON.parse(allow.stdout).reason], ['allow', 'writes']);
  const deny = await runGuard(repo, ['src/other.js'], { env: { AKRS_EXECUTOR: 'flash' } });
  assert.equal(deny.code, 2);
  assert.equal(JSON.parse(deny.stdout).decision, 'deny');
  assert.match(deny.stderr, /outside the declared writes/);
  assert.equal(deny.stdout.trim().split('\n').length, 1);
  const owned = await runGuard(repo, ['akrs/roads/P6/R-P6-1.json']);
  assert.equal(owned.code, 2);
  assert.equal(JSON.parse(owned.stdout).reason, 'cli_owned');
});

test('a hook payload on stdin names the path; an unparseable payload and a missing path allow (fail-open)', async (t) => {
  const { repo } = await workWorld(t);
  assert.equal((await work(repo)).packet.status, 'ok');
  const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: repo.path('src/other.js'), content: 'x' } });
  const denied = await runGuard(repo, ['--executor', 'flash'], { stdin: payload });
  assert.equal(denied.code, 2);
  assert.equal(JSON.parse(denied.stdout).path, 'src/other.js');
  const garbage = await runGuard(repo, ['--executor', 'flash'], { stdin: '{ definitely not json' });
  assert.equal(garbage.code, 0);
  assert.equal(JSON.parse(garbage.stdout).reason, 'guard_error');
  const empty = await runGuard(repo, ['--executor', 'flash'], { stdin: '{}' });
  assert.equal(empty.code, 0);
  assert.equal(JSON.parse(empty.stdout).decision, 'allow');
});

test('the hook entry point imports only the guard core, and the core only node built-ins', async () => {
  const entry = await readFile(GUARD_BIN, 'utf8');
  const imports = [...entry.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ['../lib/store/intents/guard-core.js']);
  const core = await readFile(new URL('../../lib/store/intents/guard-core.js', import.meta.url), 'utf8');
  for (const specifier of [...core.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1])) assert.match(specifier, /^node:/);
});

test('the hook answers within its latency budget (p95 <= 150 ms through node bin/akrs-guard.js)', async (t) => {
  const { repo } = await workWorld(t);
  assert.equal((await work(repo)).packet.status, 'ok');
  const times = [];
  for (let index = 0; index < 20; index += 1) times.push((await runGuard(repo, [index % 2 === 0 ? 'src/admin.js' : 'src/other.js', '--executor', 'flash'])).ms);
  times.sort((left, right) => left - right);
  const p95 = times[Math.ceil(times.length * 0.95) - 1];
  assert.ok(p95 <= 150, `p95 ${p95.toFixed(0)} ms is over the 150 ms budget`);
});
