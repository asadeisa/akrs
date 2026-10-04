// P2-W03 / F12: the process runner of `verify --road`. Real child processes (node itself), argv arrays only, one frozen
// termination, capture and environment contract.
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { F12_POLICY } from '../../lib/store/verify/policy.js';
import { allowListedEnvironment, planSpawn, runCheck } from '../../lib/store/verify/runner.js';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};
const node = (script, ...args) => [process.execPath, '-e', script, ...args];
const run = async (argv, extra = {}) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'akrs-verify-')));
  try {
    return await runCheck({ argv, cwd, timeoutMs: 10_000, env: process.env, graceMs: 300, ...extra });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};

test('F12 freezes the termination, capture and environment contract in one policy object', () => {
  assert.equal(Object.isFrozen(F12_POLICY), true);
  assert.deepEqual(Object.keys(F12_POLICY).sort(), ['capture', 'clock', 'cwd', 'environment', 'interruption', 'pre_start', 'result_record', 'shell', 'termination', 'timeout']);
  assert.equal(F12_POLICY.capture.stream_cap_bytes, 65536);
  assert.equal(F12_POLICY.termination.grace_ms, 2000);
  assert.equal(F12_POLICY.shell, 'never: argv arrays only; the child receives each argv entry as one literal argument');
});

test('a passing command is passed with its exit code, captured output and a duration', async () => {
  const result = await run(node('process.stdout.write("out"); process.stderr.write("err")'));
  assert.deepEqual({ status: result.status, exit_code: result.exit_code, signal: result.signal, termination: result.termination, error: result.error }, { status: 'passed', exit_code: 0, signal: null, termination: 'none', error: null });
  assert.deepEqual(result.stdout, { text: 'out', tail: null, total_bytes: 3, truncated: false });
  assert.deepEqual(result.stderr, { text: 'err', tail: null, total_bytes: 3, truncated: false });
  assert.equal(Number.isInteger(result.duration_ms) && result.duration_ms >= 0, true);
});

test('failure, timeout, spawn failure and interruption are distinct results; only exit 0 is passed', async () => {
  const failed = await run(node('process.exit(3)'));
  assert.deepEqual({ status: failed.status, exit_code: failed.exit_code }, { status: 'failed', exit_code: 3 });
  const missing = await run(['akrs-no-such-program-xyz', '--flag']);
  assert.deepEqual({ status: missing.status, exit_code: missing.exit_code, signal: missing.signal, code: missing.error.code }, { status: 'spawn_failed', exit_code: null, signal: null, code: 'ENOENT' });
  assert.equal(missing.duration_ms, null, 'a process that never started has no duration');
  const slow = await run(node('setInterval(() => {}, 1000)'), { timeoutMs: 300 });
  assert.equal(slow.status, 'timed_out');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const interrupted = await run(node('setInterval(() => {}, 1000)'), { signal: controller.signal });
  assert.equal(interrupted.status, 'interrupted');
  for (const result of [failed, missing, slow, interrupted]) assert.notEqual(result.status, 'passed');
});

test('a timeout asks politely first and forces only when the process ignores it', async () => {
  const polite = await run(node('process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000); console.log("ready")'), { timeoutMs: 600 });
  assert.equal(polite.status, 'timed_out');
  assert.equal(polite.termination, process.platform === 'win32' ? 'forced' : 'graceful');
  const stubborn = await run(node('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("ready")'), { timeoutMs: 600, graceMs: 200 });
  assert.equal(stubborn.status, 'timed_out');
  assert.equal(stubborn.termination, 'forced');
});

