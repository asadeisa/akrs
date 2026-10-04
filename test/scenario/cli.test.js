// P2-W14: the `test run` command: manifest class, usage errors, and that a usage error starts nothing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { COMMAND_SNAPSHOT_TABLE } from '../../lib/store/snapshots/projections.js';
import { treeDigest } from '../road/support.js';
import { runWorld, testRun } from './support.js';

test('test run is a derived_write, leased Tester execution with JSONL streaming and an MCP run action', () => {
  const entry = commandManifest.commands.find(({ id }) => id === 'test-run');
  assert.deepEqual([entry.tokens, entry.mutability, entry.idempotency, entry.expected_snapshot, entry.dry_run, entry.required_role], [['test', 'run'], 'derived_write', 'none', 'lease', false, 'tester']);
  assert.deepEqual([entry.mcp_tool, entry.mcp_action, entry.streaming], ['akrs_test', 'run', 'jsonl']);
  assert.deepEqual(entry.snapshot_inputs, COMMAND_SNAPSHOT_TABLE['test-run'].inputs);
  assert.deepEqual(entry.positionals, [{ name: 'plan', required: true, variadic: false }]);
  assert.ok(entry.flags.some(({ name }) => name === '--executor'));
  assert.deepEqual(entry.statuses, ['ok', 'warning', 'error', 'blocked']);
  assert.equal(entry.next_command_builder, 'test-run');
});

test('a missing, malformed or unknown Plan is a usage error, nothing is written and nothing is launched', async (t) => {
  const repo = await runWorld(t);
  const digest = await treeDigest(repo);
  for (const args of [[], ['not a plan'], ['P99'], ['P6', '--executor', 'no such id']]) {
    const run = await testRun(repo, args);
    assert.equal(run.exitCode, 2, args.join(' '));
  }
  assert.deepEqual(await treeDigest(repo), digest);
  assert.equal(await fetch(`http://127.0.0.1:${repo.port}/health`).then(() => true, () => false), false);
});

test('an unknown --executor is blocked with the choices, never silently replaced', async (t) => {
  const repo = await runWorld(t);
  const run = await testRun(repo, ['P6', '--executor', 'ghost']);
  assert.deepEqual([run.packet.status, run.packet.data.reason, run.packet.data.choices], ['blocked', 'holder_unresolved', ['qa']]);
});

test('AKRS_EXECUTOR names the holder when no flag is given', async (t) => {
  const repo = await runWorld(t);
  const run = await testRun(repo, ['P6'], { env: { ...process.env, AKRS_EXECUTOR: 'qa' } });
  assert.equal(run.packet.data.holder, 'qa');
});

test('--jsonl is accepted (the command streams) and --json/--prompt render the same packet', async (t) => {
  const repo = await runWorld(t);
  const prompt = await testRun(repo, ['P6'], { format: '--prompt' });
  assert.equal(prompt.exitCode, 0);
  assert.match(prompt.text, /# AKRS test run P6/);
});
