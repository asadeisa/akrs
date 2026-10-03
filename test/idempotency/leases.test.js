// P1-W04 / F17: the lease store (A1 3.1): files, claim/refresh/release/takeover, freshness deltas, holder
// resolution and expected-snapshot precedence. No command creates leases yet; this is the store API.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { canonicalizeJson } from '../../lib/store/canonical/index.js';
import {
  LEASE_SPEC,
  checkLease,
  claimLease,
  leaseStaleFinding,
  readLease,
  refreshLease,
  releaseLease,
  resolveExpectedSnapshot,
  resolveHolder,
  validateLease,
} from '../../lib/store/leases/index.js';
import { acquireRepositoryLock } from '../../lib/store/lock/index.js';
import {
  TESTER_LEASE_PROJECTION,
  computeSnapshot,
} from '../../lib/store/snapshots/index.js';
import { byteTreeHash } from '../helpers/byte-tree.js';
import { SECRET, jsonText, ROAD_R1 } from '../snapshots/support.js';
import {
  createHarness,
  createIdempotencyWorkflow,
  fakeProviders,
  leaseSnapshotResult,
  listNames,
  ulid,
  walk,
  workflowSnapshot,
} from './support.js';

const SHA = (character) => `sha256:${character.repeat(64)}`;

async function setup(t, extra) {
  const workflow = await createIdempotencyWorkflow(t, extra);
  const providers = fakeProviders();
  const lease = async (road = 'R1') => {
    const result = await leaseSnapshotResult(workflow, road);
    assert.equal(result.status, 'ok');
    return result;
  };
  const claim = async (overrides = {}) => {
    const current = await lease(overrides.target ?? 'R1');
    return claimLease({
      ...workflow.options, providers, kind: 'road', target: 'R1', holder: 'worker-1',
      snapshot: current.snapshot, inventory: current.inventory, requestId: ulid(1), ...overrides,
    });
  };
  return { workflow, providers, lease, claim, leaseFile: (kind, id) => workflow.path('akrs', '.ops', 'leases', kind, `${id}.lease.json`) };
}

test('claiming a Road lease writes a closed canonical akrs.lease/v1 file under .ops/leases/road', async (t) => {
  const { workflow, claim, lease, leaseFile } = await setup(t);
  const current = await lease();
  const result = await claim();
  assert.equal(result.status, 'claimed');
  assert.equal(result.lease.holder, 'worker-1');

  const text = await readFile(leaseFile('road', 'R1'), 'utf8');
  const stored = JSON.parse(text);
  assert.deepEqual(Object.keys(stored), [
    'schema', 'kind', 'target', 'holder', 'snapshot', 'inventory', 'acquired_at', 'refreshed_at', 'request_id',
  ]);
  assert.equal(stored.schema, 'akrs.lease/v1');
  assert.equal(stored.kind, 'road');
  assert.equal(stored.target, 'R1');
  assert.equal(stored.snapshot, current.snapshot);
  assert.deepEqual(stored.inventory, current.inventory);
  assert.equal(stored.acquired_at, stored.refreshed_at);
  assert.equal(stored.request_id, ulid(1));
  assert.equal(text, canonicalizeJson(stored, LEASE_SPEC), 'the file is the canonical encoding');
  assert.equal(validateLease(stored).ok, true, JSON.stringify(validateLease(stored).issues));
  assert.deepEqual(result.lease, stored);
  assert.deepEqual(await readLease({ ...workflow.options, kind: 'road', target: 'R1' }), { status: 'held', lease: stored });
});

test('the lease inventory holds hashes only, never file contents', async (t) => {
  const { workflow, claim, leaseFile } = await setup(t);
  await claim();
  const text = await readFile(leaseFile('road', 'R1'), 'utf8');
  assert.match(await readFile(workflow.path('src/shared.js'), 'utf8'), new RegExp(SECRET), 'the sentinel is in a declared read');
  assert.equal(text.includes(SECRET), false);
  const { inventory } = JSON.parse(text);
  assert.ok(inventory.length > 0);
  for (const entry of inventory) {
    assert.deepEqual(Object.keys(entry), ['projection', 'key', 'kind', 'value']);
    assert.match(entry.value, /^(sha256:[0-9a-f]{64}|[A-Z]+|[a-z_]+)$/);
  }
});

