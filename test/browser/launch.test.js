// P2-W13: launch flags, the Linux sandbox rule and the teardown contract: the temp profile and the whole process tree are
// gone after success, failure, timeout and interruption. The "browser" is a real process (node) that starts a helper of
// its own, so tree removal is observed for real; the CDP conversation is the fake peer.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { browserFlags, launchBrowser, needsNoSandbox, withBrowser } from '../../lib/browser/launch.js';
import { BROWSER_POLICY } from '../../lib/browser/policy.js';
import { FakeTransport } from './support.js';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const until = async (check, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
};

// A stand-in browser: records its pid and its helper's pid, then idles until it is killed.
async function standIn(t) {
  const directory = await mkdtemp(join(tmpdir(), 'akrs-standin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'browser.mjs');
  const pids = join(directory, 'pids.json');
  await writeFile(script, `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ browser: process.pid, helper: helper.pid }));
    setInterval(() => {}, 1000);
  `);
  return { script, pids, directory };
}

async function launchStandIn(t, extra = {}, respond = () => undefined) {
  const world = await standIn(t);
  const launched = await launchBrowser({
    executable: process.execPath, leadingArgs: [world.script], env: process.env, platform: process.platform, closeWaitMs: 300, graceMs: 100,
    connect: (child) => new FakeTransport((message) => respond(message, child)), ...extra,
  });
  assert.equal(launched.ok, true, JSON.stringify(launched));
  assert.equal(await until(() => existsSync(world.pids)), true, 'the stand-in did not start');
  const ids = JSON.parse(await readFile(world.pids, 'utf8'));
  return { launched, ids, world };
}

test('the headless flags are frozen: temp profile, pipe transport, no first-run noise', () => {
  const flags = browserFlags({ profileDir: '/tmp/p', transport: 'pipe', noSandbox: false });
  for (const flag of ['--headless', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--user-data-dir=/tmp/p', '--remote-debugging-pipe']) {
    assert.ok(flags.includes(flag), flag);
  }
  assert.ok(!flags.includes('--no-sandbox'));
  assert.ok(!flags.some((flag) => flag.startsWith('--remote-debugging-port')));
});

test('port mode asks for an ephemeral port and --no-sandbox is added only when told', () => {
  const flags = browserFlags({ profileDir: '/tmp/p', transport: 'port', noSandbox: true });
  assert.ok(flags.includes('--remote-debugging-port=0') && flags.includes('--no-sandbox'));
  assert.ok(!flags.includes('--remote-debugging-pipe'));
});

test('--no-sandbox is needed only on Linux as root, in a container, or when asked for explicitly', () => {
  const base = { platform: 'linux', isRoot: false, inContainer: false, env: {} };
  assert.equal(needsNoSandbox(base), false);
  assert.equal(needsNoSandbox({ ...base, isRoot: true }), true);
  assert.equal(needsNoSandbox({ ...base, inContainer: true }), true);
  assert.equal(needsNoSandbox({ ...base, env: { AKRS_BROWSER_NO_SANDBOX: '1' } }), true);
  assert.equal(needsNoSandbox({ ...base, env: { AKRS_BROWSER_NO_SANDBOX: '0' } }), false);
  for (const platform of ['win32', 'darwin']) assert.equal(needsNoSandbox({ ...base, platform, isRoot: true, inContainer: true, env: { AKRS_BROWSER_NO_SANDBOX: '1' } }), false, platform);
});

test('the frozen policy names the transport, the timeouts and the evidence naming', () => {
  assert.equal(BROWSER_POLICY.transport.default, 'pipe');
  assert.deepEqual(BROWSER_POLICY.discovery.order, ['AKRS_BROWSER_PATH', 'CHROME_PATH', 'os_paths', 'path_lookup']);
  assert.equal(BROWSER_POLICY.timeouts.default_ms, 30000);
  assert.equal(BROWSER_POLICY.evidence.default_directory, '.cache/page');
});

test('a program that cannot start is launch_failed and leaves no profile behind', async () => {
  const result = await launchBrowser({ executable: join(tmpdir(), 'akrs-no-such-browser'), env: process.env, platform: process.platform, connect: () => new FakeTransport() });
  assert.deepEqual([result.ok, result.reason], [false, 'launch_failed']);
  assert.equal(existsSync(result.profile_dir), false);
});

test('success: Browser.close ends the browser, the helper tree and the profile are gone', async (t) => {
  const { launched, ids } = await launchStandIn(t, {}, (message, child) => {
    if (message.method === 'Browser.close') {
      child.kill();
      return { id: message.id, result: {} };
    }
    return undefined;
  });
  assert.equal(existsSync(launched.profile_dir), true);
  const done = await launched.teardown();
  assert.equal(done.profile_removed, true);
  assert.equal(existsSync(launched.profile_dir), false);
  assert.equal(await until(() => !alive(ids.browser) && !alive(ids.helper)), true, 'a process of the browser tree survived');
});

test('timeout of the close: a browser that ignores Browser.close is force-ended with its whole tree', async (t) => {
  const { launched, ids } = await launchStandIn(t);
  const done = await launched.teardown();
  assert.equal(done.termination, 'forced');
  assert.equal(existsSync(launched.profile_dir), false);
  assert.equal(await until(() => !alive(ids.browser) && !alive(ids.helper)), true);
});

test('teardown is safe to call twice', async (t) => {
  const { launched } = await launchStandIn(t);
  await launched.teardown();
  const again = await launched.teardown();
  assert.equal(again.profile_removed, true);
});

test('failure: an error inside the work still ends the tree and removes the profile', async (t) => {
  const world = await standIn(t);
  let profile;
  const result = await withBrowser({
    executable: process.execPath, leadingArgs: [world.script], env: process.env, platform: process.platform, closeWaitMs: 100, graceMs: 100,
    connect: () => new FakeTransport(),
  }, async (_conn, launched) => {
    profile = launched.profile_dir;
    await until(() => existsSync(world.pids));
    throw new Error('the work failed');
  });
  assert.deepEqual([result.ok, result.reason], [false, 'work_failed']);
  const ids = JSON.parse(await readFile(world.pids, 'utf8'));
  assert.equal(existsSync(profile), false);
  assert.equal(await until(() => !alive(ids.browser) && !alive(ids.helper)), true);
});

test('interruption: an abort ends the work, the tree and the profile', async (t) => {
  const world = await standIn(t);
  const controller = new AbortController();
  let profile;
  const running = withBrowser({
    executable: process.execPath, leadingArgs: [world.script], env: process.env, platform: process.platform, closeWaitMs: 100, graceMs: 100, signal: controller.signal,
    connect: () => new FakeTransport(),
  }, async (_conn, launched) => {
    profile = launched.profile_dir;
    await until(() => existsSync(world.pids));
    return new Promise(() => {});
  });
  await until(() => existsSync(world.pids));
  controller.abort();
  const result = await running;
  assert.deepEqual([result.ok, result.reason], [false, 'interrupted']);
  const ids = JSON.parse(await readFile(world.pids, 'utf8'));
  assert.equal(existsSync(profile), false);
  assert.equal(await until(() => !alive(ids.browser) && !alive(ids.helper)), true);
});

test('a connection that cannot be made is launch_failed and everything is still removed', async (t) => {
  const world = await standIn(t);
  const result = await launchBrowser({
    executable: process.execPath, leadingArgs: [world.script], env: process.env, platform: process.platform, closeWaitMs: 100, graceMs: 100,
    connect: () => { throw new Error('no pipe'); },
  });
  assert.deepEqual([result.ok, result.reason], [false, 'launch_failed']);
  assert.equal(existsSync(result.profile_dir), false);
});
