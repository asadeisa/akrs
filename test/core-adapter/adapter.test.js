// P2-W09 step 4: a future adapter calls each core handler without the binary: the handler takes parameters and returns the packet,
// and the packet is the same one the CLI prints.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { commandHandlers } from '../../lib/commands/meta.js';
import { createPacket } from '../../lib/core/packet.js';
import { navWorld, query } from '../navigation/support.js';

const parametersFor = (repo, id, positionals = {}, flags = {}) => ({
  context: { cwd: repo.root },
  input: { positionals, flags: { '--root': repo.root, ...flags }, stdin: false },
  manifest: commandManifest,
  providers: repo.providers,
  readStdin: async () => Buffer.alloc(0),
});

test('every navigation handler returns a valid packet when called directly, equal to the CLI packet', async (t) => {
  const repo = await navWorld(t);
  const calls = [
    ['status', {}, {}, ['status']],
    ['next', {}, {}, ['next']],
    ['where', { path: 'src/own.js' }, {}, ['where', 'src/own.js']],
    ['graph', {}, {}, ['graph']],
    ['stale', {}, {}, ['stale']],
    ['log', {}, {}, ['log']],
  ];
  for (const [id, positionals, flags, argv] of calls) {
    assert.equal(typeof commandHandlers[id], 'function', `${id} has a handler`);
    const direct = await commandHandlers[id](parametersFor(repo, id, positionals, flags));
    const viaCli = (await query(repo, argv)).packet;
    assert.equal(direct.command, id);
    const strip = (packet) => JSON.stringify({ ...packet, run_id: null, timestamp: null, request_id: null });
    assert.equal(strip(direct), strip(viaCli), id);
    assert.equal(typeof createPacket, 'function');
  }
});

test('the handlers are the only place that reads flags: bad input is a usage error before any projection runs', async (t) => {
  const repo = await navWorld(t);
  await assert.rejects(() => commandHandlers.where(parametersFor(repo, 'where', { path: '../x' })), /path/i);
  await assert.rejects(() => commandHandlers.next(parametersFor(repo, 'next', {}, { '--executor': 'not an id' })), /executor/i);
});
