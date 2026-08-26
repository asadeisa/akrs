import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { renderHuman } from '../../../lib/renderers/human.js';
import { renderPrompt } from '../../../lib/renderers/prompt.js';

const load = (name) => readFile(new URL(name, import.meta.url), 'utf8');
const packet = JSON.parse(await load('packet.json'));

test('human and prompt goldens project the same injected packet without mutation', async () => {
  const before = structuredClone(packet);
  assert.equal(renderHuman(packet, { knownCommands: ['help', 'probe'] }), await load('human.txt'));
  assert.equal(renderPrompt(packet, { knownCommands: ['help', 'probe'] }), await load('prompt.txt'));
  assert.deepEqual(packet, before);
});
