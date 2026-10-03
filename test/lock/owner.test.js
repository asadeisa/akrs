// P1-W03 / F7: the frozen policy, the closed owner record and the permanent finding code.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as core from '../../lib/core/index.js';
import { getFindingDefinition, validateFindingCatalog, findingCatalog } from '../../lib/findings/catalog.js';
import {
  LOCK_OWNER_KEYS,
  LOCK_OWNER_SCHEMA,
  LOCK_POLICY,
  isProcessAlive,
  renderLockOwner,
  validateLockOwner,
} from '../../lib/store/lock/index.js';
import { validOwner } from './support.js';

test('F7 policy is a frozen document of every lock decision', () => {
  assert.equal(Object.isFrozen(LOCK_POLICY), true);
  const nested = [LOCK_POLICY.owner_record, LOCK_POLICY.wait, LOCK_POLICY.stale_proof, LOCK_POLICY.recovery];
  for (const section of nested) assert.equal(Object.isFrozen(section), true);

  assert.equal(LOCK_POLICY.location, '.ops/lock');
  assert.equal(LOCK_POLICY.owner_file, 'owner.json');
  assert.equal(LOCK_POLICY.owner_record.schema, 'akrs.lock-owner/v1');
  assert.deepEqual(LOCK_POLICY.owner_record.keys, ['schema', 'pid', 'host', 'run_id', 'command', 'acquired_at']);
  assert.equal(LOCK_POLICY.wait.default_timeout_ms, 5000);
  assert.equal(LOCK_POLICY.wait.default_retry_ms, 25);
  assert.equal(LOCK_POLICY.finding_code, 'AKRS-C009');
  assert.deepEqual(LOCK_POLICY.blocked_reasons, ['held', 'corrupt', 'foreign_host']);
  assert.deepEqual(LOCK_POLICY.recovery.stale_directory_prefix, 'lock.stale-');
  for (const key of [
    'acquisition', 'containment', 'mid_acquire_window', 'pid_reuse', 'release', 'manual_recovery',
    'windows', 'snapshots', 'reusable_root',
  ]) {
    assert.equal(typeof LOCK_POLICY[key], 'string', `policy documents ${key}`);
    assert.notEqual(LOCK_POLICY[key].length, 0, key);
  }
  assert.equal(LOCK_POLICY.stale_proof.by_age_alone, false);
  assert.equal(LOCK_POLICY.stale_proof.requires_same_host, true);
  assert.equal(LOCK_POLICY.stale_proof.requires_dead_pid, true);
  assert.equal(LOCK_OWNER_SCHEMA, LOCK_POLICY.owner_record.schema);
  assert.deepEqual(LOCK_OWNER_KEYS, LOCK_POLICY.owner_record.keys);
});

test('the owner record is closed: a valid record passes and canonical rendering is stable', () => {
  const owner = validOwner();
  assert.deepEqual(validateLockOwner(owner), { ok: true, issues: [] });
  const text = renderLockOwner(owner);
  assert.equal(text.endsWith('\n'), true);
  assert.deepEqual(Object.keys(JSON.parse(text)), ['schema', 'pid', 'host', 'run_id', 'command', 'acquired_at']);
  // Key order of the input does not matter.
  const shuffled = Object.fromEntries(Object.entries(owner).reverse());
  assert.equal(renderLockOwner(shuffled), text);
  assert.throws(() => renderLockOwner({ ...owner, pid: 0 }), TypeError);
  assert.throws(() => renderLockOwner({ ...owner, extra: 1 }), TypeError);
});

