import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLOSURE_KEYS,
  CLOSURE_KINDS,
  CLOSURE_OUTCOMES,
  CLOSURE_SCHEMA,
  validateClosure,
} from '../../lib/schemas/closure.js';
import { assertEnum, clone, defineClosedSchemaTests, expectIssue, loadFixtures, setAt } from './schema-harness.js';

const fixtures = await loadFixtures('closure', 'valid');
const done = fixtures.find(({ name }) => name === 'road-done').value;

test('F6 closure: frozen record (Q19) - no telemetry, kind road|plan, optional operation reference', () => {
  assert.equal(CLOSURE_SCHEMA, 'akrs.closure/v1');
  assert.deepEqual(CLOSURE_KEYS, ['id', 'hash', 'ts', 'kind', 'subject', 'outcome', 'deviations', 'operation']);
  assert.deepEqual(CLOSURE_KINDS, ['road', 'plan']);
  assert.deepEqual(CLOSURE_OUTCOMES, ['DONE', 'BLOCKED']);
  for (const telemetry of ['model', 'tokens', 'effort', 'duration_ms', 'tools']) {
    assert.equal(CLOSURE_KEYS.includes(telemetry), false);
  }
});

defineClosedSchemaTests({
  title: 'F6 closure',
  kind: 'closure',
  validate: (value) => validateClosure(value),
  keys: CLOSURE_KEYS,
  primary: 'road-done',
  closedPaths: ['', 'operation'],
});

test('F6 closure: enums, IDs and timestamps', () => {
  assertEnum(validateClosure, done, 'kind', CLOSURE_KINDS);
  assertEnum(validateClosure, done, 'outcome', CLOSURE_OUTCOMES);
  expectIssue(validateClosure(setAt(clone(done), 'id', '01ARZ3NDEKTSV4RRFFQ69G5FAI')), 'invalid_format', '$.id');
  expectIssue(validateClosure(setAt(clone(done), 'hash', 'abc')), 'invalid_format', '$.hash');
  expectIssue(validateClosure(setAt(clone(done), 'subject', 'R 1')), 'invalid_format', '$.subject');
  for (const ts of ['2026-10-03T09:15:30Z', '2026-10-03T09:15:30.123+00:00', '2026-02-30T09:15:30.123Z', 'yesterday']) {
    const result = validateClosure(setAt(clone(done), 'ts', ts));
    assert.equal(result.ok, false, ts);
    assert.equal(result.issues.some((entry) => entry.path === '$.ts'), true, ts);
  }
});

test('F6 closure: deviations is a non-empty string or null; operation is a closed {request, run} ULID pair (Q23)', () => {
  expectIssue(validateClosure(setAt(clone(done), 'deviations', '')), 'invalid_value', '$.deviations');
  expectIssue(validateClosure(setAt(clone(done), 'operation.request', 'x')), 'invalid_format', '$.operation.request');
  expectIssue(validateClosure(setAt(clone(done), 'operation.run', null)), 'invalid_format', '$.operation.run');
});
