// Shared helpers for the P1-W03 repository lock tests: a temp workflow, a deterministic fake environment
// (clock, sleep, jitter, run IDs, process probe) and a child-process worker harness.
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { hostname as realHostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createTempRepository } from '../helpers/temp-repository.js';

export const WORKER = fileURLToPath(new URL('./fixtures/worker.js', import.meta.url));
export const OWNER_SCHEMA = 'akrs.lock-owner/v1';

// 26-character Crockford ULID with a numeric tail, so every n gives a distinct valid run ID.
export const ulid = (n) => `01ARZ3NDEKTSV4RRFFQ6${String(n).padStart(6, '0')}`;

export async function createLockWorkflow(testContext) {
  const repository = await createTempRepository(testContext, { prefix: 'akrs-lock-' });
  await mkdir(repository.path('akrs'), { recursive: true });
  return {
    ...repository,
    options: { repositoryRoot: repository.root, workflowRoot: repository.path('akrs') },
    opsDir: repository.path('akrs', '.ops'),
    lockDir: repository.path('akrs', '.ops', 'lock'),
    ownerFile: repository.path('akrs', '.ops', 'lock', 'owner.json'),
  };
}

export function validOwner(overrides = {}) {
  return {
    schema: OWNER_SCHEMA,
    pid: 4242,
    host: 'test-host',
    run_id: ulid(900),
    command: 'road finish',
    acquired_at: '2000-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// Writes a lock directory by hand: the owner record is `owner` (an object, rendered as JSON), raw text, or absent.
export async function writeLock(workflow, owner = validOwner(), { raw } = {}) {
  await mkdir(workflow.lockDir, { recursive: true });
  if (raw !== undefined) await writeFile(workflow.ownerFile, raw);
  else if (owner !== null) await writeFile(workflow.ownerFile, `${JSON.stringify(owner, null, 2)}\n`);
}

export async function readOwnerFile(workflow) {
  return JSON.parse(await readFile(workflow.ownerFile, 'utf8'));
}

export async function listDirectory(path) {
  return (await readdir(path)).sort();
}

// Deterministic time and process environment. `sleep` advances the clock, so waiting is instant and exact.
export function fakeEnvironment({
  start = '2026-10-03T10:00:00.000Z',
  host = 'test-host',
  alive = () => true,
  onSleep = async () => {},
  random = () => 0.5,
} = {}) {
  let now = Date.parse(start);
  let counter = 0;
  const sleeps = [];
  const probes = [];
  const environment = {
    sleeps,
    probes,
    clock: () => new Date(now),
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
      await onSleep(sleeps.length, ms);
    },
    random,
    runId: () => ulid(++counter),
    hostname: () => host,
    isProcessAlive: async (pid) => {
      probes.push(pid);
      return alive(pid);
    },
    advance(ms) { now += ms; },
    get now() { return new Date(now).toISOString(); },
  };
  return environment;
}

export const hostName = () => realHostname();

// Collects stdout lines of a child so a test can await "ready" style handshakes.
export function startWorker(config) {
  const child = spawn(process.execPath, [WORKER, JSON.stringify(config)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  const waiting = [];
  const lines = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const waiter = waiting.shift();
      if (waiter) waiter(line);
      else lines.push(line);
      index = buffer.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolveClosed, rejectClosed) => {
    child.on('error', rejectClosed);
    child.on('close', (exitCode, signal) => resolveClosed({ exitCode, signal, stdout, stderr }));
  });
  return {
    child,
    closed,
    nextLine: () => new Promise((resolveLine) => {
      if (lines.length > 0) resolveLine(lines.shift());
      else waiting.push(resolveLine);
    }),
    async kill() {
      child.kill('SIGKILL');
      return closed;
    },
  };
}

export async function runWorker(config) {
  const worker = startWorker(config);
  const outcome = await worker.closed;
  const last = outcome.stdout.trim().split('\n').filter(Boolean).at(-1);
  return { ...outcome, result: last === undefined ? null : JSON.parse(last) };
}
