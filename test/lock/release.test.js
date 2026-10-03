// P1-W03 / F7: release ownership, withRepositoryLock, and the manual breakLock recovery surface.
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  acquireRepositoryLock,
  breakLock,
  readLockOwner,
  releaseRepositoryLock,
  withRepositoryLock,
} from '../../lib/store/lock/index.js';
import {
  createLockWorkflow,
  fakeEnvironment,
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

const lockOptions = (workflow, environment, extra = {}) => ({
  ...workflow.options,
  ...environmentOptions(environment),
  command: 'road finish',
  ...extra,
});

test('release removes the lock directory, keeps .ops, is idempotent and frees the lock for the next acquirer', async (t) => {
  const workflow = await createLockWorkflow(t);
  const acquired = await acquireRepositoryLock(lockOptions(workflow, fakeEnvironment()));
  assert.equal(acquired.status, 'acquired');

  const released = await acquired.handle.release();
  assert.deepEqual(released, { released: true });
  assert.deepEqual(await listDirectory(workflow.opsDir), [], 'no lock, owner or release leftovers remain');

  assert.deepEqual(await acquired.handle.release(), released, 'a second release returns the same outcome');
  assert.deepEqual(await releaseRepositoryLock(acquired.handle), released);

  const next = await acquireRepositoryLock(lockOptions(workflow, fakeEnvironment()));
  assert.equal(next.status, 'acquired');
  await next.handle.release();
});

test('release by a non-owner is refused and leaves the current lock alone', async (t) => {
  const workflow = await createLockWorkflow(t);
  const acquired = await acquireRepositoryLock(lockOptions(workflow, fakeEnvironment()));
  const usurper = validOwner({ run_id: ulid(321), pid: process.pid, host: 'test-host' });
  await writeFile(workflow.ownerFile, `${JSON.stringify(usurper, null, 2)}\n`);
  const bytes = await readFile(workflow.ownerFile, 'utf8');

  assert.deepEqual(await acquired.handle.release(), { released: false, reason: 'not_owner' });
  assert.equal(await readFile(workflow.ownerFile, 'utf8'), bytes);
  assert.deepEqual(await listDirectory(workflow.opsDir), ['lock']);
});

test('release when the lock was already removed reports not_owner without throwing', async (t) => {
  const workflow = await createLockWorkflow(t);
  const acquired = await acquireRepositoryLock(lockOptions(workflow, fakeEnvironment()));
  await rm(workflow.lockDir, { recursive: true, force: true });
  assert.deepEqual(await acquired.handle.release(), { released: false, reason: 'not_owner' });

  const second = await acquireRepositoryLock(lockOptions(workflow, fakeEnvironment()));
  await writeFile(workflow.ownerFile, 'garbage');
  assert.deepEqual(await second.handle.release(), { released: false, reason: 'not_owner' });
  assert.equal(await readFile(workflow.ownerFile, 'utf8'), 'garbage');
});

test('withRepositoryLock runs the critical section under the lock and releases after success', async (t) => {
  const workflow = await createLockWorkflow(t);
  const environment = fakeEnvironment();
  let seen = null;
  const outcome = await withRepositoryLock(lockOptions(workflow, environment), async (handle) => {
    seen = await readOwnerFile(workflow);
    assert.equal(handle.run_id, seen.run_id);
    return 'result-value';
  });

  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.value, 'result-value');
  assert.deepEqual(outcome.release, { released: true });
  assert.equal(outcome.lock_path, '.ops/lock');
  assert.equal(outcome.recovered, null);
  assert.equal(seen.run_id, ulid(1));
  assert.deepEqual(await listDirectory(workflow.opsDir), []);
});

test('withRepositoryLock releases when the critical section throws and rethrows the same error', async (t) => {
  const workflow = await createLockWorkflow(t);
  const failure = new Error('handled failure');
  await assert.rejects(
    withRepositoryLock(lockOptions(workflow, fakeEnvironment()), async () => { throw failure; }),
    (error) => error === failure,
  );
  assert.deepEqual(await listDirectory(workflow.opsDir), []);
  const next = await acquireRepositoryLock(lockOptions(workflow, fakeEnvironment()));
  assert.equal(next.status, 'acquired');
  await next.handle.release();
});

test('withRepositoryLock does not run the critical section when the lock is blocked', async (t) => {
  const workflow = await createLockWorkflow(t);
  const holder = await acquireRepositoryLock(lockOptions(workflow, fakeEnvironment()));
  let ran = false;
  const outcome = await withRepositoryLock(
    lockOptions(workflow, fakeEnvironment(), { timeoutMs: 30, retryMs: 10 }),
    async () => { ran = true; },
  );
  assert.equal(ran, false);
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.finding.code, 'AKRS-C009');
  assert.equal(outcome.holder.run_id, ulid(1));
  await holder.handle.release();
});

