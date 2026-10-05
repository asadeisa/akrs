// P2-W09: the query commands are read-only manifest entries with exact flags, role any and honest MCP mapping; their frozen
// decisions and closed vocabularies are pinned here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { COMMAND_SNAPSHOT_TABLE } from '../../lib/store/snapshots/projections.js';
import { NAVIGATION_POLICY, WHERE_RELATIONS, GRAPH_NODE_TYPES, GRAPH_EDGE_TYPES, NEXT_ACTION_KINDS, STALE_ITEM_KINDS } from '../../lib/store/navigation/policy.js';
import { NAVIGATION_NEXT_COMMAND_BUILDERS } from '../../lib/store/navigation/next-commands.js';

const byId = Object.fromEntries(commandManifest.commands.map((entry) => [entry.id, entry]));
const QUERIES = {
  status: { tokens: ['status'], mcp: ['akrs_status', 'status'], positionals: [], flags: [] },
  next: { tokens: ['next'], mcp: ['akrs_status', 'next'], positionals: [], flags: ['--executor'] },
  where: { tokens: ['where'], mcp: [null, null], positionals: [{ name: 'path', required: true, variadic: false }], flags: [] },
  graph: { tokens: ['graph'], mcp: ['akrs_status', 'graph'], positionals: [], flags: ['--touches'] },
  stale: { tokens: ['stale'], mcp: [null, null], positionals: [], flags: [] },
  log: { tokens: ['log'], mcp: [null, null], positionals: [], flags: ['--kind', '--subject', '--limit'] },
};

test('every navigation query is a read-only entry with its tokens, flags, MCP mapping and snapshot row', () => {
  for (const [id, expected] of Object.entries(QUERIES)) {
    const entry = byId[id];
    assert.ok(entry, `${id} is registered`);
    assert.deepEqual(entry.tokens, expected.tokens, id);
    assert.deepEqual([entry.mutability, entry.idempotency, entry.expected_snapshot, entry.dry_run, entry.required_role, entry.streaming], ['query', 'not_applicable', 'not_applicable', false, 'any', 'none'], id);
    assert.deepEqual([entry.mcp_tool, entry.mcp_action], expected.mcp, id);
    assert.deepEqual(entry.positionals, expected.positionals, id);
    const own = entry.flags.map(({ name }) => name).filter((name) => !['--json', '--jsonl', '--prompt', '--root', '--workflow-root'].includes(name));
    assert.deepEqual(own, expected.flags, id);
    assert.deepEqual(entry.snapshot_inputs, COMMAND_SNAPSHOT_TABLE[id].inputs, id);
    assert.deepEqual(entry.statuses, ['ok', 'warning', 'error', 'blocked'], id);
    assert.equal(entry.output_schema, `akrs.command-output/${id}/v1`);
  }
});

test('log is a separate query from log append: the longer token list still dispatches to the writer', () => {
  assert.deepEqual(byId['log-append'].tokens, ['log', 'append']);
  assert.deepEqual(byId.log.tokens, ['log']);
});

test('where has four frozen relations and graph the closed node and edge types of akrs.graph/v1', () => {
  assert.deepEqual([...WHERE_RELATIONS], ['closures', 'readers', 'scope_requests', 'writers']);
  assert.deepEqual([...GRAPH_NODE_TYPES], ['plan', 'road', 'task', 'verification']);
  assert.deepEqual([...GRAPH_EDGE_TYPES], ['block', 'collision', 'dep', 'touch']);
  assert.deepEqual([...NEXT_ACTION_KINDS], ['activate', 'close_plan', 'decide_scope', 'finish_road', 'inspect', 'run_tests', 'work']);
  assert.deepEqual([...STALE_ITEM_KINDS], ['plan_lease', 'result', 'road_lease', 'run', 'state_render']);
});

test('the frozen decisions are written down and deep-frozen', () => {
  assert.equal(Object.isFrozen(NAVIGATION_POLICY), true);
  for (const key of ['compose', 'order', 'status', 'next', 'where', 'graph', 'stale', 'log', 'closed_plan', 'reuse_scan', 'doctor']) {
    assert.equal(typeof NAVIGATION_POLICY[key], 'string', key);
    assert.ok(NAVIGATION_POLICY[key].length > 20, key);
  }
});

test('the next-command builders offer only commands that run as they are', () => {
  for (const id of ['status', 'next', 'where', 'graph', 'stale', 'log']) {
    assert.equal(typeof NAVIGATION_NEXT_COMMAND_BUILDERS[id], 'function', id);
    assert.equal(byId[id].next_command_builder, id);
  }
  assert.deepEqual(NAVIGATION_NEXT_COMMAND_BUILDERS.next({ phase: 'actions', actions: [{ command: 'road-details', args: ['R-1', '--role', 'worker'] }], rootArgs: ['--root', '/r'] }), [{ command: 'road-details', args: ['R-1', '--role', 'worker', '--root', '/r'] }]);
  assert.deepEqual(NAVIGATION_NEXT_COMMAND_BUILDERS.next({ phase: 'none', rootArgs: [] }), []);
  assert.deepEqual(NAVIGATION_NEXT_COMMAND_BUILDERS.status({ phase: 'default', rootArgs: [] }), [{ command: 'next', args: [] }]);
  assert.throws(() => NAVIGATION_NEXT_COMMAND_BUILDERS.next({ phase: 'nonsense' }), /unknown next-command phase/);
});

test('reuse-scan stays out of this packet and out of the manifest', () => {
  assert.equal(byId['reuse-scan'], undefined);
  assert.match(NAVIGATION_POLICY.reuse_scan, /not retained|not delivered|stays out/i);
});
