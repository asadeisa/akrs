// P1-W03 / F7: acquisition, wait budget, blocked results, stale proof and recovery (in-process, deterministic).
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  acquireRepositoryLock,
  readLockOwner,
  validateLockOwner,
} from '../../lib/store/lock/index.js';
import {
  OWNER_SCHEMA,
  createLockWorkflow,
  fakeEnvironment,
  hostName,
  listDirectory,
  readOwnerFile,
  ulid,
  validOwner,
  writeLock,
} from './support.js';

const environmentOptions = (environment) => ({
  clock: environment.clock,
  sleep: environment.sleep,
  random: environment.random,
  runId: environment.runId,
  hostname: environment.hostname,
  isProcessAlive: environment.isProcessAlive,
});

const acquire = (workflow, environment, extra = {}) => acquireRepositoryLock({
  ...workflow.options,
  ...environmentOptions(environment),
  command: 'road finish',
  ...extra,
});

const HOLDER_KEYS = ['acquired_at', 'command', 'host', 'pid', 'run_id'];

test('acquire creates .ops/lock with a canonical owner record and exposes no machine path', async (t) => {
  const workflow = await createLockWorkflow(t);
  const environment = fakeEnvironment();
  const result = await acquire(workflow, environment);

  assert.equal(result.status, 'acquired');
  assert.equal(result.recovered, null);
  assert.equal(result.lock_path, '.ops/lock');
  assert.equal(result.attempts, 1);
  assert.equal(result.waited_ms, 0);
  assert.equal(result.handle.run_id, ulid(1));

  const owner = await readOwnerFile(workflow);
  assert.deepEqual(owner, {
    schema: OWNER_SCHEMA,
    pid: process.pid,
    host: 'test-host',
    run_id: ulid(1),
    command: 'road finish',
    acquired_at: '2026-10-03T10:00:00.000Z',
  });
  assert.deepEqual(validateLockOwner(owner), { ok: true, issues: [] });
  const bytes = await readFile(workflow.ownerFile, 'utf8');
  assert.equal(bytes, `${JSON.stringify(owner, null, 2)}\n`);
  assert.deepEqual(await listDirectory(workflow.lockDir), ['owner.json']);
  assert.deepEqual(await listDirectory(workflow.opsDir), ['lock']);

  // Lock facts offered to packets never carry the absolute workflow or repository path.
  const facts = JSON.stringify({ ...result, handle: result.handle.owner });
  assert.equal(facts.includes(workflow.root), false);
  assert.equal(bytes.includes(workflow.root), false);
  await result.handle.release();
});

test('acquire creates .ops itself, and never touches anything outside .ops', async (t) => {
  const workflow = await createLockWorkflow(t);
  await workflow.write('akrs/state.json', '{"keep":true}\n');
  const before = await listDirectory(workflow.path('akrs'));
  const result = await acquire(workflow, fakeEnvironment());
  assert.equal(result.status, 'acquired');
  assert.deepEqual(await listDirectory(workflow.path('akrs')), [...before, '.ops'].sort());
  await result.handle.release();
  assert.equal(await readFile(workflow.path('akrs', 'state.json'), 'utf8'), '{"keep":true}\n');
});

test('a held lock times out with a stable blocked result carrying the holder and leaves the lock untouched', async (t) => {
  const workflow = await createLockWorkflow(t);
  const first = await acquire(workflow, fakeEnvironment({ host: 'test-host' }));
  const heldBytes = await readFile(workflow.ownerFile, 'utf8');

  const environment = fakeEnvironment({ start: '2026-10-03T11:00:00.000Z', alive: () => true });
  const blocked = await acquire(workflow, environment, { timeoutMs: 100, retryMs: 25 });

  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'held');
  assert.equal(blocked.recovered, null);
  assert.equal(blocked.lock_path, '.ops/lock');
  assert.equal(blocked.waited_ms, 100);
  assert.equal(blocked.attempts, 5);
  assert.deepEqual(environment.sleeps, [25, 25, 25, 25]);
  assert.deepEqual(Object.keys(blocked.holder).sort(), HOLDER_KEYS);
  assert.deepEqual(blocked.holder, {
    pid: process.pid, host: 'test-host', run_id: ulid(1), command: 'road finish', acquired_at: '2026-10-03T10:00:00.000Z',
  });
  assert.deepEqual(blocked.finding, {
    code: 'AKRS-C009',
    severity: 'error',
    message: blocked.finding.message,
    file: '.ops/lock',
    line: null,
    detail: { holder: blocked.holder, reason: 'held' },
  });
  assert.match(blocked.finding.message, new RegExp(ulid(1)));
  assert.equal(JSON.stringify(blocked).includes(workflow.root), false);
  assert.equal(await readFile(workflow.ownerFile, 'utf8'), heldBytes);

  // The blocked result is stable: the same input yields the same value.
  const again = await acquire(workflow, fakeEnvironment({ start: '2026-10-03T11:00:00.000Z' }), { timeoutMs: 100, retryMs: 25 });
  assert.deepEqual(again, blocked);
  await first.handle.release();
});

