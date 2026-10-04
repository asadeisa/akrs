import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertFindingsMatchCatalog } from '../road/support.js';
import { validateMutationChanges } from '../../lib/schemas/packet.js';
import { VERIFICATION_POLICIES } from '../../lib/schemas/verification.js';
import { readContract } from '../../lib/store/verification/index.js';
import {
  contractFile, contractInput, define, everything, invalidContract, planWorld, reasons, seedRoad, strict,
} from './support.js';

const strip = ({ meta: _meta, ...rest }) => rest;

test('the contract round-trips every field the Leader supplied (scenario included) and nothing else', async (t) => {
  const repo = await planWorld(t);
  const input = await contractInput();
  const result = await define(repo, 'P6', input);
  assert.equal(result.outcome, 'committed');
  const { packet } = result;
  assert.deepEqual(packet.changed, ['verifications/P6/contract.json']);
  assert.equal(validateMutationChanges(packet, packet.changed).ok, true);
  assert.deepEqual(packet.data.contract, {
    plan: 'P6', tier: 'plan', path: 'akrs/verifications/P6/contract.json', policy: 'measured', roads: ['R-P6-1', 'R-P6-2'], created: true,
    contract_hash: packet.data.contract.contract_hash,
  });
  const stored = JSON.parse(await contractFile(repo));
  assert.deepEqual(strip(stored), input, 'launch, setup, teardown, reads order, measurements, evidence types, reachability, boundaries, timeout and scenario are exactly as supplied');
  assert.equal(stored.meta.content_hash, packet.data.contract.contract_hash);
  const read = await readContract({ ...repo.options, key: 'P6' });
  assert.equal(read.meta_state, 'declared');
  assert.deepEqual(read.issues, []);
});

test('each policy is accepted exactly as named; an unknown policy is a usage error', async (t) => {
  assert.deepEqual([...VERIFICATION_POLICIES], ['none', 'checks', 'live', 'measured']);
  for (const [policy, extra] of [['none', {}], ['checks', {}], ['live', {}], ['measured', {}]]) {
    const repo = await planWorld(t);
    const base = await contractInput(policy === 'none' ? 'valid/policy-none' : 'valid/full', { plan: 'P6', roads: ['R-P6-1'], ...extra });
    const result = await define(repo, 'P6', { ...base, policy, ...(['none', 'checks'].includes(policy) ? { launch: null, measurements: [], scenario: [] } : {}) });
    assert.equal(result.outcome, 'committed', `${policy}: ${JSON.stringify(result.packet.findings.map(({ message }) => message))}`);
    assert.equal(JSON.parse(await contractFile(repo)).policy, policy);
  }
  const repo = await planWorld(t);
  const bad = await define(repo, 'P6', { ...(await contractInput()), policy: 'sometimes' });
  assert.equal(bad.packet.data.kind, 'usage');
});

test('a live or measured policy missing required fields writes nothing', async (t) => {
  for (const name of ['live-without-launch', 'measured-without-measurements']) {
    const repo = await planWorld(t);
    const before = await strict(repo);
    const document = { ...(await invalidContract(name)), plan: 'P6', roads: ['R-P6-1'] };
    const { meta: _meta, ...input } = document;
    const result = await define(repo, 'P6', input);
    assert.equal(result.outcome, 'rejected', name);
    assert.equal(result.packet.data.kind, 'usage', name);
    assert.deepEqual(await strict(repo), before, name);
  }
});

test('identity and sources are judged before any write: unknown Plan, missing or foreign Road, unresolved read', async (t) => {
  const repo = await planWorld(t);
  await seedRoad(repo, { id: 'R-OTHER', plan: 'P9' }, { folder: 'roads/P9', status: 'ACTIVE' });
  const input = await contractInput('valid/full', { roads: ['R-P6-1'] });
  const cases = [
    ['unknown_plan', 'P7', { ...input, plan: 'P7' }],
    ['road_missing', 'P6', { ...input, roads: ['R-NOPE'] }],
    ['road_wrong_plan', 'P6', { ...input, roads: ['R-OTHER'] }],
    ['read_unresolved', 'P6', { ...input, reads: [{ path: 'SOT/09-use-cases.md', lines: [40, 90], why: null }] }],
  ];
  for (const [reason, key, document] of cases) {
    const before = await everything(repo);
    const result = await define(repo, key, document);
    assert.equal(result.outcome, 'rejected', reason);
    assert.equal(reasons(result.packet).includes(reason), true, `${reason}: ${JSON.stringify(result.packet.findings.map(({ message }) => message))}`);
    assertFindingsMatchCatalog(result.packet);
    assert.deepEqual(await everything(repo), before, reason);
  }
  const mismatch = await define(repo, 'P6', { ...input, plan: 'P8' });
  assert.equal(mismatch.packet.data.kind, 'usage');
});

test('the no-Plan tier is keyed by the single Road', async (t) => {
  const repo = await planWorld(t);
  await seedRoad(repo, { id: 'R-ONLY-1' }, { status: 'ACTIVE' });
  const input = await contractInput('valid/policy-none');
  const result = await define(repo, 'R-ONLY-1', input);
  assert.equal(result.outcome, 'committed', JSON.stringify(result.packet.findings.map(({ message }) => message)));
  assert.equal(result.packet.data.contract.tier, 'road');
  assert.deepEqual(result.packet.changed, ['verifications/R-ONLY-1/contract.json']);
  const wider = await define(repo, 'R-ONLY-1', { ...input, roads: ['R-ONLY-1', 'R-P6-1'] });
  assert.equal(reasons(wider.packet).includes('road_wrong_plan'), true);
});

test('replacing needs the snapshot: missing, stale and a retried identical request is a noop; a guarded one replaces', async (t) => {
  const repo = await planWorld(t);
  const input = await contractInput('valid/full', { roads: ['R-P6-1'] });
  await define(repo, 'P6', input);
  const first = await contractFile(repo);
  const next = { ...input, acceptance: ['A new statement.'] };
  const before = await everything(repo);
  const missing = await define(repo, 'P6', next);
  assert.deepEqual(reasons(missing.packet), ['snapshot_required']);
  const stale = await define(repo, 'P6', next, { expectedSnapshot: `sha256:${'0'.repeat(64)}` });
  assert.equal(stale.packet.status, 'blocked');
  const snapshot = (await import('../../lib/store/snapshots/index.js')).commandSnapshot;
  const guard = (await snapshot('test-define', { ...repo.options, target: { plan: 'P6' } })).snapshot;
  const same = await define(repo, 'P6', input, { expectedSnapshot: guard });
  assert.equal(same.packet.status, 'noop', 'the identical request replays from the journal');
  assert.equal(await contractFile(repo), first);
  assert.deepEqual(await everything(repo), before);
  const dry = await define(repo, 'P6', next, { dryRun: true });
  assert.equal(dry.outcome, 'dry_run');
  assert.equal(dry.packet.data.contract.created, false);
  assert.equal(await contractFile(repo), first);
  const done = await define(repo, 'P6', next, { expectedSnapshot: guard });
  assert.equal(done.outcome, 'committed');
  assert.deepEqual(JSON.parse(await contractFile(repo)).acceptance, ['A new statement.']);
});

test('the same request retried creates the contract once', async (t) => {
  const repo = await planWorld(t);
  const input = await contractInput('valid/full', { roads: ['R-P6-1'] });
  const first = await define(repo, 'P6', input, { requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
  const again = await define(repo, 'P6', input, { requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
  assert.equal(first.outcome, 'committed');
  assert.equal(again.packet.status, 'noop');
  assert.equal(again.packet.request_id, first.packet.request_id);
});
