import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ledgerUrl = new URL('./bug-disposition.json', import.meta.url);
const allowedStatuses = new Set(['active', 'retired', 'relocated']);

test('bug disposition ledger covers B1 through B26 exactly once', async () => {
  const entries = JSON.parse(await readFile(ledgerUrl, 'utf8'));
  const expectedIds = Array.from({ length: 26 }, (_, index) => `B${index + 1}`);
  const actualIds = entries.map((entry) => entry.bugId);

  assert.deepEqual(actualIds, expectedIds);
  assert.equal(new Set(actualIds).size, 26);
  for (const entry of entries) {
    assert.equal(allowedStatuses.has(entry.status), true, `${entry.bugId} has an invalid status`);
    assert.match(entry.finalClosurePacket, /^P[0-2]-W\d{2}$/);
  }
});

test('retired and relocated defects retain their locked disposition', async () => {
  const entries = JSON.parse(await readFile(ledgerUrl, 'utf8'));
  const byStatus = Object.groupBy(entries, (entry) => entry.status);

  assert.deepEqual(byStatus.retired.map((entry) => entry.bugId), ['B2', 'B17', 'B18', 'B20', 'B21']);
  assert.deepEqual(byStatus.relocated.map((entry) => entry.bugId), ['B25', 'B26']);
  assert.equal(byStatus.active.length, 19);
  for (const entry of byStatus.active) assert.match(entry.finalClosurePacket, /^P0-/);
});
