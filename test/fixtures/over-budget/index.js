// P2-W01 golden: --max-tokens refuses a complete packet that does not fit and drops nothing, across the whole range of
// limits around the packet size. The numbers come from the frozen deterministic estimator.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateTokens } from '../../../lib/store/executors/index.js';
import { details, packetWorld, readEntry, strict } from '../../road-details/support.js';

const lines = (count) => Array.from({ length: count }, (_, index) => `سطر ${index + 1} — 数据 ${index + 1} line ${index + 1}`).join('\n');

test('every limit below the complete packet size is refused whole, every limit at or above it returns the whole packet', async (t) => {
  const { repo } = await packetWorld(t, { reads: [readEntry('SOT/big.md', [1, 40], 'a large declared window'), readEntry('SOT/02-rules.md', [1, 10], null)] });
  await repo.write('SOT/big.md', `${lines(60)}\n`);
  const before = await strict(repo);
  const complete = (await details(repo, 'R-P6-1')).packet;
  const size = complete.data.budget.packet_tokens;
  assert.ok(size > estimateTokens(complete.data.reads[0].text), 'the packet is larger than its biggest window alone');
  assert.equal(complete.data.budget.estimated_tokens, complete.data.reads.reduce((sum, { text }) => sum + estimateTokens(text ?? ''), 0));

  for (const limit of new Set([1, 2, Math.floor(size / 2), size - 2, size - 1])) {
    if (limit < 1) continue;
    const refused = await details(repo, 'R-P6-1', ['--max-tokens', String(limit)]);
    assert.equal(refused.exitCode, 1, `limit ${limit}`);
    assert.equal(refused.packet.status, 'blocked');
    assert.deepEqual(refused.packet.data.refusal, { max_tokens: limit, packet_tokens: size });
    assert.equal(Object.hasOwn(refused.packet.data, 'reads'), false, 'no partial reads are delivered');
    assert.equal(JSON.stringify(refused.packet).includes('سطر 1 —'), false, 'no window text leaks into a refusal');
  }
  for (const limit of [size, size + 1, size * 10]) {
    const kept = await details(repo, 'R-P6-1', ['--max-tokens', String(limit)]);
    assert.equal(kept.exitCode, 0, `limit ${limit}`);
    assert.deepEqual(kept.packet.data.reads, complete.data.reads, 'nothing was dropped');
    assert.equal(kept.packet.data.budget.max_tokens, limit);
  }
  assert.equal(await strict(repo), before);
});

test('the Leader view counts its own (smaller) packet; --full is bigger and refused first', async (t) => {
  const { repo } = await packetWorld(t);
  const base = (await details(repo, 'R-P6-1', ['--role', 'leader'])).packet.data.budget.packet_tokens;
  const full = (await details(repo, 'R-P6-1', ['--role', 'leader', '--full'])).packet.data.budget.packet_tokens;
  assert.ok(full > base);
  assert.equal((await details(repo, 'R-P6-1', ['--role', 'leader', '--max-tokens', String(base)])).exitCode, 0);
  assert.equal((await details(repo, 'R-P6-1', ['--role', 'leader', '--full', '--max-tokens', String(base)])).exitCode, 1);
});
