// P2-W03: `akrs verify --road <id>` end to end: only declared checks run, nothing is invented, a failure is never a pass,
// and the result is mechanical (no Tester verdict, no acceptance claim).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { assertFindingsMatchCatalog } from '../road/support.js';
import { everything } from '../change/support.js';
import { snapshotOf } from '../change/support.js';
import { nodeCheck, verify, verifyWorld } from './support.js';

const exists = (path) => stat(path).then(() => true, () => false);
const MARK = 'require("node:fs").writeFileSync(process.argv[1], "ran")';

test('the manifest entry is a no-write execution with the frozen flags, snapshot projection and JSONL streaming', () => {
  const entry = commandManifest.commands.find(({ id }) => id === 'verify');
  assert.deepEqual(entry.tokens, ['verify']);
  assert.deepEqual(entry.flags.map(({ name }) => name), ['--road', '--check', '--dry-run', '--if-snapshot', '--root', '--workflow-root', '--json', '--jsonl', '--prompt']);
  assert.deepEqual({ mutability: entry.mutability, streaming: entry.streaming, idempotency: entry.idempotency, role: entry.required_role }, { mutability: 'query', streaming: 'jsonl', idempotency: 'not_applicable', role: 'any' });
  assert.deepEqual(entry.statuses, ['ok', 'warning', 'error', 'blocked']);
});

test('dry run shows the exact argv, cwd and timeout of every declared check and starts nothing', async (t) => {
  const marker = join(tmpdir(), `akrs-dry-${process.pid}-${Date.now()}`);
  const { repo } = await verifyWorld(t, [nodeCheck('unit', MARK, [marker], 4321), nodeCheck('lint', 'process.exit(0)')]);
  const before = await everything(repo);
  const { exitCode, packet } = await verify(repo, ['--dry-run']);
  assert.equal(exitCode, 0);
  assert.equal(packet.status, 'ok');
  assert.equal(packet.data.dry_run, true);
  assert.equal(packet.data.outcome, 'dry_run');
  assert.deepEqual(packet.data.checks.map(({ name, status, timeout_ms, cwd }) => [name, status, timeout_ms, cwd]), [['unit', 'not_run', 4321, '.'], ['lint', 'not_run', 10000, '.']]);
  assert.deepEqual(packet.data.checks[0].argv, [process.execPath, '-e', MARK, marker]);
  assert.equal(packet.data.checks.every(({ exit_code, duration_ms, stdout }) => exit_code === null && duration_ms === null && stdout === null), true);
  assert.equal(await exists(marker), false, 'no process was started');
  assert.equal(await everything(repo), before);
});

test('only checks declared in the canonical Road can run, selected by name, and no command can be passed in', async (t) => {
  const marker = join(tmpdir(), `akrs-declared-${process.pid}-${Date.now()}`);
  const { repo } = await verifyWorld(t, [nodeCheck('unit', MARK, [marker]), nodeCheck('lint', 'process.exit(0)')]);
  const unknown = await verify(repo, ['--check', 'rm -rf /']);
  assert.equal(unknown.packet.status, 'blocked');
  assert.equal(unknown.packet.data.kind, 'verify_road_blocked');
  assert.equal(unknown.packet.data.reason, 'check_unknown');
  assert.equal(unknown.exitCode, 1);
  assertFindingsMatchCatalog(unknown.packet);
  assert.equal(await exists(marker), false);
  const extra = await verify(repo, ['--cmd', 'touch x']);
  assert.equal(extra.exitCode, 2, 'there is no flag that carries a command');
  const picked = await verify(repo, ['--check', 'unit']);
  assert.deepEqual(picked.packet.data.checks.map(({ name }) => name), ['unit']);
  assert.equal(await exists(marker), true);
});

test('declared arguments reach the program literally: no shell, no interpolation', async (t) => {
  const { repo } = await verifyWorld(t, [nodeCheck('echo', 'process.stdout.write(process.argv.slice(1).join("|"))', ['a && touch pwned', '$HOME', '`id`'])]);
  const { packet } = await verify(repo);
  assert.equal(packet.data.checks[0].stdout.text, 'a && touch pwned|$HOME|`id`');
  assert.equal(await exists(join(repo.root, 'pwned')), false);
});

