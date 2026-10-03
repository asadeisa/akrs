import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLASS_KNOBS,
  EXECUTORS_KEYS,
  EXECUTORS_SCHEMA,
  EXECUTOR_CLASSES,
  EXECUTOR_ROLES,
  validateExecutors,
} from '../../lib/schemas/executors.js';
import {
  assertEnum,
  clone,
  defineClosedSchemaTests,
  describeIssues,
  expectIssue,
  loadFixtures,
  setAt,
} from './schema-harness.js';

const fixtures = await loadFixtures('executors', 'valid');
const full = fixtures.find(({ name }) => name === 'full').value;
const stored = { form: 'stored' };

test('F15 executors: frozen schema (A1 §2.1) and knob table (Q17)', () => {
  assert.equal(EXECUTORS_SCHEMA, 'akrs.executors/v1');
  assert.deepEqual(EXECUTORS_KEYS, ['schema', 'executors', 'class_overrides', 'meta']);
  assert.deepEqual(EXECUTOR_ROLES, ['leader', 'worker', 'tester']);
  assert.deepEqual(EXECUTOR_CLASSES, ['weak', 'medium', 'frontier']);
  assert.deepEqual(CLASS_KNOBS, [
    'max_writes', 'max_write_dirs', 'read_budget_tokens', 'done_failures_before_yield', 'envelope_grant_cap',
  ]);
});

defineClosedSchemaTests({
  title: 'F15 executors (stored form)',
  kind: 'executors',
  validate: validateExecutors,
  options: stored,
  keys: EXECUTORS_KEYS,
  primary: 'full',
  closedPaths: [
    '', 'executors[0]', 'executors[1]', 'executors[2]', 'class_overrides', 'class_overrides.weak',
    'class_overrides.frontier', 'meta',
  ],
  // overrides are sparse by design (A1 §2.1 shows class_overrides: {}); knobs are a closed set but optional
  optionalKeys: {
    class_overrides: ['weak', 'medium', 'frontier'],
    'class_overrides.weak': CLASS_KNOBS,
    'class_overrides.frontier': CLASS_KNOBS,
  },
});

test('F15 executors: input form omits only meta', () => {
  const input = clone(full);
  delete input.meta;
  assert.equal(validateExecutors(input, { form: 'input' }).ok, true);
  expectIssue(validateExecutors(full, { form: 'input' }), 'unknown_key', '$.meta');
});

test('F15 executors: enums, IDs and verbatim user_answer', () => {
  assertEnum(validateExecutors, full, 'executors[0].role', EXECUTOR_ROLES, stored);
  assertEnum(validateExecutors, full, 'executors[0].class', EXECUTOR_CLASSES, stored);
  expectIssue(validateExecutors(setAt(clone(full), 'executors[0].id', 'a b'), stored), 'invalid_format', '$.executors[0].id');
  expectIssue(validateExecutors(setAt(clone(full), 'executors[0].label', ''), stored), 'invalid_value', '$.executors[0].label');
  expectIssue(validateExecutors(setAt(clone(full), 'executors[0].user_answer', ''), stored), 'invalid_value', '$.executors[0].user_answer');
  const verbatim = setAt(clone(full), 'executors[0].user_answer', '  weak — cheap, needs small steps  ');
  assert.equal(validateExecutors(verbatim, stored).ok, true, 'the user words are stored as given');
});

test('F15 executors: the class is the user answer, never derived from the label', () => {
  const swapped = clone(full);
  swapped.executors[0].label = 'Claude Opus frontier model';
  swapped.executors[0].class = 'weak';
  assert.equal(validateExecutors(swapped, stored).ok, true, 'no model-name inference exists');
  expectIssue(validateExecutors(setAt(clone(full), 'executors[0].class', null), stored), 'invalid_value', '$.executors[0].class');
});

test('F15 executors: set semantics - sorted by id, unique ids (Q6)', () => {
  const unsorted = clone(full);
  unsorted.executors.reverse();
  expectIssue(validateExecutors(unsorted, stored), 'invalid_order', '$.executors');
  const input = clone(unsorted);
  delete input.meta;
  assert.equal(validateExecutors(input, { form: 'input' }).ok, true);
  const duplicate = clone(full);
  delete duplicate.meta;
  duplicate.executors[1].id = duplicate.executors[0].id;
  expectIssue(validateExecutors(duplicate, { form: 'input' }), 'duplicate_value', '$.executors[1].id');
});

test('F15 executors: class_overrides are closed numeric knobs per class', () => {
  for (const knob of CLASS_KNOBS) {
    const candidate = clone(full);
    candidate.class_overrides = { medium: { [knob]: 7 } };
    assert.equal(validateExecutors(candidate, stored).ok, true, knob);
  }
  for (const value of [0, -1, 1.5, '4', null, true, 1000001]) {
    const candidate = clone(full);
    candidate.class_overrides = { weak: { max_writes: value } };
    const result = validateExecutors(candidate, stored);
    assert.equal(result.ok, false, String(value));
    assert.equal(result.issues.some((entry) => entry.path === '$.class_overrides.weak.max_writes'), true, describeIssues(result));
  }
  const unknownClass = clone(full);
  unknownClass.class_overrides = { strong: { max_writes: 2 } };
  expectIssue(validateExecutors(unknownClass, stored), 'unknown_key', '$.class_overrides.strong');
  const empty = clone(full);
  empty.class_overrides = { weak: {} };
  expectIssue(validateExecutors(empty, stored), 'invalid_value', '$.class_overrides.weak');
  const notNumber = clone(full);
  notNumber.class_overrides = { weak: { allowed_write_classes: ['file'] } };
  expectIssue(validateExecutors(notNumber, stored), 'unknown_key', '$.class_overrides.weak.allowed_write_classes');
});

test('F15 executors: envelope_grant_cap may be 0 (no auto-grants); every other knob starts at 1', () => {
  const zero = clone(full);
  zero.class_overrides = { weak: { envelope_grant_cap: 0 } };
  assert.equal(validateExecutors(zero, stored).ok, true);
  for (const knob of CLASS_KNOBS.filter((name) => name !== 'envelope_grant_cap')) {
    const candidate = clone(full);
    candidate.class_overrides = { weak: { [knob]: 0 } };
    expectIssue(validateExecutors(candidate, stored), 'invalid_value', `$.class_overrides.weak.${knob}`);
  }
  const negative = clone(full);
  negative.class_overrides = { weak: { envelope_grant_cap: -1 } };
  expectIssue(validateExecutors(negative, stored), 'invalid_value', '$.class_overrides.weak.envelope_grant_cap');
});

test('Q4 executors: ids are unique case-folded', () => {
  const input = clone(full);
  delete input.meta;
  input.executors[1].id = input.executors[0].id.toUpperCase();
  input.executors[0].id = input.executors[0].id.toLowerCase();
  expectIssue(validateExecutors(input, { form: 'input' }), 'duplicate_value', '$.executors[1].id');
});