test('descendants of a timed-out command are cleaned up with it', async () => {
  const script = [
    'const { spawn } = require("node:child_process");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    'process.stdout.write(String(child.pid));',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const result = await run(node(script), { timeoutMs: 800 });
  assert.equal(result.status, 'timed_out');
  const pid = Number(result.stdout.text);
  assert.ok(Number.isInteger(pid) && pid > 0, result.stdout.text);
  assert.equal(await gone(pid), true, 'the grandchild is gone');
});

test('stdout and stderr are capped; the byte count stays exact and head and tail are both kept', async () => {
  const cap = F12_POLICY.capture.stream_cap_bytes;
  const result = await run(node(`process.stdout.write("H".repeat(${cap})); process.stdout.write("M".repeat(300000)); process.stdout.write("T".repeat(1000)); process.stderr.write("e".repeat(10))`));
  assert.equal(result.status, 'passed');
  assert.equal(result.stdout.truncated, true);
  assert.equal(result.stdout.total_bytes, cap + 300000 + 1000);
  assert.equal(Buffer.byteLength(result.stdout.text) + Buffer.byteLength(result.stdout.tail), cap);
  assert.equal(result.stdout.text.startsWith('HHH'), true);
  assert.equal(result.stdout.tail.endsWith('TTT'), true);
  assert.deepEqual(result.stderr, { text: 'e'.repeat(10), tail: null, total_bytes: 10, truncated: false });
});

test('binary and control bytes cannot break the structured result', async () => {
  const result = await run(node('process.stdout.write(Buffer.from([0, 27, 91, 51, 49, 109, 255, 254, 10]))'));
  const round = JSON.parse(JSON.stringify(result));
  assert.equal(round.stdout.total_bytes, 9);
  assert.equal(typeof round.stdout.text, 'string');
});

test('the environment is an allow-list: a secret in the parent never reaches the child, PATH does', async () => {
  const names = allowListedEnvironment({ PATH: '/bin', HOME: '/h', AKRS_SECRET_TOKEN: 'x', npm_config_token: 'y' }, 'linux');
  assert.deepEqual(Object.keys(names.env).sort(), ['HOME', 'NO_COLOR', 'PATH']);
  assert.deepEqual(names.inherited, ['HOME', 'PATH']);
  const result = await run(node('process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))'), { env: { ...process.env, AKRS_SECRET_TOKEN: 'leak' } });
  const seen = JSON.parse(result.stdout.text);
  assert.equal(seen.includes('AKRS_SECRET_TOKEN'), false);
  assert.equal(seen.includes('PATH') || seen.includes('Path'), true);
  assert.equal(seen.includes('NO_COLOR'), true);
});

test('Windows names match case-insensitively and a batch file only runs with plain arguments', () => {
  assert.deepEqual(allowListedEnvironment({ Path: 'C:\\x', SystemRoot: 'C:\\Windows', Secret: 's' }, 'win32').inherited, ['Path', 'SystemRoot']);
  const files = new Set(['C:\\tools\\npm.cmd']);
  const plan = planSpawn({ argv: ['npm', 'test', '--', 'a.spec.ts'], platform: 'win32', env: { PATH: 'C:\\tools', PATHEXT: '.com;.exe;.cmd' }, exists: (path) => files.has(path) });
  assert.deepEqual(plan, { ok: true, file: 'cmd.exe', args: ['/d', '/s', '/c', 'C:\\tools\\npm.cmd test -- a.spec.ts'], windowsVerbatimArguments: true });
  const hostile = planSpawn({ argv: ['npm', 'test', 'a & calc'], platform: 'win32', env: { PATH: 'C:\\tools', PATHEXT: '.cmd' }, exists: (path) => files.has(path) });
  assert.deepEqual({ ok: hostile.ok, code: hostile.code }, { ok: false, code: 'unsafe_batch_argument' });
  const direct = planSpawn({ argv: ['tool', 'x y'], platform: 'linux', env: {}, exists: () => false });
  assert.deepEqual(direct, { ok: true, file: 'tool', args: ['x y'], windowsVerbatimArguments: false });
});

test('arguments are never interpreted: shell syntax and variables arrive as literal text', async () => {
  const result = await run(node('process.stdout.write(process.argv.slice(1).join("|"))', 'a && echo pwned', '$HOME', '`id`', '*'));
  assert.equal(result.stdout.text, 'a && echo pwned|$HOME|`id`|*');
});

test('the duration comes from the injected monotonic clock', async () => {
  let reading = 0;
  const result = await run(node('0'), { clock: () => { reading += 1234; return reading; } });
  assert.equal(result.duration_ms, 1234);
});