test('timeoutMs 0 makes exactly one attempt and defaults are 5000 ms with 25 ms retries', async (t) => {
  const workflow = await createLockWorkflow(t);
  const holder = await acquire(workflow, fakeEnvironment());

  const once = fakeEnvironment();
  const single = await acquire(workflow, once, { timeoutMs: 0 });
  assert.equal(single.status, 'blocked');
  assert.equal(single.attempts, 1);
  assert.deepEqual(once.sleeps, []);

  const defaults = fakeEnvironment();
  const waited = await acquire(workflow, defaults);
  assert.equal(waited.status, 'blocked');
  assert.equal(waited.waited_ms, 5000);
  assert.equal(defaults.sleeps.every((ms) => ms === 25), true);
  assert.equal(defaults.sleeps.length, 200);
  await holder.handle.release();
});

test('retry delay is jittered by the injected random within half to one and a half retry intervals', async (t) => {
  const workflow = await createLockWorkflow(t);
  const holder = await acquire(workflow, fakeEnvironment());

  for (const random of [() => 0, () => 0.999999, () => 0.25]) {
    const environment = fakeEnvironment({ random });
    const blocked = await acquire(workflow, environment, { timeoutMs: 400, retryMs: 40 });
    assert.equal(blocked.status, 'blocked');
    assert.equal(environment.sleeps.length > 0, true);
    for (const ms of environment.sleeps.slice(0, -1)) assert.equal(ms >= 20 && ms <= 60, true, String(ms));
    assert.equal(blocked.waited_ms, 400, 'the last sleep is clipped to the remaining budget');
  }
  await holder.handle.release();
});

test('acquire validates its options before touching the filesystem', async (t) => {
  const workflow = await createLockWorkflow(t);
  const environment = fakeEnvironment();
  const bad = (extra) => acquire(workflow, environment, extra);
  await assert.rejects(bad({ command: '' }), TypeError);
  await assert.rejects(bad({ command: 7 }), TypeError);
  await assert.rejects(bad({ timeoutMs: -1 }), TypeError);
  await assert.rejects(bad({ timeoutMs: 1.5 }), TypeError);
  await assert.rejects(bad({ retryMs: 0 }), TypeError);
  await assert.rejects(bad({ runId: () => 'not-a-ulid' }), TypeError);
  assert.deepEqual(await listDirectory(workflow.path('akrs')), []);
});