test('a Tester lease is one lease per Plan under .ops/leases/plan', async (t) => {
  const { workflow, providers, leaseFile } = await setup(t);
  const current = await computeSnapshot({ ...workflow.options, projections: TESTER_LEASE_PROJECTION, target: { plan: 'P1' } });
  const result = await claimLease({
    ...workflow.options, providers, kind: 'plan', target: 'P1', holder: 'tester-1',
    snapshot: current.snapshot, inventory: current.inventory, requestId: null,
  });
  assert.equal(result.status, 'claimed');
  assert.equal(JSON.parse(await readFile(leaseFile('plan', 'P1'), 'utf8')).request_id, null);
  assert.deepEqual(await listNames(workflow.path('akrs', '.ops', 'leases')), ['plan']);
  assert.equal((await readLease({ ...workflow.options, kind: 'road', target: 'P1' })).status, 'none');
});

test('claim: the same holder again is a noop claim, another holder is blocked with the holder named', async (t) => {
  const { workflow, claim, lease, leaseFile, providers } = await setup(t);
  const first = await claim();
  const bytes = await readFile(leaseFile('road', 'R1'), 'utf8');

  const same = await claim();
  assert.equal(same.status, 'noop');
  assert.equal(same.refreshed, false);
  assert.equal(await readFile(leaseFile('road', 'R1'), 'utf8'), bytes, 'nothing was rewritten');

  const blocked = await claim({ holder: 'worker-2', requestId: ulid(2) });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.holder, 'worker-1');
  assert.equal(blocked.finding.code, 'AKRS-C012');
  assert.deepEqual(blocked.finding.detail, { kind: 'road', target: 'R1', holder: 'worker-1', requested_by: 'worker-2' });
  assert.equal(blocked.finding.severity, 'error');
  assert.equal(await readFile(leaseFile('road', 'R1'), 'utf8'), bytes, 'a blocked claim writes nothing');

  // the holder re-claiming against a changed contract advances the lease (work re-run)
  await workflow.write('src/shared.js', 'export const shared = 3;\n');
  const advanced = await claim({ requestId: ulid(3) });
  assert.equal(advanced.status, 'noop');
  assert.equal(advanced.refreshed, true);
  assert.equal(advanced.lease.acquired_at, first.lease.acquired_at, 'acquisition time is kept');
  assert.notEqual(advanced.lease.refreshed_at, first.lease.refreshed_at);
  assert.equal(advanced.lease.snapshot, (await lease()).snapshot);
  assert.equal(advanced.lease.request_id, ulid(3));
  assert.ok(providers.calls.now > 0);
});

test('takeover is explicit and replaces the holder', async (t) => {
  const { workflow, claim, leaseFile } = await setup(t);
  const first = await claim();
  const taken = await claim({ holder: 'worker-2', takeover: true, requestId: ulid(2) });
  assert.equal(taken.status, 'taken_over');
  assert.equal(taken.previous_holder, 'worker-1');
  assert.equal(taken.lease.holder, 'worker-2');
  assert.notEqual(taken.lease.acquired_at, first.lease.acquired_at);
  assert.equal(JSON.parse(await readFile(leaseFile('road', 'R1'), 'utf8')).holder, 'worker-2');
  const back = await claim({ holder: 'worker-1', requestId: ulid(3) });
  assert.equal(back.status, 'blocked', 'the previous holder is now the one blocked');
  assert.equal(back.holder, 'worker-2');
  // takeover on a free lease is just a claim
  const free = await claim({ target: 'R2', holder: 'worker-3', takeover: true });
  assert.equal(free.status, 'claimed');
  assert.equal((await readLease({ ...workflow.options, kind: 'road', target: 'R2' })).lease.holder, 'worker-3');
});

