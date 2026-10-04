// P2-W06: the `test-details` command: manifest class, usage errors, one packet per call and no write.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { COMMAND_SNAPSHOT_TABLE } from '../../lib/store/snapshots/projections.js';
import { details, runCommand, testerWorld } from './support.js';

test('test-details is a read-only query over the Tester packet projection with an MCP action', () => {
  const entry = commandManifest.commands.find(({ id }) => id === 'test-details');
  assert.deepEqual([entry.tokens, entry.mutability, entry.idempotency, entry.expected_snapshot, entry.dry_run], [['test-details'], 'query', 'not_applicable', 'not_applicable', false]);
  assert.deepEqual(entry.snapshot_inputs, COMMAND_SNAPSHOT_TABLE['test-details'].inputs);
  assert.deepEqual([entry.mcp_tool, entry.mcp_action, entry.streaming], ['akrs_test', 'details', 'none']);
  assert.deepEqual(entry.positionals, [{ name: 'plan', required: true, variadic: false }]);
  assert.ok(entry.statuses.includes('blocked'));
});

test('a missing or malformed plan argument is a usage error and nothing is written', async (t) => {
  const repo = await testerWorld(t);
  const none = await runCommand(repo, ['test-details', '--json'], { providers: repo.providers });
  assert.equal(none.exitCode, 2);
  const bad = await runCommand(repo, ['test-details', 'not a plan', '--json'], { providers: repo.providers });
  assert.equal(bad.exitCode, 2);
  assert.equal((await details(repo, 'P7')).exitCode, 2);
});