test('a live old lock is never stolen: age alone proves nothing', async (t) => {
  const workflow = await createLockWorkflow(t);
  await writeLock(workflow, validOwner({ pid: process.pid, host: hostName(), acquired_at: '2000-01-01T00:00:00.000Z' }));
  const before = await readFile(workflow.ownerFile, 'utf8');

  // Real probe, real host: the owner is this very process.
  const blocked = await acquireRepositoryLock({
    ...workflow.options, command: 'x', timeoutMs: 60, retryMs: 20, runId: fakeEnvironment().runId,
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'held');
  assert.equal(blocked.recovered, null);
  assert.equal(blocked.holder.pid, process.pid);
  assert.equal(blocked.holder.acquired_at, '2000-01-01T00:00:00.000Z');
  assert.equal(await readFile(workflow.ownerFile, 'utf8'), before);

  // Injected probe: an old lock whose pid is reported alive (including a possibly reused pid) is kept.
  const environment = fakeEnvironment({ start: '2026-10-03T10:00:00.000Z', alive: () => true });
  await writeLock(workflow, validOwner({ host: 'test-host', acquired_at: '1999-12-31T00:00:00.000Z' }));
  const kept = await acquire(workflow, environment, { timeoutMs: 50, retryMs: 25 });
  assert.equal(kept.status, 'blocked');
  assert.equal(kept.reason, 'held');
  assert.equal(environment.probes.includes(4242), true, 'liveness is probed, never inferred from age');
  assert.equal((await readOwnerFile(workflow)).run_id, ulid(900));
});

test('a foreign-host owner is never auto-recovered, even if its pid looks dead locally', async (t) => {
  const workflow = await createLockWorkflow(t);
  await writeLock(workflow, validOwner({ host: 'some-other-host', pid: 4242 }));
  const before = await readFile(workflow.ownerFile, 'utf8');
  const environment = fakeEnvironment({ host: 'test-host', alive: () => false });

  const blocked = await acquire(workflow, environment, { timeoutMs: 50, retryMs: 25 });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'foreign_host');
  assert.equal(blocked.holder.host, 'some-other-host');
  assert.equal(blocked.finding.detail.reason, 'foreign_host');
  assert.equal(blocked.recovered, null);
  assert.deepEqual(environment.probes, [], 'a foreign pid is meaningless here and is not probed');
  assert.equal(await readFile(workflow.ownerFile, 'utf8'), before);
});

test('a proven-dead same-host owner is recovered once and the recovery is recorded', async (t) => {
  const workflow = await createLockWorkflow(t);
  await writeLock(workflow, validOwner({ host: 'test-host', pid: 4242, run_id: ulid(777) }));
  const environment = fakeEnvironment({ host: 'test-host', alive: (pid) => pid !== 4242 });

  const result = await acquire(workflow, environment, { timeoutMs: 100 });
  assert.equal(result.status, 'acquired');
  assert.deepEqual(result.recovered, { pid: 4242, host: 'test-host', run_id: ulid(777) });
  assert.equal(result.handle.run_id !== ulid(777), true);
  assert.equal((await readOwnerFile(workflow)).run_id, result.handle.run_id);
  assert.deepEqual(environment.probes, [4242]);
  // The stale directory is gone: only the fresh lock remains under .ops.
  assert.deepEqual(await listDirectory(workflow.opsDir), ['lock']);
  assert.deepEqual(await listDirectory(workflow.lockDir), ['owner.json']);
  await result.handle.release();
});

test('a recovery claim left by a dead recoverer blocks recovery of that exact owner until it is broken', async (t) => {
  const workflow = await createLockWorkflow(t);
  await writeLock(workflow, validOwner({ host: 'test-host', pid: 4242, run_id: ulid(777) }));
  const claim = workflow.path('akrs', '.ops', `lock.recover-${ulid(777)}`);
  await mkdir(claim);
  const environment = fakeEnvironment({ host: 'test-host', alive: (pid) => pid !== 4242 });

  const blocked = await acquire(workflow, environment, { timeoutMs: 50, retryMs: 25 });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'held');
  assert.equal(blocked.holder.run_id, ulid(777));
  assert.equal(blocked.recovered, null);
  assert.deepEqual(await listDirectory(workflow.opsDir), ['lock', `lock.recover-${ulid(777)}`]);
  assert.equal((await readOwnerFile(workflow)).run_id, ulid(777));
});

test('a claim for a different owner does not block recovery, and a finished recovery leaves no claim behind', async (t) => {
  const workflow = await createLockWorkflow(t);
  await writeLock(workflow, validOwner({ host: 'test-host', pid: 4242, run_id: ulid(777) }));
  await mkdir(workflow.path('akrs', '.ops', `lock.recover-${ulid(111)}`));
  const environment = fakeEnvironment({ host: 'test-host', alive: (pid) => pid !== 4242 });

  const result = await acquire(workflow, environment, { timeoutMs: 50 });
  assert.equal(result.status, 'acquired');
  assert.equal(result.recovered.run_id, ulid(777));
  assert.deepEqual(await listDirectory(workflow.opsDir), ['lock', `lock.recover-${ulid(111)}`]);
  await result.handle.release();
});