test('refresh advances the lease for the holder only', async (t) => {
  const { workflow, claim, lease, providers, leaseFile } = await setup(t);
  const base = { ...workflow.options, providers, kind: 'road', target: 'R1' };
  const none = await refreshLease({ ...base, holder: 'worker-1', snapshot: SHA('a'), inventory: [], requestId: ulid(2) });
  assert.equal(none.status, 'none');
  assert.equal((await readLease(base)).status, 'none');

  const first = await claim();
  const bytes = await readFile(leaseFile('road', 'R1'), 'utf8');
  const other = await refreshLease({ ...base, holder: 'worker-2', snapshot: SHA('a'), inventory: [], requestId: ulid(2) });
  assert.equal(other.status, 'blocked');
  assert.equal(other.holder, 'worker-1');
  assert.equal(other.finding.code, 'AKRS-C012');
  assert.equal(await readFile(leaseFile('road', 'R1'), 'utf8'), bytes);

  await workflow.write('akrs/roads/R1.json', jsonText({ ...ROAD_R1, acceptance: ['works', 'fast'] }));
  const current = await lease();
  const refreshed = await refreshLease({
    ...base, holder: 'worker-1', snapshot: current.snapshot, inventory: current.inventory, requestId: ulid(3),
  });
  assert.equal(refreshed.status, 'refreshed');
  assert.equal(refreshed.lease.snapshot, current.snapshot);
  assert.deepEqual(refreshed.lease.inventory, current.inventory);
  assert.equal(refreshed.lease.request_id, ulid(3));
  assert.equal(refreshed.lease.acquired_at, first.lease.acquired_at);
  assert.notEqual(refreshed.lease.refreshed_at, first.lease.refreshed_at);
  assert.equal(JSON.stringify(refreshed.lease), JSON.stringify(JSON.parse(await readFile(leaseFile('road', 'R1'), 'utf8'))));
});

test('release is for the holder, or an explicit Leader release; there is no time-based expiry', async (t) => {
  const { workflow, claim, leaseFile } = await setup(t);
  const base = { ...workflow.options, kind: 'road', target: 'R1' };
  assert.equal((await releaseLease({ ...base, holder: 'worker-1' })).status, 'noop', 'nothing to release');
  await claim();
  const blocked = await releaseLease({ ...base, holder: 'worker-2' });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.holder, 'worker-1');
  assert.equal(blocked.finding.code, 'AKRS-C012');
  assert.equal((await readLease(base)).status, 'held');

  const released = await releaseLease({ ...base, holder: 'worker-1' });
  assert.equal(released.status, 'released');
  assert.equal(released.previous_holder, 'worker-1');
  assert.deepEqual(await readLease(base), { status: 'none' });
  assert.deepEqual(await listNames(dirname(leaseFile('road', 'R1'))), []);

  await claim({ holder: 'worker-2' });
  const leader = await releaseLease({ ...base, leader: true });
  assert.equal(leader.status, 'released');
  assert.equal(leader.previous_holder, 'worker-2');
  assert.equal((await readLease(base)).status, 'none');

  // a very old lease is still held: no TTL
  await claim({ holder: 'worker-1', providers: { now: () => '2000-01-01T00:00:00.000Z', runId: () => ulid(9) } });
  assert.equal((await claim({ holder: 'worker-2' })).status, 'blocked');
});

test('a corrupt lease file blocks safely: only takeover or a Leader release replaces it', async (t) => {
  const { workflow, claim, leaseFile } = await setup(t);
  const base = { ...workflow.options, kind: 'road', target: 'R1' };
  await mkdir(dirname(leaseFile('road', 'R1')), { recursive: true });
  for (const garbage of ['{ not json', '{"schema":"akrs.lease/v1"}\n', '']) {
    await writeFile(leaseFile('road', 'R1'), garbage);
    const read = await readLease(base);
    assert.equal(read.status, 'corrupt');
    assert.equal(typeof read.reason, 'string');
    assert.equal((await claim()).status, 'corrupt');
    assert.equal((await releaseLease({ ...base, holder: 'worker-1' })).status, 'corrupt');
    assert.equal((await refreshLease({ ...base, holder: 'worker-1', snapshot: SHA('a'), inventory: [], requestId: null })).status, 'corrupt');
    assert.equal(await readFile(leaseFile('road', 'R1'), 'utf8'), garbage, 'untouched');
  }
  assert.equal((await claim({ takeover: true })).status, 'taken_over');
  await writeFile(leaseFile('road', 'R1'), '{ not json');
  assert.equal((await releaseLease({ ...base, leader: true })).status, 'released');
});

test('lease arguments are validated before anything is written', async (t) => {
  const { workflow, lease, providers } = await setup(t);
  const current = await lease();
  const good = {
    ...workflow.options, providers, kind: 'road', target: 'R1', holder: 'worker-1',
    snapshot: current.snapshot, inventory: current.inventory, requestId: ulid(1),
  };
  const bad = [
    { kind: 'task' }, { target: '../escape' }, { target: 'a/b' }, { target: '' }, { holder: 'has space' },
    { snapshot: 'sha256:short' }, { inventory: [{ projection: 'p', key: 'k', kind: 'file' }] },
    { inventory: [{ projection: 'p', key: 'k', kind: 'file', value: 'x', extra: 1 }] }, { inventory: 'no' },
    { requestId: 'nope' }, { takeover: 'yes' },
  ];
  for (const overrides of bad) {
    await assert.rejects(claimLease({ ...good, ...overrides }), TypeError, JSON.stringify(overrides));
  }
  await assert.rejects(readLease({ ...workflow.options, kind: 'road', target: '../x' }), TypeError);
  await assert.rejects(releaseLease({ ...workflow.options, kind: 'road', target: 'R1', holder: 'bad id' }), TypeError);
  assert.deepEqual(await listNames(workflow.path('akrs', '.ops')), []);
});