test('a Road whose check array was edited by hand into a shell string is blocked and nothing runs', async (t) => {
  const marker = join(tmpdir(), `akrs-hand-${process.pid}-${Date.now()}`);
  const { repo } = await verifyWorld(t, [nodeCheck('unit', MARK, [marker])]);
  const text = await repo.read('akrs/roads/P6/R-P6-1.json');
  await repo.write('akrs/roads/P6/R-P6-1.json', text.replace(/"argv": \[[^\]]*\]/s, '"argv": "npm test && touch x"'));
  const { exitCode, packet } = await verify(repo);
  assert.equal(packet.status, 'blocked');
  assert.equal(packet.data.reason, 'road_unverified');
  assert.equal(exitCode, 1);
  assert.equal(await exists(marker), false);
});

test('success, failure, timeout and spawn failure are separate structured results and a failure is never a pass', async (t) => {
  const { repo } = await verifyWorld(t, [
    nodeCheck('ok', 'process.stdout.write("fine")'),
    nodeCheck('bad', 'process.stderr.write("broken"); process.exit(4)'),
    nodeCheck('slow', 'setInterval(() => {}, 1000)', [], 700),
    { name: 'ghost', argv: ['akrs-no-such-program-xyz'], timeout_ms: 5000 },
  ]);
  const { exitCode, packet } = await verify(repo);
  assert.deepEqual(packet.data.checks.map(({ name, status }) => [name, status]), [['ok', 'passed'], ['bad', 'failed'], ['slow', 'timed_out'], ['ghost', 'spawn_failed']]);
  assert.equal(packet.data.checks[1].exit_code, 4);
  assert.equal(packet.data.checks[1].stderr.text, 'broken');
  assert.equal(packet.data.checks[3].error.code, 'ENOENT');
  assert.equal(packet.status, 'error');
  assert.equal(exitCode, 1);
  assert.equal(packet.data.outcome, 'failed');
  assert.deepEqual(packet.data.summary, { declared: 4, selected: 4, passed: 1, failed: 1, timed_out: 1, spawn_failed: 1, interrupted: 0, not_run: 0 });
  assert.deepEqual(packet.findings.map(({ code }) => code), ['AKRS-R023', 'AKRS-R023', 'AKRS-R023']);
  assertFindingsMatchCatalog(packet);
});

test('an all-passing run is exit 0 and says it is mechanical, with no Tester verdict or acceptance claim', async (t) => {
  const { repo } = await verifyWorld(t, [nodeCheck('ok', 'process.exit(0)')]);
  const { exitCode, packet } = await verify(repo);
  assert.equal(exitCode, 0);
  assert.equal(packet.status, 'ok');
  assert.equal(packet.data.mode, 'mechanical');
  assert.equal(packet.data.outcome, 'passed');
  assert.match(packet.data.note, /not a Tester verdict/);
  assert.match(packet.data.risk, /executes the argv arrays declared in this repository/);
  const text = JSON.stringify(packet).toLowerCase();
  for (const word of ['"verdict"', '"accepted"', '"acceptance_met"', '"verified"']) assert.equal(text.includes(word), false, word);
  assert.equal(packet.data.checks[0].cwd, '.');
});

test('a Road with no declared check is blocked, not passed', async (t) => {
  const { repo } = await verifyWorld(t, []);
  const { exitCode, packet } = await verify(repo);
  assert.deepEqual({ status: packet.status, reason: packet.data.reason, exitCode }, { status: 'blocked', reason: 'no_checks', exitCode: 1 });
});

test('check output can never corrupt the JSON packet on stdout', async (t) => {
  const { repo } = await verifyWorld(t, [nodeCheck('noisy', 'process.stdout.write("{\\"fake\\":true}\\n\\u001b[31m"); process.stderr.write("\\u0000bad"); console.log("}{")')]);
  const result = await verify(repo);
  assert.equal(result.stdout.trim().split('\n').length > 1, true, 'a pretty-printed single document');
  assert.equal(result.packet.command, 'verify');
  assert.equal(result.packet.data.checks[0].stdout.text.includes('{"fake":true}'), true);
  assert.equal(result.stderr, '', 'the child stderr never reaches the CLI stderr');
});

