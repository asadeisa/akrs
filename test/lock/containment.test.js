// P1-W03 / F7: containment under the workflow root, and the lock staying invisible to snapshots.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PathSafetyError } from '../../lib/store/path-service.js';
import { WORKFLOW_PROJECTION, computeSnapshot } from '../../lib/store/snapshots/index.js';
import {
  acquireRepositoryLock,
  breakLock,
  readLockOwner,
} from '../../lib/store/lock/index.js';
import { createWorkflow } from '../snapshots/support.js';
import {
  createLockWorkflow,
  fakeEnvironment,
  listDirectory,
  ulid,
  validOwner,
} from './support.js';

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

async function outsideDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'akrs-lock-outside-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const acquire = (workflow, extra = {}) => acquireRepositoryLock({
  ...workflow.options, command: 'x', runId: fakeEnvironment().runId, timeoutMs: 20, retryMs: 10, ...extra,
});

test('.ops as a symlink or junction to a directory outside the repository is refused and nothing is created there', async (t) => {
  const workflow = await createLockWorkflow(t);
  const outside = await outsideDirectory(t);
  await symlink(outside, workflow.opsDir, LINK_TYPE);

  await assert.rejects(acquire(workflow), PathSafetyError);
  await assert.rejects(readLockOwner(workflow.options), PathSafetyError);
  await assert.rejects(
    breakLock({ workflowRoot: workflow.options.workflowRoot, expectedRunId: ulid(1) }),
    PathSafetyError,
  );
  assert.deepEqual(await listDirectory(outside), []);
});

test('.ops linking to a directory inside the repository but outside the workflow root is refused', async (t) => {
  const workflow = await createLockWorkflow(t);
  const sibling = workflow.path('elsewhere');
  await mkdir(sibling);
  await symlink(sibling, workflow.opsDir, LINK_TYPE);

  await assert.rejects(acquire(workflow), PathSafetyError);
  assert.deepEqual(await listDirectory(sibling), []);
});

test('.ops linking to a directory inside the workflow root is still refused: the lock never follows links', async (t) => {
  const workflow = await createLockWorkflow(t);
  const inside = workflow.path('akrs', 'real-ops');
  await mkdir(inside);
  await symlink(inside, workflow.opsDir, LINK_TYPE);

  await assert.rejects(acquire(workflow), PathSafetyError);
  assert.deepEqual(await listDirectory(inside), []);
});

test('.ops/lock as a pre-existing link to an outside directory is refused and not followed', async (t) => {
  const workflow = await createLockWorkflow(t);
  const outside = await outsideDirectory(t);
  await writeFile(join(outside, 'owner.json'), `${JSON.stringify(validOwner(), null, 2)}\n`);
  await mkdir(workflow.opsDir);
  await symlink(outside, workflow.lockDir, LINK_TYPE);

  await assert.rejects(acquire(workflow), PathSafetyError);
  await assert.rejects(readLockOwner(workflow.options), PathSafetyError);
  await assert.rejects(
    breakLock({ workflowRoot: workflow.options.workflowRoot, expectedRunId: ulid(900) }),
    PathSafetyError,
  );
  assert.deepEqual(await listDirectory(outside), ['owner.json'], 'the outside directory is untouched');
});

test('a workflow root outside the repository root is refused', async (t) => {
  const workflow = await createLockWorkflow(t);
  const outside = await outsideDirectory(t);
  await assert.rejects(
    acquireRepositoryLock({
      repositoryRoot: workflow.options.workflowRoot, workflowRoot: outside, command: 'x',
    }),
    PathSafetyError,
  );
  assert.deepEqual(await listDirectory(outside), []);
});

test('lockRoot makes the lock reusable for another validated root directory', async (t) => {
  const root = await outsideDirectory(t);
  const result = await acquireRepositoryLock({ lockRoot: root, command: 'registry add', timeoutMs: 0 });
  assert.equal(result.status, 'acquired');
  assert.equal(result.lock_path, '.ops/lock');
  assert.deepEqual(await listDirectory(join(root, '.ops')), ['lock']);
  const blocked = await acquireRepositoryLock({ lockRoot: root, command: 'registry add', timeoutMs: 0 });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.holder.run_id, result.handle.run_id);
  assert.deepEqual(await result.handle.release(), { released: true });
  assert.deepEqual(await listDirectory(join(root, '.ops')), []);
});

test('taking, holding and recovering the lock never changes a workflow snapshot', async (t) => {
  const workflow = await createWorkflow(t, { omit: ['akrs/.ops/lock'] });
  const snapshot = () => computeSnapshot({
    ...workflow.options, projections: WORKFLOW_PROJECTION, target: {},
  });
  const released = await snapshot();
  assert.equal(released.status, 'ok');

  const environment = fakeEnvironment();
  const held = await acquireRepositoryLock({
    ...workflow.options,
    command: 'road finish',
    clock: environment.clock,
    runId: environment.runId,
  });
  assert.equal(held.status, 'acquired');
  const during = await snapshot();
  assert.deepEqual(during, released, 'snapshot and inventory are identical while the lock is held');

  const blocked = await acquireRepositoryLock({
    ...workflow.options, command: 'x', timeoutMs: 0, runId: environment.runId,
  });
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(await snapshot(), released);

  await held.handle.release();
  assert.deepEqual(await snapshot(), released, 'and identical again after release');
});