test('lease operations need the repository lock: they take it themselves or verify the handle they are given', async (t) => {
  const { workflow, claim, providers } = await setup(t);
  const held = await acquireRepositoryLock({ ...workflow.options, command: 'journal' });
  assert.equal(held.status, 'acquired');

  const blocked = await claim({ lockOptions: { timeoutMs: 30, retryMs: 10 } });
  assert.equal(blocked.status, 'lock_blocked');
  assert.equal(blocked.finding.code, 'AKRS-C009');
  assert.equal((await readLease({ ...workflow.options, kind: 'road', target: 'R1' })).status, 'none');

  const inside = await claim({ heldLock: held.handle });
  assert.equal(inside.status, 'claimed', 'a caller holding the lock passes its handle (no self-deadlock)');
  await held.handle.release();
  await assert.rejects(claim({ heldLock: held.handle, holder: 'worker-2' }), /lock/i, 'a released handle proves nothing');
  await assert.rejects(claim({ heldLock: {}, holder: 'worker-2' }), TypeError);
  assert.equal((await readLease({ ...workflow.options, kind: 'road', target: 'R1' })).lease.holder, 'worker-1');
  assert.ok(providers.calls.now >= 1);
});

test('the lease advances inside the holder\'s own committed operation, under the journal lock', async (t) => {
  const { workflow, claim, lease } = await setup(t);
  await claim();
  const harness = createHarness(workflow);
  const outcome = await harness.run({
    requestId: ulid(40),
    apply: async (context) => {
      const packet = await harness.apply(context);
      await workflow.write('akrs/roads/R1.json', jsonText({ ...ROAD_R1, acceptance: ['works', 'own change'] }));
      const current = await lease();
      const refreshed = await refreshLease({
        ...workflow.options, heldLock: context.lock, kind: 'road', target: 'R1', holder: 'worker-1',
        snapshot: current.snapshot, inventory: current.inventory, requestId: context.request_id,
      });
      assert.equal(refreshed.status, 'refreshed');
      return packet;
    },
  });
  assert.equal(outcome.outcome, 'committed');
  const stored = (await readLease({ ...workflow.options, kind: 'road', target: 'R1' })).lease;
  assert.equal(stored.snapshot, (await lease()).snapshot);
  assert.equal(stored.request_id, ulid(40));
});

test('checkLease reports none, fresh or stale with a delta of inventory keys', async (t) => {
  const { workflow, claim, lease } = await setup(t);
  const base = { ...workflow.options, kind: 'road', target: 'R1' };

  const none = checkLease({ lease: null, current: await lease() });
  assert.deepEqual(none, { state: 'none', delta: { changed: [], added: [], removed: [] }, snapshot: (await lease()).snapshot, reason: null });

  await claim();
  const held = (await readLease(base)).lease;
  const fresh = checkLease({ lease: held, current: await lease() });
  assert.equal(fresh.state, 'fresh');
  assert.deepEqual(fresh.delta, { changed: [], added: [], removed: [] });
  assert.equal(fresh.snapshot, held.snapshot);

  // the holder's own product edit inside its writes never stales its own lease
  await workflow.write('src/own.js', 'export const own = 99;\n');
  assert.equal(checkLease({ lease: held, current: await lease() }).state, 'fresh');

  // a declared read outside its writes does
  await workflow.write('src/shared.js', 'export const shared = 7;\n');
  const stale = checkLease({ lease: held, current: await lease() });
  assert.equal(stale.state, 'stale');
  assert.deepEqual(stale.delta, { changed: ['road-reads:src/shared.js'], added: [], removed: [] });
  assert.equal(stale.snapshot, (await lease()).snapshot);
  assert.notEqual(stale.snapshot, held.snapshot);

  // added and removed inventory keys
  const current = await lease();
  const synthetic = {
    ...held,
    inventory: [
      ...held.inventory.filter(({ projection }) => projection !== 'road-reads'),
      { projection: 'road-reads', key: 'gone/file.md', kind: 'file', value: SHA('c') },
    ],
  };
  const shaped = checkLease({ lease: synthetic, current });
  assert.deepEqual(shaped.delta.removed, ['road-reads:gone/file.md']);
  assert.ok(shaped.delta.added.includes('road-reads:src/shared.js'));
  assert.deepEqual([...shaped.delta.added].sort(), shaped.delta.added);

  // the finding a stale holder mutation returns
  const finding = leaseStaleFinding(stale, held);
  assert.equal(finding.code, 'AKRS-C013');
  assert.deepEqual(finding.detail, { source: 'lease', expected: held.snapshot, current: stale.snapshot, delta: stale.delta });
});

