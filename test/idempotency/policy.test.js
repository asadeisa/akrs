// P1-W04 / F8 + F17: the frozen journal and lease policy, the hash material, the record schema and the finding codes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as core from '../../lib/core/index.js';
import { findingCatalog, getFindingDefinition, validateFindingCatalog } from '../../lib/findings/catalog.js';
import {
  JOURNAL_POLICY,
  OP_KEYS,
  OP_STATES,
  computeReplayKey,
  computeRequestHash,
  saltReplayKey,
  validateOpRecord,
} from '../../lib/store/journal/index.js';
import { LEASE_POLICY } from '../../lib/store/leases/index.js';
import { canonicalizeJsonCompact, contentHash, encodeJsonlRecord } from '../../lib/store/canonical/index.js';
import { OP_SPEC } from '../../lib/store/journal/index.js';
import { ulid } from './support.js';

const SHA = /^sha256:[0-9a-f]{64}$/;
const SNAPSHOT = `sha256:${'a'.repeat(64)}`;

function assertDeepFrozen(value, path = 'policy') {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true, `${path} must be frozen`);
  for (const [key, child] of Object.entries(value)) assertDeepFrozen(child, `${path}.${key}`);
}

test('JOURNAL_POLICY is a frozen, documented decision record', () => {
  assertDeepFrozen(JOURNAL_POLICY);
  assert.equal(JOURNAL_POLICY.op_schema, 'akrs.op/v1');
  assert.equal(JOURNAL_POLICY.request_schema, 'akrs.op-request/v1');
  assert.equal(JOURNAL_POLICY.replay_schema, 'akrs.op-replay/v1');
  assert.equal(JOURNAL_POLICY.location, '.ops/journal');
  assert.deepEqual(JOURNAL_POLICY.states, ['prepared', 'committed', 'failed']);
  assert.deepEqual(OP_STATES, ['prepared', 'committed', 'failed']);
  assert.deepEqual(JOURNAL_POLICY.retention, { max_ops: 1000, max_age_days: 30 });
  assert.deepEqual(JOURNAL_POLICY.fault_points, ['after_prepared', 'after_apply', 'after_committed', 'after_index']);
  assert.deepEqual(JOURNAL_POLICY.order, [
    'acquire lock', 'recovery check', 'authorize', 'caller-ID conflict check', 'replay check', 'validate',
    'append prepared', 'apply', 'append committed', 'write index', 'release lock',
  ]);
  assert.deepEqual(JOURNAL_POLICY.dedupe_modes, ['projection', 'append', 'none']);
  assert.equal(JOURNAL_POLICY.finding_codes.request_conflict, 'AKRS-C010');
  assert.equal(JOURNAL_POLICY.finding_codes.recovery_required, 'AKRS-C011');
  assert.equal(JOURNAL_POLICY.finding_codes.stale_snapshot, 'AKRS-C013');
  for (const key of ['request_id', 'request_hash', 'replay_key', 'replay', 'replay_packet', 'states', 'durability',
    'retention', 'executions', 'appends', 'missing_draft', 'expected_snapshot', 'confinement']) {
    assert.ok(Object.hasOwn(JOURNAL_POLICY, key), `policy documents ${key}`);
  }
});

test('LEASE_POLICY is a frozen, documented decision record', () => {
  assertDeepFrozen(LEASE_POLICY);
  assert.equal(LEASE_POLICY.schema, 'akrs.lease/v1');
  assert.equal(LEASE_POLICY.location, '.ops/leases');
  assert.deepEqual(LEASE_POLICY.kinds, ['road', 'plan']);
  assert.equal(LEASE_POLICY.file_suffix, '.lease.json');
  assert.equal(LEASE_POLICY.ttl, null, 'there is no time-based expiry');
  assert.equal(LEASE_POLICY.finding_codes.held_by_another, 'AKRS-C012');
  assert.equal(LEASE_POLICY.finding_codes.stale, 'AKRS-C013');
  // P2-W12 owns the guard allowlist name; it must not collide with a lease file.
  assert.match(LEASE_POLICY.guard_allowlist, /guard/);
  assert.notEqual(LEASE_POLICY.guard_allowlist.slice(-LEASE_POLICY.file_suffix.length), LEASE_POLICY.file_suffix);
  assert.deepEqual(LEASE_POLICY.holder_resolution, ['flag', 'env', 'only_executor_of_role']);
  assert.equal(LEASE_POLICY.env_variable, 'AKRS_EXECUTOR');
});

