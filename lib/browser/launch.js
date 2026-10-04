// Starts one browser, connects CDP to it and guarantees its end: Browser.close, then the whole process tree, then the temp
// profile. A browser started here never outlives the call, whatever happened inside it.
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowListedEnvironment } from '../store/verify/runner.js';
import { CdpConnection, pipeTransport, webSocketTransport } from './cdp.js';
import { BROWSER_POLICY } from './policy.js';

const { timeouts } = BROWSER_POLICY;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function browserFlags({ profileDir, transport, noSandbox }) {
  return [
    ...BROWSER_POLICY.flags,
    ...(noSandbox ? [BROWSER_POLICY.sandbox.flag] : []),
    `--user-data-dir=${profileDir}`,
    transport === 'port' ? '--remote-debugging-port=0' : '--remote-debugging-pipe',
  ];
}

export function needsNoSandbox({ platform, isRoot, inContainer, env }) {
  if (platform !== 'linux') return false;
  return isRoot || inContainer || env.AKRS_BROWSER_NO_SANDBOX === '1';
}

const hostFacts = (env) => ({
  isRoot: typeof process.getuid === 'function' && process.getuid() === 0,
  inContainer: existsSync('/.dockerenv') || (typeof env.container === 'string' && env.container !== ''),
});

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // the group is already gone
  }
}

function taskkill(pid) {
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.on('error', resolve);
    killer.on('close', resolve);
  });
}

async function portTransport(profileDir, deadlineMs) {
  const file = join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const [port, path] = (await readFile(file, 'utf8')).split('\n');
      if (port !== '' && path !== undefined && path !== '') {
        const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
        await new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve, { once: true });
          socket.addEventListener('error', () => reject(new Error('the browser WebSocket did not open')), { once: true });
        });
        return webSocketTransport(socket);
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !/WebSocket/.test(error.message)) throw error;
    }
    if (Date.now() > deadline) throw new Error('the browser did not publish its debugging port');
    await sleep(50);
  }
}

// options: { executable, leadingArgs?, env, platform, transport?, connect?(child, profileDir), closeWaitMs?, graceMs?, tmpRoot?, noSandbox?, timeoutMs? }
// -> { ok: true, conn, child, profile_dir, transport, teardown() } | { ok: false, reason: 'launch_failed', message, profile_dir }
export async function launchBrowser(options) {
  const {
    executable, leadingArgs = [], env = process.env, platform = process.platform, closeWaitMs = timeouts.close_wait_ms, tmpRoot = tmpdir(),
    startMs = timeouts.start_ms, timeoutMs = timeouts.default_ms,
  } = options;
  const transport = options.transport ?? (env.AKRS_BROWSER_TRANSPORT === 'port' ? 'port' : 'pipe');
  const noSandbox = options.noSandbox ?? needsNoSandbox({ platform, env, ...hostFacts(env) });
  const profileDir = await mkdtemp(join(tmpRoot, BROWSER_POLICY.profile.prefix));
  const removeProfile = () => rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  const lastResort = () => {
    if (child?.pid !== undefined && platform !== 'win32') signalGroup(child.pid, 'SIGKILL');
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // best effort at exit
    }
  };
  let child = null;
  let conn = null;
  let exited = false;
  let teardownPromise = null;
  process.once('exit', lastResort);

  const teardown = () => {
    teardownPromise ??= (async () => {
      let termination = 'closed';
      if (child?.pid !== undefined) {
        if (conn !== null && !conn.closed) await conn.send('Browser.close', {}, { timeoutMs: 1000 }).catch(() => {});
        const deadline = Date.now() + closeWaitMs;
        while (!exited && Date.now() < deadline) await sleep(20);
        if (!exited) {
          termination = 'forced';
          if (platform === 'win32') await taskkill(child.pid);
        }
        // helpers of the browser (renderers, GPU) live in its group: end them whether or not the leader is gone
        if (platform !== 'win32') signalGroup(child.pid, 'SIGKILL');
        const settle = Date.now() + timeouts.grace_ms;
        while (!exited && Date.now() < settle) await sleep(20);
      } else {
        termination = 'none';
      }
      conn?.close();
      process.removeListener('exit', lastResort);
      await removeProfile();
      return { termination, profile_removed: !existsSync(profileDir), profile_dir: profileDir };
    })();
    return teardownPromise;
  };

  try {
    const args = [...leadingArgs, ...browserFlags({ profileDir, transport, noSandbox })];
    child = spawn(executable, args, {
      env: allowListedEnvironment(env, platform).env, shell: false, windowsHide: true, detached: platform !== 'win32',
      stdio: transport === 'pipe' ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'],
    });
    child.on('exit', () => { exited = true; });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (error) => reject(new Error(`cannot start ${executable}: ${error.code ?? error.message}`)));
    });
    let peer;
    if (options.connect !== undefined) peer = await options.connect(child, profileDir);
    else if (transport === 'pipe') peer = pipeTransport({ write: child.stdio[3], read: child.stdio[4] });
    else peer = await portTransport(profileDir, startMs);
    conn = new CdpConnection(peer, { timeoutMs });
    return { ok: true, conn, child, profile_dir: profileDir, transport, teardown };
  } catch (error) {
    if (child !== null && child.pid === undefined) exited = true;
    await teardown();
    return { ok: false, reason: 'launch_failed', message: error instanceof Error ? error.message : 'the browser could not be started', profile_dir: profileDir };
  }
}

// Runs work(conn, launched) against a fresh browser and always ends the browser.
// -> { ok: true, value, teardown } | { ok: false, reason: launch_failed|interrupted|browser_crashed|work_failed, message, teardown }
export async function withBrowser(options, work) {
  const { signal = null } = options;
  if (signal?.aborted) return { ok: false, reason: 'interrupted', message: 'interrupted before the browser started', teardown: null };
  const launched = await launchBrowser(options);
  if (!launched.ok) return { ...launched, teardown: { termination: 'none', profile_removed: !existsSync(launched.profile_dir), profile_dir: launched.profile_dir } };
  let onAbort;
  const interrupted = new Promise((resolve) => {
    onAbort = () => resolve('interrupted');
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  let outcome;
  try {
    const result = await Promise.race([work(launched.conn, launched).then((value) => ({ value })), interrupted.then(() => ({ interrupted: true }))]);
    outcome = result.interrupted ? { ok: false, reason: 'interrupted', message: 'interrupted' } : { ok: true, value: result.value };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'the work failed';
    outcome = { ok: false, reason: /connection closed/.test(message) ? 'browser_crashed' : 'work_failed', message };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return { ...outcome, teardown: await launched.teardown() };
}
