// P2-W03: the closed `data` schema of `verify --road`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VERIFY_ROAD_KEYS, validateVerifyRoad } from '../../lib/schemas/verify-road.js';
import { nodeCheck, verify, verifyWorld } from './support.js';

test('real result and dry-run data validate against the closed schema; an unknown or missing key is reported', async (t) => {
  const { repo } = await verifyWorld(t, [nodeCheck('ok', 'process.stdout.write("x")'), nodeCheck('bad', 'process.exit(2)')]);
  const ran = (await verify(repo)).packet.data;
  const dry = (await verify(repo, ['--dry-run'])).packet.data;
  const blocked = (await verify(repo, ['--check', 'nope'])).packet.data;
  for (const data of [ran, dry, blocked]) assert.deepEqual(validateVerifyRoad(data), { ok: true, issues: [] }, JSON.stringify(validateVerifyRoad(data).issues));
  assert.deepEqual(Object.keys(ran).sort(), [...VERIFY_ROAD_KEYS].sort());
  assert.equal(validateVerifyRoad({ ...ran, verdict: 'pass' }).ok, false);
  const { note: _note, ...missing } = ran;
  assert.equal(validateVerifyRoad(missing).ok, false);
  assert.equal(validateVerifyRoad({ ...ran, mode: 'tester' }).ok, false);
  const bad = structuredClone(ran);
  bad.checks[0].status = 'verified';
  assert.equal(validateVerifyRoad(bad).ok, false);
  const passedWithFailure = structuredClone(ran);
  passedWithFailure.checks[1].status = 'passed';
  assert.equal(validateVerifyRoad(passedWithFailure).ok, false, 'a passed check cannot carry a non-zero exit code');
});
