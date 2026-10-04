// P2-W14: launch, readiness and teardown of the app under test, with real processes: the tree is always ended.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startApp } from '../../lib/scenario/app.js';
import { APP, freePort } from './support.js';

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
const scratch = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'akrs-app-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return directory;
};
const options = (port, extra = {}) => ({
  argv: [process.execPath, APP, String(port)], cwd: process.cwd(), env: process.env, platform: process.platform, launchUrl: `http://127.0.0.1:${port}`,
  ready: { url: `http://127.0.0.1:${port}/health`, status: 200, timeout_ms: 10000 }, graceMs: 200, ...extra,
});
const reachable = (port) => fetch(`http://127.0.0.1:${port}/health`).then(() => true, () => false);

test('the app is started, waited for, answers, and is stopped with its whole tree', async (t) => {
  const directory = await scratch(t);
  const port = await freePort();
  const pidFile = join(directory, 'child.pid');
  const started = await startApp(options(port, { argv: [process.execPath, APP, String(port), '--child', pidFile] }));
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.ok(started.ready_ms >= 0);
  assert.equal(await reachable(port), true);
  assert.equal(await until(() => existsSync(pidFile)), true);
  const grandchild = Number(await readFile(pidFile, 'utf8'));
  assert.equal(alive(grandchild), true);
  const stopped = await started.app.stop();
  assert.ok(['graceful', 'forced'].includes(stopped.termination));
  assert.equal(await until(async () => !(await reachable(port))), true, 'the server is still answering');
  assert.equal(await until(() => !alive(grandchild)), true, 'the grandchild survived');
});

test('the app output is captured with its byte count', async () => {
  const port = await freePort();
  const started = await startApp(options(port));
  try {
    const { stdout } = started.app.output();
    assert.match(stdout.text, new RegExp(`fixture app listening on ${port}`));
    assert.equal(stdout.truncated, false);
  } finally {
    await started.app.stop();
  }
});

test('stopping twice is safe', async () => {
  const started = await startApp(options(await freePort()));
  await started.app.stop();
  assert.ok((await started.app.stop()).termination);
});

test('a ready answer that never matches is ready_timeout and the tree is gone', async () => {
  const port = await freePort();
  const started = await startApp(options(port, { ready: { url: `http://127.0.0.1:${port}/health`, status: 201, timeout_ms: 600 } }));
  assert.deepEqual([started.ok, started.reason], [false, 'ready_timeout']);
  assert.equal(await until(async () => !(await reachable(port))), true);
});

test('a process that exits before it is ready is launch_failed with its output', async () => {
  const started = await startApp(options(await freePort(), { argv: [process.execPath, '-e', 'console.log("dying"); process.exit(3)'] }));
  assert.deepEqual([started.ok, started.reason], [false, 'exited_early']);
  assert.match(started.message, /exited with code 3/);
  assert.match(started.output.stdout.text, /dying/);
});

test('a program that cannot start is spawn_failed', async () => {
  const started = await startApp(options(await freePort(), { argv: [join(tmpdir(), 'akrs-no-such-app')] }));
  assert.deepEqual([started.ok, started.reason], [false, 'spawn_failed']);
});

test('without a ready block the launch URL answering at all is ready', async () => {
  const port = await freePort();
  const started = await startApp(options(port, { ready: null }));
  try {
    assert.equal(started.ok, true);
  } finally {
    await started.app?.stop();
  }
});

test('an abort while waiting ends the tree and says interrupted', async () => {
  const port = await freePort();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const started = await startApp(options(port, { ready: { url: `http://127.0.0.1:${port}/health`, status: 201, timeout_ms: 20000 }, signal: controller.signal }));
  assert.deepEqual([started.ok, started.reason], [false, 'interrupted']);
  assert.equal(await until(async () => !(await reachable(port))), true);
});