test('checkLease never calls an unstable measurement fresh', async (t) => {
  const { claim, lease } = await setup(t);
  const claimed = (await claim()).lease;
  const unstable = { status: 'unstable', snapshot: null, inventory: (await lease()).inventory };
  const result = checkLease({ lease: claimed, current: unstable });
  assert.equal(result.state, 'stale');
  assert.equal(result.reason, 'unstable');
  assert.equal(result.snapshot, null);
});

const EXECUTORS = [
  { id: 'lead', role: 'leader' },
  { id: 'worker-1', role: 'worker' },
  { id: 'worker-2', role: 'worker' },
  { id: 'tester-1', role: 'tester' },
];

test('holder resolution: --executor, then AKRS_EXECUTOR, then the only executor of the role', () => {
  const only = [EXECUTORS[0], EXECUTORS[1], EXECUTORS[3]];
  assert.deepEqual(resolveHolder({ flag: 'worker-2', env: { AKRS_EXECUTOR: 'worker-1' }, executors: EXECUTORS, role: 'worker' }),
    { status: 'resolved', holder: 'worker-2', source: 'flag' });
  assert.deepEqual(resolveHolder({ env: { AKRS_EXECUTOR: 'worker-1' }, executors: EXECUTORS, role: 'worker' }),
    { status: 'resolved', holder: 'worker-1', source: 'env' });
  assert.deepEqual(resolveHolder({ env: {}, executors: only, role: 'worker' }),
    { status: 'resolved', holder: 'worker-1', source: 'only_executor_of_role' });
  assert.deepEqual(resolveHolder({ env: {}, executors: only, role: 'tester' }),
    { status: 'resolved', holder: 'tester-1', source: 'only_executor_of_role' });
  // empty strings count as absent
  assert.equal(resolveHolder({ flag: '', env: { AKRS_EXECUTOR: '' }, executors: only, role: 'worker' }).source, 'only_executor_of_role');
});

test('holder resolution enumerates the choices instead of throwing', () => {
  assert.deepEqual(resolveHolder({ env: {}, executors: EXECUTORS, role: 'worker' }), {
    status: 'choices', reason: 'multiple', choices: ['worker-1', 'worker-2'], supplied: null, source: null,
  });
  assert.deepEqual(resolveHolder({ env: {}, executors: [EXECUTORS[0]], role: 'worker' }), {
    status: 'choices', reason: 'none', choices: [], supplied: null, source: null,
  });
  assert.deepEqual(resolveHolder({ flag: 'ghost', env: { AKRS_EXECUTOR: 'worker-1' }, executors: EXECUTORS, role: 'worker' }), {
    status: 'choices', reason: 'unknown_executor', choices: ['worker-1', 'worker-2'], supplied: 'ghost', source: 'flag',
  }, 'a bad flag does not fall through to the environment');
  assert.deepEqual(resolveHolder({ env: { AKRS_EXECUTOR: 'tester-1' }, executors: EXECUTORS, role: 'worker' }), {
    status: 'choices', reason: 'wrong_role', choices: ['worker-1', 'worker-2'], supplied: 'tester-1', source: 'env',
  });
  assert.throws(() => resolveHolder({ env: {}, executors: EXECUTORS, role: 'janitor' }), TypeError);
  assert.throws(() => resolveHolder({ env: {}, executors: 'nope', role: 'worker' }), TypeError);
});

