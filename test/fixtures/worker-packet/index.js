// P2-W01 golden: the complete Worker and Leader packets of a fixed world, byte-compared to committed JSON. The data is
// root-independent (repository-relative paths, content snapshots), so the same bytes must come out on every platform.
// Regenerate with AKRS_REGENERATE_ROAD_DETAILS=1 only after reviewing why the contract changed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { details, packetWorld } from '../../road-details/support.js';

const GOLDEN = new URL('./expected.json', import.meta.url);
const normalized = (packet, repo) => JSON.parse(JSON.stringify({
  status: packet.status, snapshot: packet.snapshot, data: packet.data, findings: packet.findings, next_commands: packet.next_commands,
}).replaceAll(JSON.stringify(repo.root).slice(1, -1), '<root>'));

async function produce(t) {
  const { repo } = await packetWorld(t);
  const out = {};
  for (const [name, args] of [['worker', []], ['worker_pointers', ['--no-include-reads']], ['leader', ['--role', 'leader']], ['leader_full', ['--role', 'leader', '--full']]]) {
    out[name] = normalized((await details(repo, 'R-P6-1', args)).packet, repo);
  }
  return out;
}

test('the committed worker-packet golden equals what the CLI produces for the fixed world', async (t) => {
  const actual = await produce(t);
  if (process.env.AKRS_REGENERATE_ROAD_DETAILS === '1') await writeFile(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(actual, JSON.parse(await readFile(GOLDEN, 'utf8')));
});

test('the golden Worker packet lists the declared reads in authored order with their inlined windows and no other source', async () => {
  const golden = JSON.parse(await readFile(GOLDEN, 'utf8'));
  assert.deepEqual(golden.worker.data.reads.map(({ path, window }) => [path, window.lines]), [['SOT/09-use-cases.md', [28, 41]], ['app/config/payment-status.ts', [12, 25]]]);
  assert.equal(golden.worker.data.reads[0].text.split('\n').length, 14);
  assert.equal(golden.worker_pointers.data.reads.every(({ text }) => text === null), true);
  assert.equal(golden.leader.data.reads.every(({ text }) => text === null), true);
  assert.equal(golden.leader_full.data.reads.every(({ text }) => typeof text === 'string'), true);
});