test('recovery that finds a different owner after judging stale restores the lock and treats it as held', async (t) => {
  const workflow = await createLockWorkflow(t);
  await writeLock(workflow, validOwner({ host: 'test-host', pid: 4242, run_id: ulid(777) }));
  const successor = validOwner({ host: 'test-host', pid: 5151, run_id: ulid(888), acquired_at: '2026-10-03T09:59:00.000Z' });
  const environment = fakeEnvironment({ host: 'test-host', alive: (pid) => pid !== 4242 });

  const blocked = await acquire(workflow, environment, {
    timeoutMs: 50,
    retryMs: 25,
    testHooks: {
      // Another acquirer recovered the lock and re-took it between the judgement and the rename.
      beforeRecoveryRename: async () => {
        await writeFile(workflow.ownerFile, `${JSON.stringify(successor, null, 2)}\n`);
      },
    },
  });

  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'held');
  assert.equal(blocked.recovered, null);
  assert.equal(blocked.holder.run_id, ulid(888));
  assert.deepEqual(await readOwnerFile(workflow), successor, 'the displaced lock was restored intact');
  assert.deepEqual(await listDirectory(workflow.opsDir), ['lock'], 'no stale directory is left behind');
});

test('an owner that changes while liveness is probed is not recovered', async (t) => {
  const workflow = await createLockWorkflow(t);
  await writeLock(workflow, validOwner({ host: 'test-host', pid: 4242, run_id: ulid(777) }));
  const successor = validOwner({ host: 'test-host', pid: 5151, run_id: ulid(888) });
  const environment = fakeEnvironment({
    host: 'test-host',
    alive: (pid) => pid !== 4242,
  });
  const probe = environment.isProcessAlive;
  let swapped = false;
  environment.isProcessAlive = async (pid) => {
    const alive = await probe(pid);
    if (!swapped) {
      swapped = true;
      await writeFile(workflow.ownerFile, `${JSON.stringify(successor, null, 2)}\n`);
    }
    return alive;
  };

  const blocked = await acquire(workflow, environment, { timeoutMs: 50, retryMs: 25 });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.holder.run_id, ulid(888));
  assert.equal(blocked.recovered, null);
  assert.deepEqual(await readOwnerFile(workflow), successor);
});

test('corrupt, partial and missing owner metadata block safely and are never stolen', async (t) => {
  const environmentFor = () => fakeEnvironment({ host: 'test-host', alive: () => false });
  const cases = {
    invalid_json: { raw: '{"schema": "akrs.lock-owner/v1", "pid": ' },
    empty_file: { raw: '' },
    not_json: { raw: 'pid 4242\n' },
    wrong_schema: { raw: `${JSON.stringify({ ...validOwner(), schema: 'akrs.lock-owner/v0' })}\n` },
    unknown_key: { raw: `${JSON.stringify({ ...validOwner(), extra: 1 })}\n` },
    bad_pid: { raw: `${JSON.stringify({ ...validOwner(), pid: 'abc' })}\n` },
    bad_timestamp: { raw: `${JSON.stringify({ ...validOwner(), acquired_at: 'today' })}\n` },
    array: { raw: '[]\n' },
    missing_owner: { owner: null },
  };

  for (const [name, spec] of Object.entries(cases)) {
    const workflow = await createLockWorkflow(t);
    await writeLock(workflow, spec.owner === undefined ? undefined : spec.owner, { raw: spec.raw });
    const before = await listDirectory(workflow.lockDir);
    const bytes = spec.raw === undefined ? null : await readFile(workflow.ownerFile, 'utf8');
    const environment = environmentFor();

    const blocked = await acquire(workflow, environment, { timeoutMs: 80, retryMs: 20 });
    assert.equal(blocked.status, 'blocked', name);
    assert.equal(blocked.reason, 'corrupt', name);
    assert.equal(blocked.holder, null, name);
    assert.deepEqual(blocked.finding.detail, { holder: null, reason: 'corrupt' }, name);
    assert.equal(blocked.waited_ms, 80, `${name}: waited the whole budget before reporting corrupt`);
    assert.deepEqual(environment.probes, [], `${name}: nothing to probe`);
    assert.deepEqual(await listDirectory(workflow.lockDir), before, name);
    if (bytes !== null) assert.equal(await readFile(workflow.ownerFile, 'utf8'), bytes, name);
  }
});

