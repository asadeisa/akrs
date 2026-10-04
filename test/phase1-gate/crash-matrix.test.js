// Phase-1 gate 8 (and the crash half of A1 gate 15): every protected multi-file mutation, driven through its REAL writer,
// is SIGKILLed in a separate process after EVERY transaction boundary. The next invocation must find the workflow either
// completely old (before the commit marker) or completely new (from it on); the journal must agree, and a retry of the
// same request must leave exactly one application (a noop replay once the commit marker was durable).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readOp } from '../../lib/store/journal/index.js';
import { readLockOwner } from '../../lib/store/lock/index.js';
import { recoverTransactions } from '../../lib/store/transactions/index.js';
import { commandManifest } from '../../lib/commands/manifest.js';
import { createTempRepository } from '../helpers/temp-repository.js';
import { createRepo, treeDigest as digest } from '../road/support.js';
import { pool } from '../transactions/support.js';
import { CASES, CASE_IDS, GATE_REQUEST_ID, repoAt } from './cases.js';

const WORKER = fileURLToPath(new URL('./worker.js', import.meta.url));
const SLOW = { timeout: 600_000 };
const RETRY_FIRST_ID = 20_000;
const KNOWN = commandManifest.commands.map(({ id }) => id);

async function freshRepo(t, id) {
  const repo = CASES[id].emptyWorkflow === true
    ? { ...(await createTempRepository(t, { prefix: 'akrs-gate-' })) }
    : await createRepo(t);
  const full = { ...repo, ...repoAt(repo.root), digest: undefined };
  full.options = { repositoryRoot: repo.root, workflowRoot: repo.path('akrs') };
  await CASES[id].seed(full);
  full.extra = await CASES[id].prepare?.(full) ?? {};
  return full;
}

const runChild = (config) => new Promise((resolveClosed, rejectClosed) => {
  const child = spawn(process.execPath, [WORKER, JSON.stringify(config)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', rejectClosed);
  child.on('close', (exitCode, signal) => resolveClosed({ exitCode, signal, stdout, stderr }));
});

// The workflow tree of a case; files the mutation writes outside it are compared on their own.
const treeDigest = (repo, id) => digest(repo, { exclude: ['akrs/.ops', '.git', ...(CASES[id].outside ?? [])] });
const outsideBytes = async (repo, id) => Object.fromEntries(await Promise.all((CASES[id].outside ?? []).map(async (path) => [path, await repo.read(path).catch(() => null)])));

const listing = (path) => readdir(path).catch(() => []);

for (const id of CASE_IDS) {
  test(`${CASES[id].command}: killed after every transaction boundary, recovers to a complete old or new state`, SLOW, async (t) => {
    // census + reference trees from clean runs of the real writer
    const census = [];
    const oldRepo = await freshRepo(t, id);
    const oldTree = await treeDigest(oldRepo, id);
    const reference = await freshRepo(t, id);
    const clean = await CASES[id].run(reference, { ...reference.extra, boundary: ({ point, index }) => { census.push({ point, index: index ?? null }); } });
    assert.equal(clean.outcome, 'committed', `${id}: the clean run commits`);
    const newTree = await treeDigest(reference, id);
    // what a retry (fresh run, new record IDs, same request ID) leaves after a rolled-back attempt
    const retried = await freshRepo(t, id);
    assert.equal((await CASES[id].run(retried, { ...retried.extra, firstId: RETRY_FIRST_ID })).outcome, 'committed');
    const retryTree = await treeDigest(retried, id);
    assert.notEqual(newTree, oldTree, `${id}: the mutation changes the tree`);
    const newOutside = await outsideBytes(reference, id);
    const commitAt = census.findIndex(({ point }) => point === 'commit_marker');
    assert.ok(commitAt > 0 && census.length > commitAt + 1, `${id}: boundaries ${census.map(({ point }) => point).join(',')}`);

    await pool(census.map((_, killAt) => async () => {
      const repo = await freshRepo(t, id);
      const label = `${id} killed after boundary ${killAt} (${census[killAt].point})`;
      const child = await runChild({ caseId: id, root: repo.root, killAt, extra: repo.extra });
      assert.equal(child.stdout.includes('"completed"'), false, `${label}: the worker must not finish (${child.stdout}${child.stderr})`);
      if (process.platform !== 'win32') assert.equal(child.signal, 'SIGKILL', `${label}: ${child.stderr}`);

      // recovery alone (no new mutation) must reach a complete old or new state
      const recovered = await recoverTransactions({ ...repo.options, knownCommands: KNOWN, lockOptions: { timeoutMs: 20_000, retryMs: 5 } });
      assert.equal(recovered.status, 'ok', `${label}: ${JSON.stringify(recovered.findings)}`);
      const forward = killAt >= commitAt;
      assert.equal(await treeDigest(repo, id), forward ? newTree : oldTree, `${label}: complete ${forward ? 'new' : 'old'} state`);
      assert.deepEqual(await listing(repo.path('akrs', '.ops', 'tx')), [], `${label}: no scratch left`);
      assert.equal((await readLockOwner(repo.options)).status, 'absent', `${label}: lock released`);

      for (const [path, bytes] of Object.entries(await outsideBytes(repo, id))) {
        assert.ok(bytes === null || bytes === newOutside[path], `${label}: ${path} is absent or exactly the committed block`);
      }

      // a retry of the same request applies exactly once
      const fresh = forward && CASES[id].forwardRetry === 'fresh_request';
      const retry = await CASES[id].run(repo, { ...repo.extra, firstId: RETRY_FIRST_ID, freshRequest: fresh });
      if (fresh) assert.notEqual(retry.outcome, 'conflict', `${label}: a fresh request is not a conflict`);
      else assert.equal(retry.outcome, forward ? 'replayed' : 'committed', `${label}: retry outcome`);
      assert.equal(await treeDigest(repo, id), forward ? newTree : retryTree, `${label}: applied exactly once`);
      if (!fresh) assert.equal((await readOp({ ...repo.options, requestId: GATE_REQUEST_ID })).status, 'committed', `${label}: journal committed`);
    }));
  });
}
