// The process runner of `verify --road` (F12). It starts one declared argv array, bounds its time and output, ends its
// whole process tree on timeout or interruption and returns one captured result record. It never prints, never uses a
// shell and never reads or writes workflow files.
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { win32 } from 'node:path';
import { F12_POLICY } from './policy.js';

const { capture, termination } = F12_POLICY;
const DECODER = new TextDecoder('utf-8', { ignoreBOM: true });
const SAFE_BATCH_ARGUMENT = /^[A-Za-z0-9_@+=:,./\\-]+$/;
const BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);
const monotonicMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

// source environment -> { env, inherited }: only allow-listed names, matched case-insensitively on Windows.
export function allowListedEnvironment(source, platform = process.platform) {
  const windows = platform === 'win32';
  const allowed = new Set(F12_POLICY.environment.inherited);
  const env = {};
  const inherited = [];
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    if (allowed.has(windows ? name.toUpperCase() : name)) {
      env[name] = value;
      inherited.push(name);
    }
  }
  inherited.sort((left, right) => (left < right ? -1 : (left > right ? 1 : 0)));
  return { env: { ...env, ...F12_POLICY.environment.set }, inherited };
}

function findOnWindowsPath(name, env, exists) {
  const entries = Object.entries(env);
  const lookup = (key) => entries.find(([candidate]) => candidate.toUpperCase() === key)?.[1] ?? '';
  const extensions = (lookup('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter((entry) => entry !== '');
  const hasPath = /[\\/]/.test(name) || /^[A-Za-z]:/.test(name);
  const directories = hasPath ? [''] : lookup('PATH').split(';').filter((entry) => entry !== '');
  for (const directory of directories) {
    const base = directory === '' ? name : win32.join(directory, name);
    if (win32.extname(name) !== '' && exists(base)) return base;
    for (const extension of extensions) if (exists(`${base}${extension}`)) return `${base}${extension}`;
  }
  return null;
}

// -> { ok: true, file, args, windowsVerbatimArguments } | { ok: false, code, message }
export function planSpawn({ argv, platform = process.platform, env = process.env, exists = isFile }) {
  const direct = { ok: true, file: argv[0], args: argv.slice(1), windowsVerbatimArguments: false };
  if (platform !== 'win32') return direct;
  const found = findOnWindowsPath(argv[0], env, exists);
  if (found === null || !BATCH_EXTENSIONS.has(win32.extname(found).toLowerCase())) return found === null ? direct : { ...direct, file: found };
  const unsafe = argv.slice(1).findIndex((argument) => !SAFE_BATCH_ARGUMENT.test(argument));
  if (unsafe !== -1) {
    return { ok: false, code: 'unsafe_batch_argument', message: `argument ${unsafe + 1} of ${argv[0]} is not plain text, so it cannot be passed to a batch file without a shell guess` };
  }
  const quoted = /\s/.test(found) ? `"${found}"` : found;
  const line = [quoted, ...argv.slice(1)].join(' ');
  const comspec = Object.entries(env).find(([name]) => name.toUpperCase() === 'COMSPEC')?.[1] ?? 'cmd.exe';
  return { ok: true, file: comspec, args: ['/d', '/s', '/c', /\s/.test(found) ? `"${line}"` : line], windowsVerbatimArguments: true };
}

// Bounded capture of one stream: the first `cap` bytes and the last `tail` bytes, with the exact total.
class Capture {
  constructor() {
    this.first = Buffer.alloc(0);
    this.last = Buffer.alloc(0);
    this.total = 0;
  }

  add(chunk) {
    this.total += chunk.length;
    if (this.first.length < capture.stream_cap_bytes) {
      this.first = Buffer.concat([this.first, chunk.subarray(0, capture.stream_cap_bytes - this.first.length)]);
    }
    this.last = Buffer.concat([this.last, chunk]);
    if (this.last.length > capture.tail_bytes) this.last = this.last.subarray(this.last.length - capture.tail_bytes);
  }

  record() {
    if (this.total <= capture.stream_cap_bytes) return { text: DECODER.decode(this.first), tail: null, total_bytes: this.total, truncated: false };
    return {
      text: DECODER.decode(this.first.subarray(0, capture.head_bytes)),
      tail: DECODER.decode(this.last),
      total_bytes: this.total,
      truncated: true,
    };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emptyCapture = () => new Capture().record();

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // the group is already gone
  }
}

function forceEndTree(pid, platform) {
  if (platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', resolve);
      killer.on('close', resolve);
    });
  }
  signalGroup(pid, 'SIGKILL');
  return Promise.resolve();
}

