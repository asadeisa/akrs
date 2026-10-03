import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SCOPE_GRANTED_BY,
  SCOPE_OUTCOMES,
  SCOPE_REQUEST_INPUT_KEYS,
  SCOPE_REQUEST_KEYS,
  SCOPE_REQUEST_SCHEMA,
  SCOPE_RESOLUTION_INPUT_KEYS,
  SCOPE_RESOLUTION_KEYS,
  SCOPE_RESOLUTION_SCHEMA,
  validateScopeRequest,
  validateScopeResolution,
} from '../../lib/schemas/scope.js';
import { assertEnum, clone, defineClosedSchemaTests, expectIssue, loadFixtures, setAt } from './schema-harness.js';

const requests = await loadFixtures('scope-request', 'valid');
const blocking = requests.find(({ name }) => name === 'blocking').value;
const resolutions = await loadFixtures('scope-resolution', 'valid');
const approved = resolutions.find(({ name }) => name === 'approved-leader').value;
const rejected = resolutions.find(({ name }) => name === 'rejected').value;

test('F14/Q15 scope: frozen record shapes', () => {
  assert.equal(SCOPE_REQUEST_SCHEMA, 'akrs.scope-request/v1');
  assert.equal(SCOPE_RESOLUTION_SCHEMA, 'akrs.scope-resolution/v1');
  assert.deepEqual(SCOPE_REQUEST_KEYS, ['id', 'hash', 'ts', 'type', 'road', 'snapshot', 'add_reads', 'add_writes', 'reason', 'blocking']);
  assert.deepEqual(SCOPE_REQUEST_INPUT_KEYS, ['schema', 'road', 'add_reads', 'add_writes', 'reason', 'blocking']);
  assert.deepEqual(SCOPE_RESOLUTION_KEYS, ['id', 'hash', 'ts', 'type', 'request', 'outcome', 'granted_by', 'reason', 'road_snapshot_after', 'operation']);
  assert.deepEqual(SCOPE_RESOLUTION_INPUT_KEYS, ['schema', 'request', 'outcome', 'reason']);
  assert.deepEqual(SCOPE_OUTCOMES, ['approved', 'rejected']);
  assert.deepEqual(SCOPE_GRANTED_BY, ['leader', 'envelope']);
});

defineClosedSchemaTests({
  title: 'F14 scope request record',
  kind: 'scope-request',
  validate: (value) => validateScopeRequest(value),
  keys: SCOPE_REQUEST_KEYS,
  primary: 'blocking',
  closedPaths: ['', 'add_reads[0]', 'add_reads[1]', 'add_writes[0]', 'add_writes[1]'],
  atomicPaths: ['add_reads[].lines'],
});

defineClosedSchemaTests({
  title: 'F14 scope resolution record',
  kind: 'scope-resolution',
  validate: (value) => validateScopeResolution(value),
  keys: SCOPE_RESOLUTION_KEYS,
  primary: 'approved-leader',
  closedPaths: ['', 'operation'],
});

test('F14 scope: records are told apart by a literal type, never by shape', () => {
  expectIssue(validateScopeRequest(setAt(clone(blocking), 'type', 'resolution')), 'invalid_value', '$.type');
  expectIssue(validateScopeResolution(setAt(clone(approved), 'type', 'request')), 'invalid_value', '$.type');
});

test('Q15 scope: request deltas reuse the Road read/write entry shapes and a request grants nothing', () => {
  for (const key of ['granted', 'grants', 'permission', 'approved']) {
    expectIssue(validateScopeRequest({ ...clone(blocking), [key]: true }), 'unknown_key', `$.${key}`);
  }
  expectIssue(validateScopeRequest(setAt(clone(blocking), 'add_writes[0].class', 'directory')), 'invalid_value', '$.add_writes[0].class');
  expectIssue(validateScopeRequest(setAt(clone(blocking), 'add_reads[0].lines', [4, 2])), 'invalid_line_range', '$.add_reads[0].lines');
  expectIssue(validateScopeRequest(setAt(clone(blocking), 'reason', '')), 'invalid_value', '$.reason');
  const badSnapshot = validateScopeRequest(setAt(clone(blocking), 'snapshot', 'sha256:abc'));
  assert.equal(badSnapshot.ok, false);
  assert.equal(badSnapshot.issues.some((entry) => entry.path === '$.snapshot'), true);
  const empty = clone(blocking);
  empty.add_reads = [];
  empty.add_writes = [];
  expectIssue(validateScopeRequest(empty), 'invalid_value', '$.add_reads');
  empty.add_writes = [{ path: 'app/x.ts', class: 'file', action: 'create' }];
  assert.equal(validateScopeRequest(empty).ok, true, 'one added write is enough');
});

test('Q15 scope: resolution outcome/granted_by consistency', () => {
  assertEnum(validateScopeResolution, approved, 'granted_by', SCOPE_GRANTED_BY);
  expectIssue(validateScopeResolution(setAt(clone(approved), 'outcome', 'denied')), 'invalid_value', '$.outcome');
  expectIssue(validateScopeResolution(setAt(clone(rejected), 'reason', null)), 'invalid_value', '$.reason');
  expectIssue(validateScopeResolution(setAt(clone(rejected), 'road_snapshot_after', approved.road_snapshot_after)), 'invalid_value', '$.road_snapshot_after');
  expectIssue(validateScopeResolution(setAt(clone(approved), 'road_snapshot_after', null)), 'invalid_value', '$.road_snapshot_after');
  expectIssue(validateScopeResolution(setAt(clone(rejected), 'granted_by', 'envelope')), 'invalid_value', '$.granted_by');
  expectIssue(validateScopeResolution(setAt(clone(approved), 'request', 'R1')), 'invalid_format', '$.request');
});

test('Q15 scope: input forms carry only what the actor authors (the CLI fills id, hash, ts, type, snapshot, granted_by)', () => {
  const request = {
    schema: 'akrs.scope-request/v1', road: 'R-P6-1', add_reads: [{ path: 'app/flag.ts', lines: null, why: null }], add_writes: [],
    reason: 'The flag file is needed.', blocking: true,
  };
  assert.equal(validateScopeRequest(request, { form: 'input' }).ok, true);
  for (const key of ['id', 'hash', 'ts', 'type', 'snapshot']) {
    expectIssue(validateScopeRequest({ ...request, [key]: 'x' }, { form: 'input' }), 'unknown_key', `$.${key}`);
  }
  const resolution = { schema: 'akrs.scope-resolution/v1', request: '01ARZ3NDEKTSV4RRFFQ69G5FAV', outcome: 'rejected', reason: 'Another Road owns it.' };
  assert.equal(validateScopeResolution(resolution, { form: 'input' }).ok, true);
  assert.equal(validateScopeResolution({ ...resolution, outcome: 'approved', reason: null }, { form: 'input' }).ok, true);
  expectIssue(validateScopeResolution({ ...resolution, reason: null }, { form: 'input' }), 'invalid_value', '$.reason');
  expectIssue(validateScopeResolution({ ...resolution, granted_by: 'leader' }, { form: 'input' }), 'unknown_key', '$.granted_by');
});