test('the request hash is the contentHash of the closed compact material', () => {
  const material = '{"schema":"akrs.op-request/v1","command":"memory-add","target":{"road":"R1","plan":null},'
    + '"input":{"a":1,"b":["x"]},"expected_snapshot":null}';
  assert.equal(
    computeRequestHash({ command: 'memory-add', target: { road: 'R1' }, input: { b: ['x'], a: 1 } }),
    contentHash(material),
  );
  assert.equal(
    computeRequestHash({ command: 'memory-add', target: { road: 'R1', plan: null }, input: { a: 1, b: ['x'] }, expectedSnapshot: SNAPSHOT }),
    contentHash(material.replace('"expected_snapshot":null', `"expected_snapshot":"${SNAPSHOT}"`)),
  );
});

test('the replay key excludes the expected snapshot and is its own closed material', () => {
  const material = '{"schema":"akrs.op-replay/v1","command":"memory-add","target":{"road":null,"plan":"P1"},"input":"text"}';
  assert.equal(computeReplayKey({ command: 'memory-add', target: { plan: 'P1' }, input: 'text' }), contentHash(material));
  const key = computeReplayKey({ command: 'x', target: {}, input: null });
  assert.match(key, SHA);
  assert.notEqual(key, computeRequestHash({ command: 'x', target: {}, input: null }));
});

test('hashes change with command, target and input, and ignore object key order', () => {
  const base = { command: 'memory-add', target: { road: 'R1', plan: null }, input: { a: 1, b: 2 } };
  const variants = [
    { ...base, command: 'log-append' },
    { ...base, target: { road: 'R2', plan: null } },
    { ...base, target: { road: null, plan: 'R1' } },
    { ...base, input: { a: 1, b: 3 } },
    { ...base, input: [1, 2] },
  ];
  for (const variant of variants) {
    assert.notEqual(computeRequestHash(variant), computeRequestHash(base));
    assert.notEqual(computeReplayKey(variant), computeReplayKey(base));
  }
  assert.equal(computeRequestHash({ ...base, input: { b: 2, a: 1 } }), computeRequestHash(base));
  assert.equal(computeReplayKey({ ...base, input: { b: 2, a: 1 } }), computeReplayKey(base));
  assert.notEqual(
    computeRequestHash({ ...base, expectedSnapshot: SNAPSHOT }),
    computeRequestHash({ ...base, expectedSnapshot: null }),
  );
  assert.equal(computeReplayKey({ ...base }), computeReplayKey({ ...base }));
});

test('hash inputs outside the closed canonical contract are refused', () => {
  const base = { command: 'memory-add', target: {}, input: null };
  assert.throws(() => computeRequestHash({ ...base, input: { x: 1.5 } }), TypeError);
  assert.throws(() => computeRequestHash({ ...base, input: undefined }), TypeError);
  assert.throws(() => computeRequestHash({ ...base, command: 'Not A Command' }), TypeError);
  assert.throws(() => computeRequestHash({ ...base, target: { road: '../x' } }), TypeError);
  assert.throws(() => computeRequestHash({ ...base, target: { road: 'R1', extra: 1 } }), TypeError);
  assert.throws(() => computeRequestHash({ ...base, expectedSnapshot: 'not-a-snapshot' }), TypeError);
  assert.throws(() => computeReplayKey({ ...base, target: 'R1' }), TypeError);
});

test('the --again salt derives a distinct, deterministic key from the replay key and the new request ID', () => {
  const key = computeReplayKey({ command: 'log-append', target: {}, input: { text: 'x' } });
  const salted = saltReplayKey(key, ulid(1));
  assert.match(salted, SHA);
  assert.notEqual(salted, key);
  assert.notEqual(salted, saltReplayKey(key, ulid(2)));
  assert.equal(salted, saltReplayKey(key, ulid(1)));
  assert.equal(salted, contentHash(
    `{"schema":"akrs.op-replay-again/v1","replay_key":"${key}","request_id":"${ulid(1)}"}`,
  ));
  assert.throws(() => saltReplayKey(key, 'not-a-ulid'), TypeError);
  assert.throws(() => saltReplayKey('nope', ulid(1)), TypeError);
});

function record(overrides = {}) {
  return {
    id: ulid(1),
    ts: '2026-10-03T10:00:00.000Z',
    request_id: ulid(2),
    command: 'memory-add',
    target: { road: null, plan: null },
    request_hash: SNAPSHOT,
    replay_key: SNAPSHOT,
    state: 'prepared',
    expected_snapshot: null,
    before: SNAPSHOT,
    after: null,
    changed: [],
    packet_hash: null,
    packet: null,
    transaction: null,
    draft: null,
    ...overrides,
  };
}