test('breakLock refuses a wrong run ID and removes the lock for the right one', async (t) => {
  const workflow = await createLockWorkflow(t);
  await writeLock(workflow, validOwner({ run_id: ulid(42), host: 'elsewhere' }));
  const bytes = await readFile(workflow.ownerFile, 'utf8');

  const refused = await breakLock({ workflowRoot: workflow.options.workflowRoot, expectedRunId: ulid(43) });
  assert.deepEqual(refused, { status: 'refused', reason: 'owner_mismatch', holder: {
    pid: 4242, host: 'elsewhere', run_id: ulid(42), command: 'road finish', acquired_at: '2000-01-01T00:00:00.000Z',
  } });
  assert.equal(await readFile(workflow.ownerFile, 'utf8'), bytes);

  const removed = await breakLock({
    repositoryRoot: workflow.options.repositoryRoot,
    workflowRoot: workflow.options.workflowRoot,
    expectedRunId: ulid(42),
  });
  assert.equal(removed.status, 'removed');
  assert.equal(removed.holder.run_id, ulid(42));
  assert.equal(JSON.stringify(removed).includes(workflow.root), false);
  assert.deepEqual(await listDirectory(workflow.opsDir), []);

  const next = await acquireRepositoryLock(lockOptions(workflow, fakeEnvironment()));
  assert.equal(next.status, 'acquired');
  await next.handle.release();
});

test('breakLock also removes the recovery claim of the owner it breaks, and only that one', async (t) => {
  const workflow = await createLockWorkflow(t);
  await writeLock(workflow, validOwner({ run_id: ulid(42) }));
  await mkdir(workflow.path('akrs', '.ops', `lock.recover-${ulid(42)}`));
  await mkdir(workflow.path('akrs', '.ops', `lock.recover-${ulid(41)}`));

  const removed = await breakLock({ workflowRoot: workflow.options.workflowRoot, expectedRunId: ulid(42) });
  assert.equal(removed.status, 'removed');
  assert.deepEqual(await listDirectory(workflow.opsDir), [`lock.recover-${ulid(41)}`]);
});

test('breakLock with no lock is refused, and a non-ULID expected run ID is a usage error', async (t) => {
  const workflow = await createLockWorkflow(t);
  assert.deepEqual(
    await breakLock({ workflowRoot: workflow.options.workflowRoot, expectedRunId: ulid(1) }),
    { status: 'refused', reason: 'no_lock', holder: null },
  );
  await assert.rejects(breakLock({ workflowRoot: workflow.options.workflowRoot, expectedRunId: 'nope' }), TypeError);
  await assert.rejects(breakLock({ workflowRoot: workflow.options.workflowRoot }), TypeError);
});

test('breakLock with a null run ID removes only a lock whose owner stays unreadable', async (t) => {
  const workflow = await createLockWorkflow(t);
  const options = { workflowRoot: workflow.options.workflowRoot, expectedRunId: null, sleep: fakeEnvironment().sleep };

  // A readable owner must be named by its run ID.
  await writeLock(workflow, validOwner());
  assert.deepEqual(
    (await breakLock(options)).reason,
    'owner_valid',
  );
  assert.equal((await readOwnerFile(workflow)).run_id, ulid(900));

  // A named run ID cannot break an unreadable owner.
  await writeLock(workflow, undefined, { raw: '{ broken' });
  const named = await breakLock({ ...options, expectedRunId: ulid(900) });
  assert.deepEqual(named, { status: 'refused', reason: 'owner_unreadable', holder: null });
  assert.equal(await readFile(workflow.ownerFile, 'utf8'), '{ broken');

  const removed = await breakLock(options);
  assert.deepEqual(removed, { status: 'removed', holder: null });
  assert.deepEqual(await listDirectory(workflow.opsDir), []);
});

test('breakLock does not break a lock that becomes readable while it settles', async (t) => {
  const workflow = await createLockWorkflow(t);
  await mkdir(workflow.lockDir, { recursive: true });
  const live = validOwner({ run_id: ulid(5) });
  const refused = await breakLock({
    workflowRoot: workflow.options.workflowRoot,
    expectedRunId: null,
    // The acquirer finishes writing its owner record while the human waits.
    sleep: async () => { await writeFile(workflow.ownerFile, `${JSON.stringify(live, null, 2)}\n`); },
  });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.reason, 'owner_valid');
  assert.deepEqual(await readOwnerFile(workflow), live);
  assert.equal((await readLockOwner(workflow.options)).status, 'valid');
});
