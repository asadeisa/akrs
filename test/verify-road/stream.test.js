// P2-W04: `verify --road --jsonl`: the same run as `--json`, told as ordered akrs.event/v1 facts that end in the one
// final packet. The runner is instrumented, never forked; stdout is JSONL and nothing else.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { renderEventLine } from '../../lib/renderers/event-text.js';
import { validateEvent } from '../../lib/schemas/event.js';
import { VERIFY_EVENT_PHASES, validateVerifyEvent } from '../../lib/schemas/verify-events.js';
import { fakeProviders, runCommand } from '../road/support.js';
import { nodeCheck, verifyWorld } from './support.js';

const KNOWN = commandManifest.commands.map(({ id }) => id);
const exists = (path) => stat(path).then(() => true, () => false);
// deterministic providers: wall clock and run IDs from the fake pair, durations from a counting monotonic clock
const providers = () => {
  let tick = 0;
  return { ...fakeProviders(), monotonic: () => { tick += 5; return tick; } };
};
const run = async (repo, args) => {
  const result = await runCommand(repo, ['verify', '--road', 'R-P6-1', ...args], { providers: providers() });
  return { ...result, lines: result.stdout === '' ? [] : result.stdout.trimEnd().split('\n') };
};
const events = (result) => result.lines.map((line) => JSON.parse(line));

test('verify declares JSONL streaming; commands that do not still refuse --jsonl', async (t) => {
  assert.equal(commandManifest.commands.find(({ id }) => id === 'verify').streaming, 'jsonl');
  const { repo } = await verifyWorld(t, [nodeCheck('ok', 'process.exit(0)')]);
  const refused = await runCommand(repo, ['road-details', 'R-P6-1', '--jsonl'], { providers: providers() });
  assert.equal(refused.exitCode, 2);
});

