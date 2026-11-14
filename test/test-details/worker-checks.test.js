// Dogfood finding 7: a check the Worker's `done` ran is no longer shown as "no result". Without a Tester result the packet carries the
// Worker's stored outcome (source worker), current only while the Road's product bytes are unchanged; a Tester result always wins.
import assert from 'node:assert/strict';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { HANDOFF_SPEC } from '../../lib/schemas/handoff-result.js';
import { validateTestDetails } from '../../lib/schemas/test-details.js';
import { encodeJsonlRecord } from '../../lib/store/canonical/index.js';
import { computeSnapshot } from '../../lib/store/snapshots/index.js';
import { renderTestDetailsHuman } from '../../lib/renderers/test-details.js';
import { KNOWN_COMMANDS } from '../road/support.js';
import { ULID, details, seedResult, snapshotOf, testerWorld } from './support.js';

const productOf = async (repo, road) => (await computeSnapshot({ ...repo.options, projections: ['road-writes'], target: { road } })).snapshot;

// A handoff as `done` writes it (the writer is covered by test/intents/done.test.js), appended through the codec.
async function seedHandoff(repo, n, road, checks) {
  const line = encodeJsonlRecord({
    id: ULID(n), ts: '2026-10-03T10:00:00.000Z', road, snapshot: `sha256:${'a'.repeat(64)}`, result: `${road} is ready.`, reach: [`Open /${road}`], expect: 'It works.', checks, ready: true,
  }, HANDOFF_SPEC);
  const path = repo.path('akrs/verifications/P6/handoff.jsonl');
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line);
}

const lastOf = (packet) => Object.fromEntries(packet.data.checks.map(({ road, last_result: last }) => [road, last]));

test('a Worker done result is shown as the Worker\'s, current until the product bytes change, and a Tester result wins', async (t) => {
  const repo = await testerWorld(t, { handoffs: false });
  await seedHandoff(repo, 101, 'R-P6-1', { product_snapshot: await productOf(repo, 'R-P6-1'), results: [{ name: 'unit', passed: true, exit_code: 0 }] });
  await seedHandoff(repo, 102, 'R-P6-2', null);

  const first = await details(repo);
  assert.equal(validateTestDetails(first.packet.data).ok, true, JSON.stringify(validateTestDetails(first.packet.data).issues));
  assert.deepEqual(lastOf(first.packet), {
    'R-P6-1': { source: 'worker', result: ULID(101), passed: true, exit_code: 0, current: true },
    'R-P6-2': null,
  });
  const human = renderTestDetailsHuman(first.packet, { knownCommands: KNOWN_COMMANDS });
  assert.match(human, /R-P6-1 unit: .* Worker done passed \(the Worker's own run, not a Tester verdict\)/);
  assert.match(human, /R-P6-2 unit: .* no result recorded yet/);

  // the product changes after the done: the Worker result is kept but no longer current
  const road = JSON.parse(await repo.read('akrs/roads/P6/R-P6-1.json'));
  await repo.write(road.writes[0].path, 'changed after done\n');
  const changed = await details(repo);
  assert.equal(lastOf(changed.packet)['R-P6-1'].current, false);

  // a Tester result that names the check wins over the Worker's
  const hash = JSON.parse(await repo.read('akrs/verifications/P6/contract.json')).meta.content_hash;
  await seedResult(repo, 'P6', { n: 103, tested_snapshot: await snapshotOf(repo), contract_hash: hash, checks: [{ name: 'unit', passed: false, exit_code: 1 }] });
  const tested = await details(repo);
  assert.equal(tested.packet.status, 'ok', tested.stdout + tested.stderr);
  assert.deepEqual(lastOf(tested.packet)['R-P6-1'], { source: 'tester', result: ULID(103), passed: false, exit_code: 1, current: true });
});