test('an explicit --if-snapshot wins over the lease; the lease implies one otherwise', () => {
  const lease = { snapshot: SHA('1') };
  const current = { command: SHA('2'), lease: SHA('1') };
  assert.deepEqual(resolveExpectedSnapshot({ explicit: SHA('3'), lease, current }),
    { snapshot: SHA('3'), source: 'explicit', compare_against: 'command', matches: false });
  assert.deepEqual(resolveExpectedSnapshot({ explicit: SHA('2'), lease, current }),
    { snapshot: SHA('2'), source: 'explicit', compare_against: 'command', matches: true });
  assert.deepEqual(resolveExpectedSnapshot({ lease, current }),
    { snapshot: SHA('1'), source: 'lease', compare_against: 'lease', matches: true });
  assert.deepEqual(resolveExpectedSnapshot({ lease, current: { command: SHA('2'), lease: SHA('9') } }),
    { snapshot: SHA('1'), source: 'lease', compare_against: 'lease', matches: false });
  assert.deepEqual(resolveExpectedSnapshot({ explicit: null, lease: null, current }),
    { snapshot: null, source: 'none', compare_against: null, matches: null });
  assert.deepEqual(resolveExpectedSnapshot({ lease }),
    { snapshot: SHA('1'), source: 'lease', compare_against: 'lease', matches: null }, 'without a measurement there is nothing to compare');
  assert.throws(() => resolveExpectedSnapshot({ explicit: 'nope', lease, current }), TypeError);
});

test('an explicit snapshot overrides a lease that says otherwise, in a journaled mutation', async (t) => {
  const { workflow, claim, lease } = await setup(t);
  await claim();
  const harness = createHarness(workflow);
  const held = (await readLease({ ...workflow.options, kind: 'road', target: 'R1' })).lease;

  // the lease goes stale (a declared read changed), yet an explicit, correct --if-snapshot decides instead
  await workflow.write('src/shared.js', 'export const shared = 11;\n');
  const staleLease = checkLease({ lease: held, current: await lease() });
  assert.equal(staleLease.state, 'stale');
  const resolved = resolveExpectedSnapshot({
    explicit: await workflowSnapshot(workflow), lease: held,
    current: { command: await workflowSnapshot(workflow), lease: (await lease()).snapshot },
  });
  assert.equal(resolved.source, 'explicit');
  assert.equal(resolved.matches, true);
  const proceed = await harness.run({ requestId: ulid(50), expectedSnapshot: resolved.snapshot });
  assert.equal(proceed.outcome, 'committed');

  // and an explicit, wrong --if-snapshot blocks even though the lease is fresh
  const freshLease = (await claim({ requestId: ulid(51) })).lease;
  const wrong = resolveExpectedSnapshot({
    explicit: SHA('d'), lease: freshLease,
    current: { command: await workflowSnapshot(workflow), lease: (await lease()).snapshot },
  });
  assert.equal(wrong.source, 'explicit');
  assert.equal(wrong.matches, false);
  const blocked = await harness.run({ requestId: ulid(52), input: { name: 'two', body: 'two' }, expectedSnapshot: wrong.snapshot });
  assert.equal(blocked.outcome, 'stale');
  assert.equal(blocked.packet.findings[0].detail.source, 'explicit');
});

test('lease operations never change a command snapshot or any workflow byte outside .ops', async (t) => {
  const { workflow, claim, lease, providers } = await setup(t);
  const views = async () => ({
    workflow: await workflowSnapshot(workflow),
    lease: (await lease()).snapshot,
    tester: (await computeSnapshot({ ...workflow.options, projections: TESTER_LEASE_PROJECTION, target: { plan: 'P1' } })).snapshot,
  });
  const before = await views();
  const treeWithoutOps = async () => (await walk(workflow.root)).filter((file) => !file.startsWith('akrs/.ops/'));
  const filesBefore = await treeWithoutOps();
  const hashBefore = await byteTreeHash(workflow.root);
  const base = { ...workflow.options, providers, kind: 'road', target: 'R1' };

  await claim();
  assert.deepEqual(await views(), before);
  const current = await lease();
  await refreshLease({ ...base, holder: 'worker-1', snapshot: current.snapshot, inventory: current.inventory, requestId: ulid(2) });
  assert.deepEqual(await views(), before);
  await claim({ holder: 'worker-2', takeover: true });
  assert.deepEqual(await views(), before);
  await releaseLease({ ...base, leader: true });
  assert.deepEqual(await views(), before);
  assert.deepEqual(await treeWithoutOps(), filesBefore);
  assert.notEqual(await byteTreeHash(workflow.root), hashBefore, 'only .ops differs');
});
