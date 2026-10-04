// P2-W01: road-details through the REAL CLI entry point (child processes): exit codes, pure JSON, usage errors, and the
// manifest registration. The renderers here are the generic ones; the role prompt renderer is P2-W02.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { validatePacket, validateReadOnlyPacket } from '../../lib/schemas/packet.js';
import { validateRoadDetails } from '../../lib/schemas/road-details.js';
import { ROAD_PACKET_PROJECTION } from '../../lib/store/snapshots/index.js';
import { runCli } from '../helpers/process.js';
import { packetWorld, readEntry, strict } from './support.js';

const cli = (repo, args, options = {}) => runCli([...args, '--root', repo.root], { cwd: repo.root, ...options });
const onePacket = (result) => {
  assert.equal(result.stdout.endsWith('\n'), true);
  assert.equal(result.stdout.trimEnd().includes('\n{"schema_version"'), false, 'exactly one packet');
  const packet = JSON.parse(result.stdout);
  assert.equal(validatePacket(packet).ok, true);
  return packet;
};

test('the manifest entry is a read-only query with the frozen flags, snapshot projection and MCP mapping', () => {
  const entry = commandManifest.commands.find(({ id }) => id === 'road-details');
  assert.deepEqual(entry.tokens, ['road-details']);
  assert.deepEqual(entry.positionals, [{ name: 'id', required: true, variadic: false }]);
  assert.deepEqual(entry.flags.map(({ name }) => name), ['--role', '--include-reads', '--no-include-reads', '--full', '--max-tokens', '--root', '--workflow-root', '--json', '--jsonl', '--prompt']);
  assert.equal(entry.mutability, 'query');
  assert.equal(entry.required_role, 'any');
  assert.equal(entry.idempotency, 'not_applicable');
  assert.equal(entry.expected_snapshot, 'not_applicable');
  assert.equal(entry.dry_run, false);
  assert.equal(entry.streaming, 'none');
  assert.deepEqual(entry.snapshot_inputs, [...ROAD_PACKET_PROJECTION]);
  assert.deepEqual([entry.mcp_tool, entry.mcp_action], ['akrs_road', 'details']);
  assert.equal(entry.next_command_builder, 'road-details');
});

test('--json: exit 0, one valid read-only packet, empty stderr, the data schema holds', async (t) => {
  const { repo } = await packetWorld(t);
  const before = await strict(repo);
  const result = await cli(repo, ['road-details', 'R-P6-1', '--json']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, '');
  const packet = onePacket(result);
  assert.equal(validateReadOnlyPacket(packet).ok, true);
  assert.equal(validateRoadDetails(packet.data).ok, true);
  assert.equal(packet.data.coverage.reads, '2/2');
  assert.equal(await strict(repo), before, 'a child-process query writes no byte either');
});

test('a blocked packet exits 1 with the complete data; an oversized one exits 1 and is refused', async (t) => {
  const { repo } = await packetWorld(t, { reads: [readEntry('SOT/gone.md', null, 'missing source')] });
  const blocked = await cli(repo, ['road-details', 'R-P6-1', '--json']);
  assert.equal(blocked.exitCode, 1);
  const packet = onePacket(blocked);
  assert.equal(packet.status, 'blocked');
  assert.equal(packet.data.reads.length, 1, 'the unresolved read is kept, not dropped');
  const { repo: ok } = await packetWorld(t);
  const refused = await cli(ok, ['road-details', 'R-P6-1', '--max-tokens', '5', '--json']);
  assert.equal(refused.exitCode, 1);
  assert.equal(onePacket(refused).data.kind, 'road_details_refused');
});

test('usage errors exit 2: unknown Road, bad role, conflicting or misplaced flags, bad --max-tokens, --jsonl', async (t) => {
  const { repo } = await packetWorld(t);
  for (const args of [
    ['road-details', 'R-NOPE', '--json'],
    ['road-details', 'R-P6-1', '--role', 'boss', '--json'],
    ['road-details', 'R-P6-1', '--include-reads', '--no-include-reads', '--json'],
    ['road-details', 'R-P6-1', '--full', '--json'],
    ['road-details', 'R-P6-1', '--max-tokens', '0', '--json'],
    ['road-details', 'R-P6-1', '--max-tokens', 'many', '--json'],
    ['road-details', 'R-P6-1', '--jsonl'],
    ['road-details', '--json'],
    ['road-details', 'not an id', '--json'],
  ]) {
    const result = await cli(repo, args);
    assert.equal(result.exitCode, 2, `${args.join(' ')} -> ${result.stderr}${result.stdout}`);
  }
});

test('--prompt and the human view render the same packet (no second query): the core data appears in both', async (t) => {
  const { repo } = await packetWorld(t);
  const packet = onePacket(await cli(repo, ['road-details', 'R-P6-1', '--json']));
  for (const flag of [[], ['--prompt']]) {
    const result = await cli(repo, ['road-details', 'R-P6-1', ...flag]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(result.stdout.includes(packet.data.packet_version));
    assert.ok(result.stdout.includes('SOT/09-use-cases.md'));
    assert.equal(result.stdout.includes(packet.run_id), false, 'a rendering is a fresh run of the same core packet');
  }
});