test('a snapshot that changed since the caller read it blocks before anything runs; a fresh one runs', async (t) => {
  const marker = join(tmpdir(), `akrs-snap-${process.pid}-${Date.now()}`);
  const { repo } = await verifyWorld(t, [nodeCheck('unit', MARK, [marker])]);
  const stale = `sha256:${'0'.repeat(64)}`;
  const blocked = await verify(repo, ['--if-snapshot', stale]);
  assert.deepEqual({ status: blocked.packet.status, reason: blocked.packet.data.reason, code: blocked.packet.findings[0].code, exitCode: blocked.exitCode }, { status: 'blocked', reason: 'stale_snapshot', code: 'AKRS-C013', exitCode: 1 });
  assertFindingsMatchCatalog(blocked.packet);
  assert.equal(await exists(marker), false);
  const fresh = await verify(repo, ['--if-snapshot', await snapshotOf(repo, 'verify', 'R-P6-1')]);
  assert.equal(fresh.packet.status, 'ok');
  assert.equal(await exists(marker), true);
});

test('verify writes nothing in the workflow and records nothing in the journal', async (t) => {
  const { repo } = await verifyWorld(t, [nodeCheck('ok', 'process.exit(0)')]);
  const before = await everything(repo);
  await verify(repo);
  await verify(repo);
  assert.equal(await everything(repo), before);
});

test('every run is a fresh execution: an identical request is never replayed as noop', async (t) => {
  const { repo } = await verifyWorld(t, [nodeCheck('count', 'process.stdout.write(String(Date.now()))')]);
  const first = await verify(repo);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await verify(repo);
  assert.notEqual(second.packet.status, 'noop');
  assert.notEqual(first.packet.data.checks[0].stdout.text, second.packet.data.checks[0].stdout.text);
});

test('the prompt and human views render the same packet', async (t) => {
  const { repo } = await verifyWorld(t, [nodeCheck('ok', 'process.stdout.write("fine")')]);
  const { runCommand } = await import('../road/support.js');
  const json = await verify(repo, ['--dry-run']);
  for (const flag of ['--prompt', '']) {
    const out = await runCommand(repo, ['verify', '--road', 'R-P6-1', '--dry-run', ...(flag === '' ? [] : [flag])], { providers: repo.providers });
    assert.equal(out.exitCode, 0, out.stderr);
    assert.ok(out.stdout.includes('mechanical'));
    assert.ok(out.stdout.includes(json.packet.data.checks[0].name));
  }
});

test('a missing Road is a usage error', async (t) => {
  const { repo } = await verifyWorld(t, [nodeCheck('ok', 'process.exit(0)')]);
  const { runCommand } = await import('../road/support.js');
  const out = await runCommand(repo, ['verify', '--road', 'R-NOPE', '--json'], { providers: repo.providers });
  assert.equal(out.exitCode, 2);
});

const POSIX = { skip: process.platform === 'win32' ? 'Windows cannot deliver SIGTERM as a catchable signal; the tree cleanup is covered by the runner tests there' : false };

test('interrupting the real CLI ends the check, its descendants and the run, and still prints one final packet', POSIX, async (t) => {
  const pidFile = join(tmpdir(), `akrs-int-${process.pid}-${Date.now()}`);
  const script = [
    'const { spawn } = require("node:child_process");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    'require("node:fs").writeFileSync(process.argv[1], String(child.pid));',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const { repo } = await verifyWorld(t, [nodeCheck('hang', script, [pidFile], 120_000), nodeCheck('after', 'process.exit(0)')]);
  const bin = join(import.meta.dirname, '..', '..', 'bin', 'akrs.js');
  const child = spawn(process.execPath, [bin, 'verify', '--road', 'R-P6-1', '--json', '--root', repo.root], { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  for (let attempt = 0; attempt < 200 && !(await exists(pidFile)); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await exists(pidFile), true, 'the check started');
  const grandchild = Number(await readFile(pidFile, 'utf8'));
  child.kill('SIGTERM');
  const exit = await new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  assert.deepEqual(exit, { code: 1, signal: null });
  const packet = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(packet.data.outcome, 'interrupted');
  assert.deepEqual(packet.data.checks.map(({ name, status }) => [name, status]), [['hang', 'interrupted'], ['after', 'not_run']]);
  let alive = true;
  for (let attempt = 0; attempt < 60 && alive; attempt += 1) {
    try {
      process.kill(grandchild, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, 'the descendant is gone');
});