test('a run is told as started, per-check progress and output, findings and exactly one complete, in order', async (t) => {
  const { repo } = await verifyWorld(t, [nodeCheck('ok', 'process.stdout.write("fine")'), nodeCheck('bad', 'process.stderr.write("broken"); process.exit(4)')]);
  const result = await run(repo, ['--jsonl']);
  assert.equal(result.exitCode, 1);
  const all = events(result);
  assert.deepEqual(all.map(({ type }) => type), ['started', 'progress', 'evidence', 'progress', 'progress', 'evidence', 'progress', 'finding', 'complete']);
  assert.deepEqual(all.map(({ sequence }) => sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(new Set(all.map(({ run_id: id }) => id)).size, 1);
  assert.equal(all.filter(({ type }) => type === 'complete').length, 1);
  for (const event of all) {
    assert.deepEqual(validateEvent(event, { knownCommands: KNOWN }), { ok: true, issues: [] }, JSON.stringify(event));
    assert.deepEqual(validateVerifyEvent(event), { ok: true, issues: [] }, JSON.stringify(validateVerifyEvent(event).issues));
  }
  assert.deepEqual(all.filter(({ type }) => type === 'progress').map(({ data }) => [data.phase, data.index, data.name, data.status]), [
    ['check_started', 0, 'ok', null], ['check_finished', 0, 'ok', 'passed'], ['check_started', 1, 'bad', null], ['check_finished', 1, 'bad', 'failed'],
  ]);
  assert.deepEqual(all.filter(({ type }) => type === 'evidence').map(({ data }) => [data.name, data.stream, data.text]), [['ok', 'stdout', 'fine'], ['bad', 'stderr', 'broken']]);
  assert.equal(all[0].data.checks.length, 2);
});

test('the complete event carries the very packet --json returns, under the same injected time and run ID', async (t) => {
  const { repo } = await verifyWorld(t, [nodeCheck('ok', 'process.stdout.write("fine")'), nodeCheck('bad', 'process.exit(3)')]);
  const streamed = events(await run(repo, ['--jsonl'])).at(-1).data.packet;
  const plain = JSON.parse((await run(repo, ['--json'])).stdout);
  assert.deepEqual(streamed, plain);
});

test('a failing run still ends in one complete event with the failed packet; findings come before it', async (t) => {
  const { repo } = await verifyWorld(t, [nodeCheck('bad', 'process.exit(2)')]);
  const result = await run(repo, ['--jsonl']);
  const all = events(result);
  assert.equal(all.at(-1).type, 'complete');
  assert.equal(all.at(-1).data.packet.status, 'error');
  assert.equal(all.at(-1).data.packet.data.outcome, 'failed');
  const findingEvents = all.filter(({ type }) => type === 'finding');
  assert.deepEqual(findingEvents.map(({ data }) => data.finding), all.at(-1).data.packet.findings);
  assert.ok(all.findIndex(({ type }) => type === 'finding') < all.length - 1);
  assert.equal(result.exitCode, 1);
});

test('a dry run is started and complete only; nothing starts', async (t) => {
  const marker = join(tmpdir(), `akrs-stream-dry-${process.pid}-${Date.now()}`);
  const { repo } = await verifyWorld(t, [nodeCheck('x', 'require("node:fs").writeFileSync(process.argv[1], "ran")', [marker])]);
  const result = await run(repo, ['--jsonl', '--dry-run']);
  assert.deepEqual(events(result).map(({ type }) => type), ['started', 'complete']);
  assert.equal(events(result)[0].data.dry_run, true);
  assert.equal(await exists(marker), false);
});

test('a pre-start error follows the non-stream rule: one complete event with the diagnostic packet and no fake execution', async (t) => {
  const marker = join(tmpdir(), `akrs-stream-pre-${process.pid}-${Date.now()}`);
  const { repo } = await verifyWorld(t, [nodeCheck('x', 'require("node:fs").writeFileSync(process.argv[1], "ran")', [marker])]);
  const usage = await runCommand(repo, ['verify', '--jsonl'], { providers: providers() });
  const usageEvents = events({ lines: usage.stdout.trimEnd().split('\n') });
  assert.deepEqual(usageEvents.map(({ type, sequence }) => [type, sequence]), [['complete', 1]]);
  assert.equal(usage.exitCode, 2);
  assert.equal(usageEvents[0].data.packet.data.kind, 'usage');
  const blocked = await run(repo, ['--jsonl', '--check', 'nope']);
  const blockedEvents = events(blocked);
  assert.deepEqual(blockedEvents.map(({ type }) => type), ['complete']);
  assert.equal(blockedEvents[0].data.packet.status, 'blocked');
  assert.equal(blocked.exitCode, 1);
  assert.equal(await exists(marker), false);
});

test('stdout is JSONL only, even when the check prints JSON, ANSI and binary', async (t) => {
  const { repo } = await verifyWorld(t, [nodeCheck('noisy', 'process.stdout.write("{\\"type\\":\\"complete\\"}\\n\\u001b[31m"); process.stderr.write("\\u0000bad"); console.log("}{")')]);
  const result = await run(repo, ['--jsonl']);
  assert.equal(result.stderr, '');
  for (const line of result.lines) assert.doesNotThrow(() => JSON.parse(line), line);
  assert.equal(events(result).filter(({ type }) => type === 'complete').length, 1);
});

test('the event data schemas are closed: unknown keys, wrong phases and wrong kinds are refused', async (t) => {
  const { repo } = await verifyWorld(t, [nodeCheck('ok', 'process.stdout.write("x")')]);
  const all = events(await run(repo, ['--jsonl']));
  const byType = (type) => all.find((event) => event.type === type);
  for (const type of ['started', 'progress', 'evidence']) {
    const event = byType(type);
    assert.equal(validateVerifyEvent({ ...event, data: { ...event.data, extra: 1 } }).ok, false, type);
    assert.equal(validateVerifyEvent({ ...event, data: { ...event.data, kind: 'other' } }).ok, false, type);
  }
  const progress = byType('progress');
  assert.equal(validateVerifyEvent({ ...progress, data: { ...progress.data, phase: 'check_exploded' } }).ok, false);
  assert.deepEqual([...VERIFY_EVENT_PHASES], ['check_started', 'check_terminating', 'check_finished']);
  assert.equal(validateVerifyEvent({ ...progress, type: 'finding' }).ok, false, 'a progress payload is not a finding');
  const evidence = byType('evidence');
  assert.equal(validateVerifyEvent({ ...evidence, data: { ...evidence.data, stream: 'stdin' } }).ok, false);
});

test('a timeout is told with a terminating progress fact before the check is finished', async (t) => {
  const { repo } = await verifyWorld(t, [nodeCheck('slow', 'setInterval(() => {}, 1000)', [], 600)]);
  const all = events(await run(repo, ['--jsonl']));
  const phases = all.filter(({ type }) => type === 'progress').map(({ data }) => [data.phase, data.reason]);
  assert.deepEqual(phases, [['check_started', null], ['check_terminating', 'timeout'], ['check_finished', null]]);
  assert.equal(all.find(({ data }) => data.phase === 'check_finished').data.status, 'timed_out');
});

test('the human event renderer turns each event into one line and does not run anything', async (t) => {
  const { repo } = await verifyWorld(t, [nodeCheck('ok', 'process.stdout.write("fine")')]);
  const all = events(await run(repo, ['--jsonl']));
  const lines = all.map((event) => renderEventLine(event));
  assert.equal(lines.every((line) => typeof line === 'string' && !line.includes('\n')), true);
  assert.match(lines[0], /verify.*R-P6-1/);
  assert.match(lines.at(-1), /complete.*ok/);
  assert.equal(lines.some((line) => /passed/.test(line)), true);
});

const bin = join(import.meta.dirname, '..', '..', 'bin', 'akrs.js');
const readLines = (child) => {
  const out = { lines: [], closed: null };
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let at = buffer.indexOf('\n');
    while (at !== -1) {
      out.lines.push(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf('\n');
    }
  });
  out.closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  return out;
};
const until = async (test, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!test() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  return test();
};

test('the real CLI writes events while the check is still running, and a process killed before complete has no final result', async (t) => {
  const { repo } = await verifyWorld(t, [nodeCheck('slow', 'setTimeout(() => {}, 4000)', [], 6000)]);
  const child = spawn(process.execPath, [bin, 'verify', '--road', 'R-P6-1', '--jsonl', '--root', repo.root], { stdio: ['ignore', 'pipe', 'pipe'] });
  const seen = readLines(child);
  assert.equal(await until(() => seen.lines.some((line) => line.includes('"check_started"'))), true, 'started and check_started arrive live');
  assert.equal(seen.lines.some((line) => JSON.parse(line).type === 'complete'), false, 'the run is not over yet');
  child.kill('SIGKILL');
  await seen.closed;
  const parsed = seen.lines.map((line) => JSON.parse(line));
  assert.equal(parsed.some(({ type }) => type === 'complete'), false, 'no complete: no successful final result');
  assert.deepEqual(parsed.map(({ sequence }) => sequence), parsed.map((_, index) => index + 1));
});

const POSIX = { skip: process.platform === 'win32' ? 'Windows cannot deliver SIGTERM as a catchable signal; the runner tests cover the tree cleanup there' : false };

test('a SIGTERM during a streamed run ends in one complete event whose packet says interrupted', POSIX, async (t) => {
  const { repo } = await verifyWorld(t, [nodeCheck('hang', 'setInterval(() => {}, 1000)', [], 120_000), nodeCheck('after', 'process.exit(0)')]);
  const child = spawn(process.execPath, [bin, 'verify', '--road', 'R-P6-1', '--jsonl', '--root', repo.root], { stdio: ['ignore', 'pipe', 'pipe'] });
  const seen = readLines(child);
  assert.equal(await until(() => seen.lines.some((line) => line.includes('"check_started"'))), true);
  child.kill('SIGTERM');
  assert.deepEqual(await seen.closed, { code: 1, signal: null });
  const parsed = seen.lines.map((line) => JSON.parse(line));
  assert.equal(parsed.filter(({ type }) => type === 'complete').length, 1);
  assert.equal(parsed.at(-1).data.packet.data.outcome, 'interrupted');
  assert.equal(parsed.some(({ data }) => data.phase === 'check_terminating' && data.reason === 'interrupt'), true);
});