test('a lock path that is a plain file is corrupt, not free', async (t) => {
  const workflow = await createLockWorkflow(t);
  await mkdir(workflow.opsDir, { recursive: true });
  await writeFile(workflow.lockDir, 'pid 1\n');
  const blocked = await acquire(workflow, fakeEnvironment(), { timeoutMs: 40, retryMs: 20 });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'corrupt');
  assert.equal(await readFile(workflow.lockDir, 'utf8'), 'pid 1\n');
});

test('a contender that sees a fresh lock directory without an owner keeps waiting instead of reporting corrupt', async (t) => {
  const workflow = await createLockWorkflow(t);
  await mkdir(workflow.lockDir, { recursive: true });
  const live = validOwner({ host: 'test-host', pid: 4242, run_id: ulid(555) });
  const environment = fakeEnvironment({
    alive: () => true,
    onSleep: async (count) => {
      if (count === 1) await writeFile(workflow.ownerFile, `${JSON.stringify(live, null, 2)}\n`);
      if (count === 3) await rm(workflow.lockDir, { recursive: true, force: true });
    },
  });

  const result = await acquire(workflow, environment, { timeoutMs: 1000, retryMs: 25 });
  assert.equal(result.status, 'acquired');
  assert.equal(result.recovered, null);
  assert.equal(result.attempts, 4);
  assert.equal(environment.sleeps.length, 3);
  await result.handle.release();
});

test('a fresh directory that stays ownerless is reported corrupt only at timeout', async (t) => {
  const workflow = await createLockWorkflow(t);
  await mkdir(workflow.lockDir, { recursive: true });
  const environment = fakeEnvironment();
  const blocked = await acquire(workflow, environment, { timeoutMs: 100, retryMs: 25 });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'corrupt');
  assert.equal(blocked.attempts, 5);
  assert.equal(environment.sleeps.length, 4);
});

test('a failed owner write does not leave an ownerless lock behind', async (t) => {
  const workflow = await createLockWorkflow(t);
  const environment = fakeEnvironment();
  await assert.rejects(
    acquire(workflow, environment, {
      testHooks: { beforeOwnerWrite: async () => { throw new Error('disk full'); } },
    }),
    /disk full/,
  );
  assert.deepEqual(await listDirectory(workflow.opsDir), []);
  const retry = await acquire(workflow, fakeEnvironment());
  assert.equal(retry.status, 'acquired');
  await retry.handle.release();
});

test('an acquirer whose fresh directory is moved away before the owner write starts over', async (t) => {
  const workflow = await createLockWorkflow(t);
  const environment = fakeEnvironment();
  let calls = 0;
  const result = await acquire(workflow, environment, {
    testHooks: {
      // A recoverer's rename took the directory between our mkdir and our owner write.
      beforeOwnerWrite: async () => {
        calls += 1;
        if (calls === 1) await rm(workflow.lockDir, { recursive: true, force: true });
      },
    },
  });
  assert.equal(result.status, 'acquired');
  assert.equal(result.attempts, 2);
  assert.equal((await readOwnerFile(workflow)).run_id, result.handle.run_id);
  await result.handle.release();
});

test('readLockOwner reports absent, valid and corrupt states without leaking paths', async (t) => {
  const workflow = await createLockWorkflow(t);
  assert.deepEqual(await readLockOwner(workflow.options), { status: 'absent', lock_path: '.ops/lock' });

  await writeLock(workflow, validOwner());
  const valid = await readLockOwner(workflow.options);
  assert.equal(valid.status, 'valid');
  assert.deepEqual(valid.owner, validOwner());
  assert.equal(valid.lock_path, '.ops/lock');

  await writeLock(workflow, undefined, { raw: '{' });
  const corrupt = await readLockOwner(workflow.options);
  assert.equal(corrupt.status, 'corrupt');
  assert.equal(typeof corrupt.reason, 'string');
  assert.equal(JSON.stringify(corrupt).includes(workflow.root), false);
});
