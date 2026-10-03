import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STATE_INPUT_KEYS,
  STATE_KEYS,
  STATE_MODES,
  STATE_ROLES,
  STATE_SCHEMA,
  validateState,
} from '../../lib/schemas/state.js';
import {
  assertEnum,
  clone,
  defineClosedSchemaTests,
  expectIssue,
  loadFixtures,
  setAt,
} from './schema-harness.js';

const fixtures = await loadFixtures('state', 'valid');
const full = fixtures.find(({ name }) => name === 'full').value;
const stored = { form: 'stored' };

test('F6 State: frozen authored fields (Q20); open questions live in Plan files (Q13)', () => {
  assert.equal(STATE_SCHEMA, 'akrs.state/v1');
  assert.deepEqual(STATE_KEYS, ['schema', 'mode', 'role', 'plan', 'phase', 'task', 'next', 'updated', 'meta']);
  assert.deepEqual(STATE_INPUT_KEYS, ['schema', 'mode', 'role', 'plan', 'phase', 'task', 'next']);
  assert.deepEqual(STATE_MODES, [0, 1, 2, 3, 4]);
  assert.deepEqual(STATE_ROLES, ['leader', 'worker', 'tester']);
  assert.equal(STATE_KEYS.includes('open_questions'), false);
});

defineClosedSchemaTests({
  title: 'F6 State (stored form)',
  kind: 'state',
  validate: validateState,
  options: stored,
  keys: STATE_KEYS,
  primary: 'full',
  closedPaths: ['', 'updated', 'meta'],
});

test('F6 State: input form omits the CLI-owned updated and meta', () => {
  const input = clone(full);
  delete input.updated;
  delete input.meta;
  assert.equal(validateState(input, { form: 'input' }).ok, true);
  expectIssue(validateState({ ...input, updated: full.updated }, { form: 'input' }), 'unknown_key', '$.updated');
  expectIssue(validateState(input, stored), 'missing_key', '$.updated');
});

test('F6 State: enums and mode range', () => {
  assertEnum(validateState, full, 'role', STATE_ROLES, stored);
  for (const mode of [0, 4]) assert.equal(validateState(setAt(clone(full), 'mode', mode), stored).ok, true);
  for (const mode of [-1, 5]) {
    expectIssue(validateState(setAt(clone(full), 'mode', mode), stored), 'invalid_value', '$.mode');
  }
  for (const mode of [2.5, '3', null]) {
    expectIssue(validateState(setAt(clone(full), 'mode', mode), stored), 'invalid_type', '$.mode');
  }
});

test('F6 State: updated carries the only timestamp (Q20/Q29)', () => {
  expectIssue(validateState(setAt(clone(full), 'updated.at', '2026-10-03'), stored), 'invalid_format', '$.updated.at');
  expectIssue(validateState(setAt(clone(full), 'updated.by', ''), stored), 'invalid_value', '$.updated.by');
  expectIssue(validateState(setAt(clone(full), 'plan', 'not an id'), stored), 'invalid_format', '$.plan');
});

test('F6 State: free fields accept Unicode and embedded line breaks verbatim', () => {
  const free = fixtures.find(({ name }) => name === 'freefield-unicode').value;
  assert.equal(validateState(clone(free), stored).ok, true);
  assert.equal(free.next.includes('\r\n'), true);
  assert.equal(free.next.includes('\u2028'), true);
});
