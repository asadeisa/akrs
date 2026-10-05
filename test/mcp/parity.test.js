// P2-W15 parity: a tool result is the CLI. structuredContent equals `akrs <twin argv>` (which ends in --json) for the same input and the
// same providers, the text block is the prompt rendering of that packet, isError follows the CLI exit code, and a mutation through MCP
// obeys the lease, the journal and the transaction exactly like the CLI (same final workflow bytes).
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { renderPrompt } from '../../lib/renderers/prompt.js';
import { ROAD, closures, done, edit, statusOf, work, workWorld } from '../intents/support.js';
import { fakeProviders } from '../idempotency/support.js';
import { cliTwin, inProcess } from './support.js';

const knownCommands = commandManifest.commands.map(({ id }) => id);
const commandTokens = new Map(commandManifest.commands.map(({ id, tokens }) => [id, tokens]));

// one MCP call and its CLI twin on the same repository, each with fresh providers from the same start
async function both(repo, tool, args) {
  const client = inProcess({ root: repo.root, providers: fakeProviders({ firstId: 5000 }) });
  await client.legacy();
  const result = await client.call(tool, args);
  const { argv } = client.server.lastCall;
  const twin = await cliTwin(argv, { cwd: repo.root, providers: fakeProviders({ firstId: 5000 }) });
  return { result, twin, argv };
}

function assertParity({ result, twin, argv }) {
  assert.deepEqual(result.structuredContent, twin.packet, argv.join(' '));
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].text, renderPrompt(twin.packet, { knownCommands, commandTokens }));
  assert.equal(result.isError, twin.exitCode >= 2, `exit ${twin.exitCode}`);
}

test('queries: structuredContent is the CLI --json packet and the text is its prompt rendering', async (t) => {
  const { repo } = await workWorld(t);
  for (const [tool, args, expected] of [
    ['akrs_status', { action: 'status' }, 'ok'],
    ['akrs_status', { action: 'next', executor: 'flash' }, 'ok'],
    ['akrs_status', { action: 'validate' }, null],
    ['akrs_status', { action: 'explain', id: 'AKRS-R026' }, 'ok'],
    ['akrs_status', { action: 'graph' }, 'ok'],
    ['akrs_status', { action: 'boot' }, null],
    ['akrs_road', { action: 'details', id: ROAD, role: 'worker' }, null],
    ['akrs_road', { action: 'check', id: ROAD }, null],
    ['akrs_road', { action: 'template', kind: 'road', class: 'weak' }, 'ok'],
    ['akrs_scope', { action: 'list' }, 'ok'],
  ]) {
    const pair = await both(repo, tool, args);
    assertParity(pair);
    if (expected !== null) assert.equal(pair.result.structuredContent.status, expected, `${tool} ${args.action}`);
    assert.equal(pair.argv.at(-1), '--json');
  }
});

test('a blocked packet is a successful tool result carrying its status; a usage error is a tool error with the finding code', async (t) => {
  const { repo } = await workWorld(t);
  assert.equal((await work(repo)).packet.status, 'ok');
  // another executor asks for the held Road: blocked, exit 1, not a protocol error
  const blocked = await both(repo, 'akrs_work', { action: 'work', road: ROAD, executor: 'flash2' });
  assertParity(blocked);
  assert.deepEqual([blocked.result.structuredContent.status, blocked.twin.exitCode, blocked.result.isError], ['blocked', 1, false]);
  // a handler-level usage error (an unknown finding code): exit 2, isError, AKRS-C001
  const usage = await both(repo, 'akrs_status', { action: 'explain', id: 'AKRS-Z999' });
  assertParity(usage);
  assert.deepEqual([usage.twin.exitCode, usage.result.isError, usage.result.structuredContent.findings[0].code], [2, true, 'AKRS-C001']);
});

