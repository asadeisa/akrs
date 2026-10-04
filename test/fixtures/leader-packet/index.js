// P2-W02 golden: the Leader packet of a crowded world (collision, recent closure, convention, pending request) and its
// human and prompt renderings, byte-compared to committed files. Regenerate with AKRS_REGENERATE_ROAD_DETAILS=1 only
// after reviewing why the contract changed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { commandManifest } from '../../../lib/commands/manifest.js';
import { renderRoadDetailsHuman, renderRoadDetailsPrompt } from '../../../lib/renderers/road-details.js';
import { request } from '../../change/support.js';
import { closure } from '../../log/support.js';
import { memoryRow, seedMemory } from '../../memory/support.js';
import { details, fileWrite, packetWorld, readEntry, seedRoad } from '../../road-details/support.js';

const GOLDEN = new URL('./expected.json', import.meta.url);
const options = { knownCommands: commandManifest.commands.map(({ id }) => id), commandTokens: new Map(commandManifest.commands.map(({ id, tokens }) => [id, tokens])) };
const unroot = (value, repo) => JSON.parse(JSON.stringify(value).replaceAll(JSON.stringify(repo.root).slice(1, -1), '<root>'));

async function produce(t) {
  const { repo } = await packetWorld(t);
  await seedRoad(repo, { id: 'R-P6-2', plan: 'P6', task: null, deps: [], reads: [], writes: [fileWrite('src/admin.js', 'modify')], forbidden: [] }, { folder: 'roads/P6', status: 'ACTIVE' });
  await seedRoad(repo, { id: 'R-P6-3', plan: 'P6', task: null, deps: [], reads: [readEntry('src/own.js', null, 'reads the page')], writes: [fileWrite('out/R-P6-3.js')], forbidden: [] }, { folder: 'roads/P6', status: 'QUEUED' });
  await closure(repo, { subject: 'R-P5-6', outcome: 'DONE', deviations: 'used the adapter' });
  await seedMemory(repo, 'payments', [memoryRow({ id: '01ARZ3NDEKTSV4RRFFQ69G5FA1', label: 'Decided', decided_by: 'P5', text: 'Paid state comes from the settlement event.', pointers: [{ path: 'SOT/09-use-cases.md', lines: [30, 31] }] })]);
  await request(repo, { road: 'R-P6-1', add_reads: [readEntry('SOT/02-rules.md')], reason: 'The rules file defines the flag.' });
  const { packet } = await details(repo, 'R-P6-1', ['--role', 'leader', '--reuse']);
  const body = unroot({ status: packet.status, snapshot: packet.snapshot, data: packet.data, findings: packet.findings, next_commands: packet.next_commands }, repo);
  return {
    packet: body,
    prompt: unroot(renderRoadDetailsPrompt(packet, options), repo),
    human: unroot(renderRoadDetailsHuman(packet, options), repo),
  };
}

test('the committed leader-packet golden equals what the CLI and the renderers produce for the fixed world', async (t) => {
  const actual = await produce(t);
  if (process.env.AKRS_REGENERATE_ROAD_DETAILS === '1') await writeFile(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(actual, JSON.parse(await readFile(GOLDEN, 'utf8')));
});

test('the golden Leader packet exposes the relation facts the Leader decides on', async () => {
  const golden = JSON.parse(await readFile(GOLDEN, 'utf8'));
  const { data } = golden.packet;
  assert.deepEqual(data.collisions.map(({ road, kind }) => [road, kind]), [['R-P6-2', 'write_write'], ['R-P6-3', 'my_write_their_read']]);
  assert.deepEqual(data.recent.map(({ subject }) => subject), ['R-P5-6']);
  assert.equal(data.conventions.length, 1);
  assert.equal(data.scope_requests.filter(({ state }) => state === 'pending').length, 1);
  assert.deepEqual(data.stale, []);
  for (const heading of ['## Readiness', '## Collisions', '## Recent closures', '## Conventions', '## Scope requests', '## Audit']) assert.equal(golden.prompt.includes(heading), true, heading);
});
