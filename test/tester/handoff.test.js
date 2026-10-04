import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HANDOFF_SPEC, validateHandoff } from '../../lib/schemas/handoff-result.js';
import { decodeJsonl } from '../../lib/store/canonical/index.js';
import { readVerification } from '../../lib/store/verification/index.js';
import { assertFindingsMatchCatalog } from '../road/support.js';
import {
  contractFile, contractInput, define, everything, handoff, handoffLines, planWorld, reasons, request, runCommand, seedRoad, strict,
} from './support.js';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

test('a handoff records the exact Road, snapshot, result, reach, expect and readiness; the CLI fills what the agent never types', async (t) => {
  const repo = await planWorld(t);
  await define(repo, 'P6', await contractInput('valid/full', { roads: ['R-P6-1'] }));
  const contract = await contractFile(repo);
  const road = await repo.read('akrs/roads/P6/R-P6-1.json');
  const result = await handoff(repo, 'P6', { road: 'R-P6-1', reach: ['Open /admin', 'Click Save'] });
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(result.packet.changed, ['verifications/P6/handoff.jsonl']);
  const [line] = await handoffLines(repo);
  assert.match(line.id, ULID);
  assert.match(line.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(line.road, 'R-P6-1');
  assert.deepEqual(line.reach, ['Open /admin', 'Click Save'], 'reach steps keep their order');
  assert.equal(line.ready, true);
  assert.equal(line.snapshot, result.packet.snapshot.before, 'the Road snapshot at the time of the handoff');
  assert.equal(validateHandoff(line, { form: 'stored' }).ok, true);
  assert.equal(decodeJsonl(await repo.read('akrs/verifications/P6/handoff.jsonl'), () => HANDOFF_SPEC).records[0].state, 'declared');
  assert.equal(await contractFile(repo), contract, 'a handoff never changes acceptance');
  assert.equal(await repo.read('akrs/roads/P6/R-P6-1.json'), road);
  assert.equal(result.packet.data.handoff.line, 1);
});

test('hashes, snapshots and unknown keys in the input are schema errors; nothing is written', async (t) => {
  const repo = await planWorld(t);
  const before = await strict(repo);
  for (const extra of [{ snapshot: `sha256:${'a'.repeat(64)}` }, { hash: `sha256:${'a'.repeat(64)}` }, { ready: true }, { reach: [] }, { result: '' }]) {
    const result = await handoff(repo, 'P6', { road: 'R-P6-1', ...extra });
    assert.equal(result.outcome, 'rejected', JSON.stringify(extra));
    assert.equal(result.packet.data.kind, 'usage', JSON.stringify(extra));
  }
  assert.deepEqual(await strict(repo), before);
});

test('refusals write nothing: missing Road, foreign Road, QUEUED Road, unusable ledger', async (t) => {
  const repo = await planWorld(t);
  await seedRoad(repo, { id: 'R-P6-3', plan: 'P6' }, { folder: 'roads/P6' });
  await seedRoad(repo, { id: 'R-OTHER', plan: 'P9' }, { folder: 'roads/P9', status: 'ACTIVE' });
  const cases = [['road_missing', 'R-NOPE'], ['road_wrong_plan', 'R-OTHER'], ['road_not_started', 'R-P6-3']];
  for (const [reason, road] of cases) {
    const before = await everything(repo);
    const result = await handoff(repo, 'P6', { road });
    assert.equal(result.outcome, 'rejected', reason);
    assert.deepEqual(reasons(result.packet), [reason]);
    assertFindingsMatchCatalog(result.packet);
    assert.deepEqual(await everything(repo), before, reason);
  }
  await repo.write('akrs/verifications/P6/handoff.jsonl', 'broken\n');
  const before = await everything(repo);
  const broken = await handoff(repo, 'P6', { road: 'R-P6-1' });
  assert.deepEqual(reasons(broken.packet), ['ledger_unusable']);
  assert.deepEqual(await everything(repo), before);
});

test('readiness: a pending blocking scope request makes the baton not ready', async (t) => {
  const repo = await planWorld(t);
  await request(repo, { road: 'R-P6-1', add_reads: [{ path: 'src/own.js', lines: null, why: 'needed' }] });
  const blocked = await handoff(repo, 'P6', { road: 'R-P6-1' });
  assert.equal(blocked.packet.data.handoff.ready, false);
  const clear = await handoff(repo, 'P6', { road: 'R-P6-2' });
  assert.equal(clear.packet.data.handoff.ready, true);
});

test('a duplicate is a noop offering --again; --again appends a second record; the no-Plan tier is keyed by the Road', async (t) => {
  const repo = await planWorld(t);
  const first = await handoff(repo, 'P6', { road: 'R-P6-1' });
  const duplicate = await handoff(repo, 'P6', { road: 'R-P6-1' });
  assert.equal(duplicate.packet.status, 'noop');
  assert.equal(duplicate.packet.request_id, first.packet.request_id);
  assert.equal(duplicate.packet.next_commands.some(({ args }) => args.includes('--again')), true);
  assert.equal((await handoffLines(repo)).length, 1);
  const again = await handoff(repo, 'P6', { road: 'R-P6-1' }, { again: true });
  assert.equal(again.outcome, 'committed');
  assert.equal((await handoffLines(repo)).length, 2);
  await seedRoad(repo, { id: 'R-ONLY-1' }, { status: 'ACTIVE' });
  const single = await handoff(repo, 'R-ONLY-1', { road: 'R-ONLY-1' });
  assert.equal(single.outcome, 'committed');
  assert.deepEqual(single.packet.changed, ['verifications/R-ONLY-1/handoff.jsonl']);
});

test('flat flags through the real adapter build the same handoff; the projection API reads contract and handoffs without writing', async (t) => {
  const repo = await planWorld(t);
  await define(repo, 'P6', await contractInput('valid/full', { roads: ['R-P6-1'] }));
  const result = await runCommand(repo, [
    'test', 'handoff', 'P6', '--road', 'R-P6-1', '--result', 'Admin page ready.', '--reach', 'Open /admin', '--reach', 'Click Save', '--expect', 'Saved toast.', '--json',
  ]);
  assert.equal(result.exitCode, 0, result.stdout);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.data.handoff.road, 'R-P6-1');
  assert.deepEqual((await handoffLines(repo))[0].reach, ['Open /admin', 'Click Save']);
  const missing = await runCommand(repo, ['test', 'handoff', 'P6', '--road', 'R-P6-1', '--json']);
  assert.equal(missing.exitCode, 2);
  const both = await runCommand(repo, ['test', 'handoff', 'P6', '--road', 'R-P6-1', '--json', '-'], { stdin: '{}' });
  assert.equal(both.exitCode, 2);
  const before = await strict(repo);
  const view = await readVerification({ ...repo.options, key: 'P6' });
  assert.equal(view.contract.meta_state, 'declared');
  assert.deepEqual(view.handoffs.records.map(({ value }) => value.road), ['R-P6-1']);
  assert.deepEqual(await strict(repo), before);
});