test('a missing workflow is a tool error with AKRS-C003, like exit 3', async (t) => {
  const { repo } = await workWorld(t);
  const client = inProcess({ root: repo.path('src'), cwd: repo.root, providers: fakeProviders({ firstId: 5000 }) });
  await client.legacy();
  const result = await client.call('akrs_status', { action: 'status' });
  const twin = await cliTwin(client.server.lastCall.argv, { cwd: repo.root, providers: fakeProviders({ firstId: 5000 }) });
  assert.equal(twin.exitCode, 3);
  assert.deepEqual(result.structuredContent, twin.packet);
  assert.deepEqual([result.isError, result.structuredContent.findings[0].code], [true, 'AKRS-C003']);
});

async function files(directory, prefix = '') {
  const found = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => (left.name < right.name ? -1 : 1))) {
    if (['.git', '.ops', '.cache'].includes(entry.name)) continue;
    if (entry.isDirectory()) found.push(...await files(join(directory, entry.name), `${prefix}${entry.name}/`));
    else found.push(`${prefix}${entry.name}`);
  }
  return found;
}
const normalize = (text) => text
  .replace(/01ARZ3NDEKTSV4RRFFQ6\d{6}/g, '<id>')
  .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<ts>')
  .replace(/"hash":"sha256:[0-9a-f]{64}"/g, '"hash":"<hash>"');
async function canonicalState(repo) {
  const state = {};
  for (const path of await files(repo.root)) {
    if (path.startsWith('src/') || path.startsWith('SOT/') || path.startsWith('app/')) continue;
    state[path] = normalize(await readFile(repo.path(path), 'utf8'));
  }
  return state;
}

test('a mutation through MCP obeys the lease, the journal and the transaction exactly like the CLI', async (t) => {
  const { repo: viaCli } = await workWorld(t);
  const { repo: viaMcp } = await workWorld(t);
  const client = inProcess({ root: viaMcp.root, providers: viaMcp.providers });
  await client.legacy();

  // claim: the lease is the guard for both; a second executor is refused the same way
  assert.equal((await work(viaCli)).packet.status, 'ok');
  const claimed = await client.call('akrs_work', { action: 'work', executor: 'flash' });
  assert.deepEqual([claimed.isError, claimed.structuredContent.status], [false, 'ok']);
  const contested = await client.call('akrs_work', { action: 'work', road: ROAD, executor: 'flash2' });
  assert.equal(contested.structuredContent.status, 'blocked');
  assert.equal(JSON.stringify(contested.structuredContent).includes('flash'), true, 'the holder is named');

  // done: no hash, no snapshot, no request ID; checks, audit, handoff, finish and closure in one transaction
  await edit(viaCli);
  await edit(viaMcp);
  const cliDone = await done(viaCli);
  assert.equal(cliDone.packet.status, 'ok', cliDone.stdout);
  const mcpDone = await client.call('akrs_work', {
    action: 'done', road: ROAD, executor: 'flash', result: 'the admin page is ready', reach: '["open /admin"]', expect: 'a table of users',
  });
  assert.equal(mcpDone.structuredContent.status, 'ok', JSON.stringify(mcpDone.structuredContent.findings));
  assert.deepEqual(mcpDone.structuredContent.changed, cliDone.packet.changed);

  assert.equal(await statusOf(viaMcp), 'DONE');
  assert.equal(await viaMcp.read(`akrs/roads/P6/${ROAD}.json`), await viaCli.read(`akrs/roads/P6/${ROAD}.json`), 'the Road file is byte-identical');
  assert.deepEqual(await canonicalState(viaMcp), await canonicalState(viaCli));
  const strip = ({ id, hash, ts, ...rest }) => rest;
  assert.deepEqual((await closures(viaMcp)).map(strip), (await closures(viaCli)).map(strip));

  // a retry of the committed done replays from the journal as a noop, through both surfaces
  const cliAgain = await done(viaCli);
  const mcpAgain = await client.call('akrs_work', { action: 'done', road: ROAD, executor: 'flash', result: 'the admin page is ready', reach: ['open /admin'], expect: 'a table of users' });
  assert.equal(mcpAgain.structuredContent.status, cliAgain.packet.status);
  assert.equal(mcpAgain.structuredContent.status, 'noop');
  assert.deepEqual(await canonicalState(viaMcp), await canonicalState(viaCli));
});
