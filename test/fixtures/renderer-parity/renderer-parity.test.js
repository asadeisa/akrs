import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { renderHuman } from '../../../lib/renderers/human.js';
import { renderPrompt } from '../../../lib/renderers/prompt.js';
import { commandManifest } from '../../../lib/commands/manifest.js';
import { WEAK_PROMPT_OVERHEAD_CEILING_TOKENS, renderRoadDetailsHuman, renderRoadDetailsPrompt } from '../../../lib/renderers/road-details.js';
import { estimateTokens } from '../../../lib/store/executors/index.js';
import { details, packetWorld } from '../../road-details/support.js';

const load = (name) => readFile(new URL(name, import.meta.url), 'utf8');
const packet = JSON.parse(await load('packet.json'));

test('human and prompt goldens project the same injected packet without mutation', async () => {
  const before = structuredClone(packet);
  assert.equal(renderHuman(packet, { knownCommands: ['help', 'probe'] }), await load('human.txt'));
  assert.equal(renderPrompt(packet, { knownCommands: ['help', 'probe'] }), await load('prompt.txt'));
  assert.deepEqual(packet, before);
});

// P2-W02: the Worker prompt per executor class, and the frozen weak-class overhead (Amendment A1, AX gate 7).
const TEXT_OPTIONS = { knownCommands: commandManifest.commands.map(({ id }) => id), commandTokens: new Map(commandManifest.commands.map(({ id, tokens }) => [id, tokens])) };
const unroot = (text, repo) => text.replaceAll(repo.root, '<root>');

async function classPacket(t, executorClass) {
  const { repo } = await packetWorld(t, { executor_class: executorClass });
  return { repo, packet: (await details(repo, 'R-P6-1')).packet };
}

for (const executorClass of ['weak', 'medium', 'frontier']) {
  test(`the ${executorClass} Worker prompt and human goldens project the exact --json packet`, async (t) => {
    const { repo, packet } = await classPacket(t, executorClass);
    const before = structuredClone(packet);
    const prompt = unroot(renderRoadDetailsPrompt(packet, TEXT_OPTIONS), repo);
    const human = unroot(renderRoadDetailsHuman(packet, TEXT_OPTIONS), repo);
    const files = [[`road-details-${executorClass}.prompt.txt`, prompt], [`road-details-${executorClass}.human.txt`, human]];
    if (process.env.AKRS_REGENERATE_ROAD_DETAILS === '1') for (const [name, text] of files) await writeFile(new URL(name, import.meta.url), text);
    for (const [name, text] of files) assert.equal(text, await load(name), name);
    assert.deepEqual(packet, before);
  });
}

test('the weak-class prompt overhead, without the declared read bodies, stays under the frozen ceiling', async (t) => {
  const { packet } = await classPacket(t, 'weak');
  const prompt = renderRoadDetailsPrompt(packet, TEXT_OPTIONS);
  const bodies = packet.data.reads.reduce((sum, read) => sum + (read.text === null ? 0 : estimateTokens(read.text)), 0);
  const overhead = estimateTokens(prompt) - bodies;
  t.diagnostic(`weak prompt overhead ${overhead} tokens (ceiling ${WEAK_PROMPT_OVERHEAD_CEILING_TOKENS})`);
  assert.ok(bodies > 0, 'the weak class inlines its declared reads');
  assert.ok(overhead <= WEAK_PROMPT_OVERHEAD_CEILING_TOKENS, `overhead ${overhead} exceeds ${WEAK_PROMPT_OVERHEAD_CEILING_TOKENS}`);
  assert.ok(overhead > WEAK_PROMPT_OVERHEAD_CEILING_TOKENS / 3, 'the ceiling is a real bound, not slack');
});