test('the op record is the closed akrs.op/v1 schema', () => {
  assert.deepEqual(OP_KEYS, [
    'id', 'hash', 'ts', 'request_id', 'command', 'target', 'request_hash', 'replay_key', 'state',
    'expected_snapshot', 'before', 'after', 'changed', 'packet_hash', 'packet', 'transaction', 'draft',
  ]);
  const line = encodeJsonlRecord(record(), OP_SPEC);
  const stored = JSON.parse(line);
  assert.equal(validateOpRecord(stored).ok, true, JSON.stringify(validateOpRecord(stored).issues));
  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.slice(0, -1).includes('\n'), false, 'one compact line per record');
  assert.equal(validateOpRecord({ ...stored, extra: 1 }).ok, false);
  const { draft: _draft, ...missing } = stored;
  assert.equal(validateOpRecord(missing).ok, false);
});

test('a committed op record needs the final packet; other states must not carry one', () => {
  const packet = { schema_version: 'akrs.packet/v2' };
  const committed = record({
    state: 'committed', after: SNAPSHOT, changed: ['memory/a.md'], packet_hash: SNAPSHOT, packet, transaction: ulid(3), draft: 'akrs/drafts/a.json',
  });
  assert.equal(validateOpRecord(JSON.parse(encodeJsonlRecord(committed, OP_SPEC))).ok, true);
  const bad = [
    record({ state: 'committed', after: SNAPSHOT }),
    record({ state: 'prepared', packet, packet_hash: SNAPSHOT }),
    record({ state: 'failed', packet }),
    record({ state: 'done' }),
    record({ request_id: 'nope' }),
    record({ command: 'Bad Command' }),
    record({ target: { road: 'R1' } }),
    record({ transaction: 'tx-1' }),
    record({ draft: '' }),
    record({ draft: '/etc/passwd' }),
    record({ draft: '../outside.json' }),
    record({ draft: 'a\\b.json' }),
    record({ changed: ['b', 'a'] }),
    record({ expected_snapshot: 'sha256:short' }),
  ];
  bad.forEach((value, index) => {
    const withHash = { ...value, hash: SNAPSHOT };
    assert.equal(validateOpRecord(withHash).ok, false, `case ${index}`);
  });
});

test('the journal never serializes input fields into the record schema', () => {
  assert.ok(OP_KEYS.length > 0);
  for (const forbidden of ['input', 'body', 'prompt', 'content', 'contents']) {
    assert.equal(OP_KEYS.includes(forbidden), false, forbidden);
  }
  assert.equal(canonicalizeJsonCompact({ packet: { a: 1 } }, { keys: ['packet'], arrays: {}, objects: {}, json: ['packet'] }), '{"packet":{"a":1}}');
});

test('the new finding codes are permanent catalog entries in the command family', () => {
  const expected = {
    'AKRS-C010': ['request_id', 'recorded_request_hash', 'supplied_request_hash'],
    'AKRS-C011': ['request_id', 'transaction'],
    'AKRS-C012': ['kind', 'target', 'holder', 'requested_by'],
    'AKRS-C013': ['source', 'expected', 'current', 'delta'],
  };
  for (const [code, keys] of Object.entries(expected)) {
    const definition = getFindingDefinition(code);
    assert.notEqual(definition, null, code);
    assert.equal(definition.category, 'command');
    assert.equal(definition.severity, 'error');
    assert.deepEqual(Object.keys(definition.data_schema.properties).sort(), [...keys].sort(), code);
    assert.ok(definition.remediation.length > 20);
  }
  assert.equal(validateFindingCatalog(findingCatalog).ok, true);
  // existing entries are untouched
  assert.equal(getFindingDefinition('AKRS-C009').data_schema.properties.reason.enum.length, 3);
});

test('the journal and lease APIs are exported from lib/core', async () => {
  const journal = await import('../../lib/store/journal/index.js');
  const leases = await import('../../lib/store/leases/index.js');
  for (const name of [
    'JOURNAL_POLICY', 'runJournaledMutation', 'findCommittedAppend', 'resolveFromJournal', 'buildReplayPacket',
    'computeRequestHash', 'computeReplayKey', 'saltReplayKey', 'rebuildJournalIndex', 'pruneJournal', 'readOp',
    'validateOpRecord', 'JournalCorruptError',
  ]) {
    assert.ok(journal[name] !== undefined, name);
    assert.equal(core[name], journal[name], `core exports ${name}`);
  }
  for (const name of [
    'LEASE_POLICY', 'claimLease', 'refreshLease', 'releaseLease', 'readLease', 'checkLease', 'resolveHolder',
    'resolveExpectedSnapshot', 'validateLease',
  ]) {
    assert.ok(leases[name] !== undefined, name);
    assert.equal(core[name], leases[name], `core exports ${name}`);
  }
});
