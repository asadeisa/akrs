// Real child-process runs of bin/akrs.js for the P1-W07 commands, plus the pins on their manifest entries and codes.
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { test } from 'node:test';
import { commandManifest, nextCommandBuilders } from '../../lib/commands/manifest.js';
import { getFindingDefinition } from '../../lib/findings/catalog.js';
import { validatePacket } from '../../lib/schemas/packet.js';
import { CHANGE_REASONS } from '../../lib/store/scope/policy.js';
import { TRANSACTIONAL_COMMANDS } from '../../lib/store/transactions/index.js';
import { runCli } from '../helpers/process.js';
import { createRepo, readEntry, roadJson, seedRoad } from './support.js';

const cli = (repo, args, options = {}) => runCli([...args, '--root', repo.root], { cwd: repo.root, timeoutMs: 60_000, ...options });
const packetOf = (result) => {
  assert.equal(result.stderr, '', 'machine output leaves stderr empty');
  assert.equal(result.stdout.trimEnd().includes('\n{"schema_version"'), false, 'exactly one packet');
  const packet = JSON.parse(result.stdout);
  assert.equal(validatePacket(packet).ok, true);
  return packet;
};
const writeDraft = (repo, name, document) => repo.write(`akrs/drafts/${name}.json`, `${JSON.stringify(document, null, 2)}\n`);

test('scope request through a draft: the draft is consumed, a retry is a noop, exit codes follow the packet status', async (t) => {
  const repo = await createRepo(t);
  await seedRoad(repo, { id: 'R-1' });
  const document = { schema: 'akrs.scope-request/v1', road: 'R-1', add_reads: [readEntry('src/own.js')], add_writes: [], reason: 'Need it.', blocking: true };
  await writeDraft(repo, 'ask', document);
  const first = await cli(repo, ['scope', 'request', '--input', 'akrs/drafts/ask.json', '--json']);
  const packet = packetOf(first);
  assert.equal(first.exitCode, 1, 'a blocking request is a warning: exit 1');
  assert.equal(packet.status, 'warning');
  assert.deepEqual(packet.changed, ['drafts/ask.json', 'scope/R-1.jsonl']);
  await assert.rejects(() => access(repo.path('akrs/drafts/ask.json')), { code: 'ENOENT' });
  const retry = await cli(repo, ['scope', 'request', '--input', 'akrs/drafts/ask.json', '--json']);
  assert.equal(packetOf(retry).status, 'noop');
  assert.equal(retry.exitCode, 0);
  const list = packetOf(await cli(repo, ['scope', 'list', 'R-1', '--json']));
  assert.equal(list.data.requests.length, 1);
  const none = await cli(repo, ['scope', 'request', '--json']);
  assert.equal(none.exitCode, 2);
});

test('road update --patch through stdin and the full replacement guard through the real adapter', async (t) => {
  const repo = await createRepo(t);
  await seedRoad(repo, { id: 'R-1' });
  const ops = { schema: 'akrs.road-patch/v1', ops: [{ op: 'replace_acceptance', acceptance: ['Done well.'] }] };
  const patched = await cli(repo, ['road', 'update', 'R-1', '--patch', '--json', '-'], { stdin: JSON.stringify(ops) });
  assert.equal(patched.exitCode, 0, patched.stdout);
  assert.deepEqual(packetOf(patched).changed, ['roads/R-1.json']);
  assert.deepEqual((await roadJson(repo, 'R-1')).acceptance, ['Done well.']);
  const full = await cli(repo, ['road', 'update', 'R-1', '--json', '-'], { stdin: JSON.stringify(await roadJson(repo, 'R-1')) });
  assert.equal(full.exitCode, 2, 'a full replacement without --if-snapshot is a usage error');
});

test('road move reports by default and applies only with --apply (exit codes and packets)', async (t) => {
  const repo = await createRepo(t);
  await seedRoad(repo, { id: 'R-1', plan: 'P1' }, { folder: 'roads/P1' });
  const report = await cli(repo, ['road', 'move', 'R-1', '--plan', 'P2', '--json']);
  assert.equal(report.exitCode, 0);
  assert.equal(packetOf(report).data.applied, false);
  await assert.rejects(() => access(repo.path('akrs/roads/P2/R-1.json')), { code: 'ENOENT' });
  const applied = await cli(repo, ['road', 'move', 'R-1', '--plan', 'P2', '--apply', '--json']);
  assert.equal(applied.exitCode, 0, applied.stdout);
  await access(repo.path('akrs/roads/P2/R-1.json'));
  const missing = await cli(repo, ['road', 'move', 'R-1', '--json']);
  assert.equal(missing.exitCode, 2);
});

test('manifest pins: the six commands are live, journaled, transactional, with next-command builders', () => {
  const byId = Object.fromEntries(commandManifest.commands.map((entry) => [entry.id, entry]));
  for (const id of ['road-update', 'road-move', 'scope-request', 'scope-approve', 'scope-reject']) {
    assert.equal(byId[id].mutability, 'mutation', id);
    assert.equal(byId[id].idempotency, 'journal', id);
    assert.equal(byId[id].dry_run, true, id);
    assert.equal(TRANSACTIONAL_COMMANDS.includes(id), true, id);
    assert.equal(typeof nextCommandBuilders[id], 'function', id);
  }
  assert.equal(byId['scope-list'].mutability, 'query');
  assert.deepEqual(byId['road-update'].tokens, ['road', 'update']);
  assert.equal(byId['road-update'].expected_snapshot, 'required');
  assert.equal(byId['scope-request'].required_role, 'any');
  assert.deepEqual(byId['scope-reject'].flags.find(({ name }) => name === '--reason').required, true);
  assert.deepEqual(commandManifest.reserved_commands, []);
});

test('R014 is a permanent road-family code whose reasons are the frozen vocabulary', () => {
  const definition = getFindingDefinition('AKRS-R014');
  assert.equal(definition.category, 'road');
  assert.equal(definition.severity, 'error');
  assert.deepEqual(definition.data_schema.properties.reason.enum, [...CHANGE_REASONS]);
  assert.equal(definition.data_schema.additionalProperties, false);
  assert.deepEqual([...CHANGE_REASONS], [...CHANGE_REASONS].sort());
});

test('next commands are runnable: no placeholder, root arguments carried', () => {
  const rootArgs = ['--root', '/tmp/x'];
  const lists = [
    nextCommandBuilders['road-update']({ phase: 'rejected', id: 'R-1', file: 'akrs/drafts/p.json', patch: true, rootArgs }),
    nextCommandBuilders['road-update']({ phase: 'rejected', id: 'R-1', file: null, patch: false, rootArgs }),
    nextCommandBuilders['road-move']({ phase: 'planned', id: 'R-1', plan: 'P2', rootArgs }),
    nextCommandBuilders['scope-request']({ phase: 'requested', road: 'R-1', rootArgs }),
    nextCommandBuilders['scope-approve']({ phase: 'rejected', rootArgs }),
  ];
  for (const commands of lists) {
    assert.equal(commands.length > 0, true);
    for (const { command, args } of commands) {
      assert.equal(commandManifest.commands.some(({ id }) => id === command), true, command);
      assert.equal(args.some((arg) => /[<>]/.test(arg)), false, args.join(' '));
    }
  }
  assert.deepEqual(lists[2][0].args, ['R-1', '--plan', 'P2', '--apply', ...rootArgs]);
});
