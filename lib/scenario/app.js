// The app under test: started from the contract argv (no shell, own process group), waited for until it answers, and always
// ended with its whole tree. Output is captured under the F12 caps. Nothing here prints or writes a file.
import { spawn } from 'node:child_process';
import { F12_POLICY } from '../store/verify/policy.js';
import { Capture, allowListedEnvironment, forceEndTree, groupAlive, planSpawn, signalGroup } from '../store/verify/runner.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const POLL_MS = 100;
const DEFAULT_READY_MS = 30000;
const WAIT_AFTER_KILL_MS = F12_POLICY.termination.wait_after_kill_ms;

// options: { argv, cwd, env, platform, launchUrl, ready: { url, status, timeout_ms } | null, signal?, graceMs?, fetchImpl?, onFact? }
// -> { ok: true, app: { stop(), output(), pid }, ready_ms }
//  | { ok: false, reason: spawn_failed|exited_early|ready_timeout|interrupted, message, output }
export async function startApp(options) {
  const {
    argv, cwd, env = process.env, platform = process.platform, launchUrl, ready = null, signal = null, graceMs = F12_POLICY.termination.grace_ms, fetchImpl = fetch,
  } = options;
  const emptyOutput = () => ({ stdout: new Capture().record(), stderr: new Capture().record() });
  const plan = planSpawn({ argv, platform, env });
  if (!plan.ok) return { ok: false, reason: 'spawn_failed', message: plan.message, output: emptyOutput() };
  const outputs = { stdout: new Capture(), stderr: new Capture() };
  const child = spawn(plan.file, plan.args, {
    cwd, env: allowListedEnvironment(env, platform).env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: platform !== 'win32', windowsHide: true, windowsVerbatimArguments: plan.windowsVerbatimArguments,
  });
  child.stdout.on('data', (chunk) => outputs.stdout.add(chunk));
  child.stderr.on('data', (chunk) => outputs.stderr.add(chunk));
  const output = () => ({ stdout: outputs.stdout.record(), stderr: outputs.stderr.record() });
  const started = await new Promise((resolve) => {
    child.once('spawn', () => resolve(null));
    child.once('error', (error) => resolve(error));
  });
  if (started !== null) return { ok: false, reason: 'spawn_failed', message: `cannot start ${argv[0]}: ${started.code ?? 'error'}`, output: emptyOutput() };

  let exit = null;
  child.on('exit', (code, exitSignal) => { exit = { code, signal: exitSignal }; });
  const lastResort = () => {
    if (platform !== 'win32' && child.pid !== undefined) signalGroup(child.pid, 'SIGKILL');
  };
  process.once('exit', lastResort);

  let stopping = null;
  const stop = () => {
    stopping ??= (async () => {
      let termination = 'graceful';
      if (platform === 'win32') {
        if (exit === null) await forceEndTree(child.pid, platform);
        termination = 'forced';
      } else {
        signalGroup(child.pid, 'SIGTERM');
        const deadline = Date.now() + graceMs;
        while (Date.now() < deadline && groupAlive(child.pid)) await sleep(20);
        if (groupAlive(child.pid)) {
          termination = 'forced';
          await forceEndTree(child.pid, platform);
        }
      }
      const settle = Date.now() + WAIT_AFTER_KILL_MS;
      while (exit === null && Date.now() < settle) await sleep(20);
      process.removeListener('exit', lastResort);
      return { termination };
    })();
    return stopping;
  };
  const failed = async (reason, message) => {
    await stop();
    return { ok: false, reason, message, output: output() };
  };

  const target = ready?.url ?? launchUrl;
  const wanted = ready?.status ?? null;
  const limit = ready?.timeout_ms ?? DEFAULT_READY_MS;
  const startedAt = Date.now();
  for (;;) {
    if (signal?.aborted) return failed('interrupted', 'interrupted while waiting for the app');
    if (exit !== null) {
      return failed('exited_early', exit.code === null ? `the app was ended by signal ${exit.signal} before it answered` : `the app exited with code ${exit.code} before it answered`);
    }
    try {
      const response = await fetchImpl(target, { redirect: 'manual', signal: AbortSignal.timeout(1000) });
      if (wanted === null || response.status === wanted) {
        return { ok: true, app: { stop, output, pid: child.pid }, ready_ms: Date.now() - startedAt };
      }
    } catch {
      // not listening yet
    }
    if (Date.now() - startedAt >= limit) return failed('ready_timeout', `${target} did not answer${wanted === null ? '' : ` ${wanted}`} within ${limit} ms`);
    await sleep(POLL_MS);
  }
}