test('validateLockOwner rejects unknown keys, missing keys and wrong types', () => {
  const owner = validOwner();
  const codes = (value) => validateLockOwner(value).issues.map(({ path, code }) => `${path}:${code}`);

  assert.deepEqual(codes({ ...owner, extra: true }), ['$.extra:unknown_key']);
  for (const key of LOCK_OWNER_KEYS) {
    const { [key]: _omitted, ...rest } = owner;
    assert.deepEqual(codes(rest), [`$.${key}:missing_key`], key);
  }
  for (const value of [null, [], 'owner', 7, undefined]) {
    assert.equal(validateLockOwner(value).ok, false, String(value));
  }
  assert.equal(validateLockOwner({ ...owner, schema: 'akrs.lock-owner/v2' }).ok, false);
  assert.equal(validateLockOwner({ ...owner, schema: undefined }).ok, false);
});

test('validateLockOwner rejects bad pids, hosts, run IDs, commands and timestamps', () => {
  const owner = validOwner();
  const valid = (overrides) => validateLockOwner({ ...owner, ...overrides }).ok;

  for (const pid of [0, -1, 1.5, '4242', Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, null, 4294967296]) {
    assert.equal(valid({ pid }), false, `pid ${String(pid)}`);
  }
  assert.equal(valid({ pid: 1 }), true);
  assert.equal(valid({ pid: 4294967295 }), true);

  for (const host of ['', 7, null, 'a\nb', 'x'.repeat(256)]) assert.equal(valid({ host }), false, `host ${String(host)}`);
  for (const run_id of ['', 'not-a-ulid', '01arz3ndektsv4rrffq69g5fav', 12, null]) {
    assert.equal(valid({ run_id }), false, `run_id ${String(run_id)}`);
  }
  for (const command of ['', 7, null, 'a\nb', 'x'.repeat(201)]) {
    assert.equal(valid({ command }), false, `command ${String(command)}`);
  }
  for (const acquired_at of [
    '', 'yesterday', '2026-10-03T10:00:00Z', '2026-10-03T10:00:00.000+02:00', '2026-02-30T10:00:00.000Z',
    '2026-10-03 10:00:00.000Z', 1759485600000, null,
  ]) {
    assert.equal(valid({ acquired_at }), false, `acquired_at ${String(acquired_at)}`);
  }
});

test('isProcessAlive proves death only from ESRCH; EPERM and unknown errors mean alive', () => {
  const failing = (code) => () => { throw Object.assign(new Error(code), { code }); };
  assert.equal(isProcessAlive(10, () => true), true);
  assert.equal(isProcessAlive(10, failing('ESRCH')), false);
  assert.equal(isProcessAlive(10, failing('EPERM')), true);
  assert.equal(isProcessAlive(10, failing('EINVAL')), true);
  const calls = [];
  isProcessAlive(77, (pid, signal) => { calls.push([pid, signal]); return true; });
  assert.deepEqual(calls, [[77, 0]]);
  assert.equal(isProcessAlive(process.pid), true);
});

test('AKRS-C009 is a permanent catalog code for a blocked repository lock', () => {
  const definition = getFindingDefinition('AKRS-C009');
  assert.notEqual(definition, null);
  assert.equal(definition.category, 'command');
  assert.equal(definition.severity, 'error');
  assert.deepEqual(Object.keys(definition.data_schema.properties).sort(), ['holder', 'reason']);
  assert.deepEqual(definition.data_schema.properties.reason.enum, ['held', 'corrupt', 'foreign_host']);
  assert.match(definition.remediation, /breakLock/);
  assert.equal(validateFindingCatalog(findingCatalog).ok, true);
  assert.equal(LOCK_POLICY.finding_code, definition.code);
});

test('the lock API is exported from lib/core', async () => {
  const lock = await import('../../lib/store/lock/index.js');
  for (const name of [
    'LOCK_POLICY', 'acquireRepositoryLock', 'releaseRepositoryLock', 'withRepositoryLock', 'breakLock',
    'readLockOwner', 'validateLockOwner',
  ]) {
    assert.equal(typeof lock[name], name === 'LOCK_POLICY' ? 'object' : 'function', name);
    assert.equal(core[name], lock[name], `core exports ${name}`);
  }
});
