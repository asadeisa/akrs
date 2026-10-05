// Shared helpers for the P2-W12 intent tests: worlds built through the real writers (executors, a Plan, a DONE dependency and an ACTIVE weak
// Road in a git repository) and the intent calls. EVERY call goes through `intent()`, which refuses an argument that is a hash, a snapshot flag
// or a request ID: the contract check of the packet (Workers never type bookkeeping) is enforced by the helper, not by discipline.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readLease } from '../../lib/store/leases/index.js';
import { everything, strict } from '../change/support.js';
import { commitAll, git, lifecycleWorld, put, statusOf, closures, PASSING, FAILING, nodeCheck } from '../road-lifecycle/support.js';
import { fakeProviders } from '../idempotency/support.js';
import { runCommand, seedRoad, treeDigest } from '../road/support.js';
import { setExec } from '../road-fit/support.js';

export { FAILING, PASSING, closures, commitAll, everything, fakeProviders, git, nodeCheck, put, runCommand, seedRoad, statusOf, strict, treeDigest };
export const GUARD_BIN = fileURLToPath(new URL('../../bin/akrs-guard.js', import.meta.url));
export const ROAD = 'R-P6-1';
export const FLASH2 = Object.freeze({ id: 'flash2', role: 'worker', class: 'weak', label: 'Flash 2', user_answer: 'weak' });

const BOOKKEEPING = ['--if-snapshot', '--request-id'];

// One CLI call through the real adapter. Returns { exitCode, stdout, stderr, packet }.
export async function intent(repo, argv, options = {}) {
  for (const argument of argv) {
    assert.ok(!BOOKKEEPING.includes(argument), `the intent contract: ${argument} is bookkeeping the CLI does itself`);
    assert.ok(!String(argument).includes('sha256:'), 'the intent contract: no hash or snapshot is ever an argument');
  }
  const result = await runCommand(repo, [...argv, '--json'], { providers: repo.providers, ...options });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, packet: result.stdout === '' ? null : JSON.parse(result.stdout) };
}

export const work = (repo, args = [], options) => intent(repo, ['work', '--executor', 'flash', ...args], options);
export const done = (repo, args = [], options) => intent(repo, [
  'done', ROAD, '--executor', 'flash', '--result', 'the admin page is ready', '--reach', 'open /admin', '--expect', 'a table of users', ...args,
], options);
export const yieldRoad = (repo, args = [], options) => intent(repo, ['yield', ROAD, '--executor', 'flash', '--reason', 'it needs the payment module as well', ...args], options);

// The ACTIVE weak Road in a git repository (committed baseline), plus a second weak Worker so a lease can be contested.
export async function workWorld(t, { second = true, ...options } = {}) {
  const { repo, road } = await lifecycleWorld(t, { status: 'ACTIVE', git: true, ...options });
  if (second) {
    assert.equal((await setExec(repo, FLASH2)).outcome, 'committed');
    if (options.git !== false) commitAll(repo);
  }
  return { repo, road };
}

// What the Worker does between `work` and `done`: its own edits inside the declared writes.
export async function edit(repo) {
  await put(repo, 'src/own.js', 'after\n');
  await put(repo, 'src/admin.js', 'new\n');
}

export const leaseOf = async (repo, road = ROAD) => {
  const read = await readLease({ ...repo.options, kind: 'road', target: road });
  return read.status === 'held' ? read.lease : null;
};
export const guardFileOf = async (repo, road = ROAD) => {
  try {
    return JSON.parse(await readFile(repo.path(`akrs/.ops/leases/${road}.guard.json`), 'utf8'));
  } catch {
    return null;
  }
};

// Runs bin/akrs-guard.js in a child process like a hook would: -> { code, stdout, stderr, ms }
export function runGuard(repo, args, { stdin = null, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(process.execPath, [GUARD_BIN, ...args], { cwd: repo.root, env: { ...process.env, AKRS_EXECUTOR: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
    if (stdin !== null) child.stdin.write(stdin);
    child.stdin.end();
  });
}

export const codesOf = (packet) => [...new Set(packet.findings.map(({ code }) => code))].sort();
export const reasonsOf = (packet, code = 'AKRS-R025') => packet.findings.filter((finding) => finding.code === code).map(({ detail }) => detail.reason).sort();

// A further Road of Plan P6 (ACTIVE and weak unless said otherwise) with its own write.
export const addRoad = (repo, id, { status = 'ACTIVE', ...overrides } = {}) => seedRoad(repo, {
  id, plan: 'P6', task: null, deps: [], reads: [], writes: [{ path: `src/${id}.js`, class: 'file', action: 'create' }], forbidden: [], checks: [PASSING], executor_class: 'weak', ...overrides,
}, { folder: 'roads/P6', status });