const failedStart = (code, message) => ({
  status: 'spawn_failed', exit_code: null, signal: null, duration_ms: null, termination: 'none', error: { code, message }, stdout: emptyCapture(), stderr: emptyCapture(),
});

// options: { argv, cwd, timeoutMs, env?, platform?, clock?, graceMs?, waitAfterKillMs?, signal?, exists? }
// -> { status: passed|failed|timed_out|spawn_failed|interrupted, exit_code, signal, duration_ms, termination, error, stdout, stderr }
export async function runCheck(options) {
  const {
    argv, cwd, timeoutMs, env = process.env, platform = process.platform, clock = monotonicMs,
    graceMs = termination.grace_ms, waitAfterKillMs = termination.wait_after_kill_ms, signal = null, exists = isFile,
  } = options;
  const plan = planSpawn({ argv, platform, env, exists });
  if (!plan.ok) return failedStart(plan.code, plan.message);
  const childEnv = allowListedEnvironment(env, platform).env;
  const outputs = { stdout: new Capture(), stderr: new Capture() };

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(plan.file, plan.args, {
        cwd, env: childEnv, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: platform !== 'win32', windowsHide: true, windowsVerbatimArguments: plan.windowsVerbatimArguments,
      });
    } catch (error) {
      resolve(failedStart(error.code ?? 'SPAWN_FAILED', `cannot start ${argv[0]}: ${error.code ?? 'error'}`));
      return;
    }
    const startedAt = clock();
    let reason = null;
    let ended = false;
    let ending = null;
    let how = 'none';
    let timer = null;
    let unconfirmedTimer = null;
    const lastResort = () => {
      if (child.pid !== undefined && platform !== 'win32') signalGroup(child.pid, 'SIGKILL');
    };
    process.once('exit', lastResort);
    child.stdout.on('data', (chunk) => outputs.stdout.add(chunk));
    child.stderr.on('data', (chunk) => outputs.stderr.add(chunk));

    const finish = (exitCode, exitSignal, error = null) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      clearTimeout(unconfirmedTimer);
      if (reason !== null && how === 'none') how = platform === 'win32' ? 'forced' : 'graceful';
      process.removeListener('exit', lastResort);
      signal?.removeEventListener('abort', onAbort);
      const started = error === null;
      let status = 'failed';
      if (error !== null) status = 'spawn_failed';
      else if (reason === 'timeout') status = 'timed_out';
      else if (reason === 'interrupt') status = 'interrupted';
      else if (exitCode === 0 && exitSignal === null) status = 'passed';
      resolve({
        status,
        exit_code: exitCode,
        signal: exitSignal,
        duration_ms: started ? Math.max(0, Math.round(clock() - startedAt)) : null,
        termination: how,
        error,
        stdout: outputs.stdout.record(),
        stderr: outputs.stderr.record(),
      });
    };

    // Ends the tree: polite first on POSIX, then forced; resolves through the normal close/finish path.
    const endTree = (why) => {
      if (reason !== null || ended) return;
      reason = why;
      ending = (async () => {
        if (platform === 'win32') {
          how = 'forced';
          await forceEndTree(child.pid, platform);
        } else {
          signalGroup(child.pid, 'SIGTERM');
          const deadline = Date.now() + graceMs;
          while (Date.now() < deadline && groupAlive(child.pid)) await sleep(20);
          if (groupAlive(child.pid)) {
            how = 'forced';
            await forceEndTree(child.pid, platform);
          } else {
            how = 'graceful';
          }
        }
        unconfirmedTimer = setTimeout(() => {
          if (ended) return;
          how = 'unconfirmed';
          child.stdout.destroy();
          child.stderr.destroy();
          finish(null, null);
        }, waitAfterKillMs);
      })();
    };
    function onAbort() {
      endTree('interrupt');
    }
    child.on('error', (error) => {
      if (child.pid !== undefined) return;
      finish(null, null, { code: error.code ?? 'SPAWN_FAILED', message: `cannot start ${argv[0]}: ${error.code ?? 'error'}` });
    });
    child.on('close', (exitCode, exitSignal) => {
      if (reason !== null && platform !== 'win32' && child.pid !== undefined && groupAlive(child.pid)) {
        // the leader is gone but a member of its group is not: the end sequence is still running and decides
        ending?.then(() => finish(exitCode, exitSignal));
        return;
      }
      finish(exitCode, exitSignal);
    });
    timer = setTimeout(() => endTree('timeout'), timeoutMs);
    if (signal !== null) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
