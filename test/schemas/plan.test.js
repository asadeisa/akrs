import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLOSURE_STATUSES,
  FINDING_POINTER_STATUSES,
  PLAN_KEYS,
  PLAN_SCHEMA,
  QUESTION_STATUSES,
  validatePlan,
} from '../../lib/schemas/plan.js';
import {
  assertEnum,
  clone,
  defineClosedSchemaTests,
  expectIssue,
  loadFixtures,
  setAt,
} from './schema-harness.js';

const fixtures = await loadFixtures('plan', 'valid');
const open = fixtures.find(({ name }) => name === 'open').value;
const closed = fixtures.find(({ name }) => name === 'closed').value;
const stored = { form: 'stored' };

test('F13 Plan: owner decision - akrs.plan/v1 owns questions, seams, finding pointers and closure state', () => {
  assert.equal(PLAN_SCHEMA, 'akrs.plan/v1');
  assert.deepEqual(PLAN_KEYS, ['schema', 'id', 'title', 'questions', 'seams', 'findings', 'closure', 'meta']);
  assert.deepEqual(QUESTION_STATUSES, ['open', 'resolved']);
  assert.deepEqual(FINDING_POINTER_STATUSES, ['open', 'resolved']);
  assert.deepEqual(CLOSURE_STATUSES, ['open', 'closed']);
});

defineClosedSchemaTests({
  title: 'F13 Plan (stored form)',
  kind: 'plan',
  validate: validatePlan,
  options: stored,
  keys: PLAN_KEYS,
  primary: 'open',
  closedPaths: [
    '', 'questions[0]', 'questions[1]', 'questions[2]', 'seams[0]', 'seams[0].owner', 'seams[1]', 'seams[1].owner',
    'findings[0]', 'findings[1]', 'closure', 'meta',
  ],
});

test('F13 Plan: closed Plan states (open and closed fixtures)', () => {
  assert.equal(validatePlan(clone(closed), stored).ok, true);
});

test('F13 Plan: IDs share the global namespace and use the Q8 grammar', () => {
  expectIssue(validatePlan(setAt(clone(open), 'id', 'P 6'), stored), 'invalid_format', '$.id');
  expectIssue(validatePlan(setAt(clone(open), 'questions[0].id', '1'), stored), 'invalid_format', '$.questions[0].id');
  expectIssue(validatePlan(setAt(clone(open), 'findings[0].result', 'R-P6-1'), stored), 'invalid_format', '$.findings[0].result');
});

test('F13 Plan: question status and resolution rules (V10 §7: resolve it or record why it is accepted)', () => {
  assertEnum(validatePlan, open, 'questions[1].status', QUESTION_STATUSES.filter((value) => value === 'resolved'), stored);
  expectIssue(validatePlan(setAt(clone(open), 'questions[0].status', 'closed'), stored), 'invalid_value', '$.questions[0].status');
  expectIssue(validatePlan(setAt(clone(open), 'questions[0].resolution', 'answered'), stored), 'invalid_value', '$.questions[0].resolution');
  expectIssue(validatePlan(setAt(clone(open), 'questions[1].resolution', null), stored), 'invalid_value', '$.questions[1].resolution');
  expectIssue(validatePlan(setAt(clone(open), 'questions[0].decision', open.questions[2].decision), stored), 'invalid_value', '$.questions[0].decision');
  expectIssue(validatePlan(setAt(clone(open), 'questions[2].decision', 'R1'), stored), 'invalid_format', '$.questions[2].decision');
});

test('F13 Plan: seams name an owning Road or a wiring intent (V10 §6)', () => {
  expectIssue(validatePlan(setAt(clone(open), 'seams[0].owner', { road: null, intent: null }), stored), 'invalid_value', '$.seams[0].owner');
  expectIssue(validatePlan(setAt(clone(open), 'seams[0].owner.road', 'not an id'), stored), 'invalid_format', '$.seams[0].owner.road');
  expectIssue(validatePlan(setAt(clone(open), 'seams[1].owner.intent', ''), stored), 'invalid_value', '$.seams[1].owner.intent');
  const unowned = setAt(clone(open), 'seams[0].owner', null);
  assert.equal(validatePlan(unowned, stored).ok, true, 'an unowned seam is representable so the close gate can report it');
});

test('F13 Plan: findings are pointers at Tester result records, never copies of them', () => {
  expectIssue(validatePlan(setAt(clone(open), 'findings[0].status', 'done'), stored), 'invalid_value', '$.findings[0].status');
  expectIssue(validatePlan({ ...clone(open), findings: [{ ...open.findings[0], text: 'copied' }] }, stored), 'unknown_key', '$.findings[0].text');
  assertEnum(validatePlan, open, 'findings[0].status', FINDING_POINTER_STATUSES, stored);
});

test('F13 Plan: closure state is consistent (closed needs a time and an operation reference)', () => {
  assertEnum(validatePlan, open, 'closure.status', ['open'], stored);
  expectIssue(validatePlan(setAt(clone(closed), 'closure.at', null), stored), 'invalid_value', '$.closure.at');
  expectIssue(validatePlan(setAt(clone(closed), 'closure.operation', null), stored), 'invalid_value', '$.closure.operation');
  expectIssue(validatePlan(setAt(clone(open), 'closure.at', '2026-10-03T09:15:30.123Z'), stored), 'invalid_value', '$.closure.at');
  expectIssue(validatePlan(setAt(clone(open), 'closure.status', 'shipped'), stored), 'invalid_value', '$.closure.status');
});

test('F13 Plan: sets are sorted by id in the stored form and unique in every form (Q6)', () => {
  const reversed = clone(open);
  reversed.questions.reverse();
  expectIssue(validatePlan(reversed, stored), 'invalid_order', '$.questions');
  const input = clone(reversed);
  delete input.meta;
  delete input.findings;
  delete input.closure;
  assert.equal(validatePlan(input, { form: 'input' }).ok, true);
  const duplicate = clone(input);
  duplicate.questions[1].id = duplicate.questions[0].id;
  expectIssue(validatePlan(duplicate, { form: 'input' }), 'duplicate_value', '$.questions[1].id');
});

test('F13 Plan: State no longer stores open questions; they are a projection of Plan files', async () => {
  const { STATE_KEYS } = await import('../../lib/schemas/state.js');
  assert.equal(STATE_KEYS.includes('open_questions'), false);
});

test('Q1 Plan: the input form omits the CLI-owned findings and closure (an agent cannot close a Plan or resolve its own pointers)', async () => {
  const input = clone(open);
  delete input.findings;
  delete input.closure;
  delete input.meta;
  assert.equal(validatePlan(input, { form: 'input' }).ok, true);
  expectIssue(validatePlan({ ...clone(input), closure: clone(closed.closure) }, { form: 'input' }), 'unknown_key', '$.closure');
  expectIssue(validatePlan({ ...clone(input), findings: clone(open.findings) }, { form: 'input' }), 'unknown_key', '$.findings');
  expectIssue(validatePlan(clone(input), stored), 'missing_key', '$.closure');
  const { PLAN_INPUT_KEYS } = await import('../../lib/schemas/plan.js');
  assert.deepEqual(PLAN_INPUT_KEYS, ['schema', 'id', 'title', 'questions', 'seams']);
});

test('Q4 Plan: ids are unique case-folded inside the document (R-1 and r-1 name one file on Windows and macOS)', () => {
  const input = clone(open);
  input.questions[1].id = input.questions[0].id.toLowerCase() === input.questions[0].id ? input.questions[0].id.toUpperCase() : input.questions[0].id.toLowerCase();
  const stripped = { ...input };
  delete stripped.meta;
  delete stripped.findings;
  delete stripped.closure;
  expectIssue(validatePlan(stripped, { form: 'input' }), 'duplicate_value', '$.questions[1].id');
  const seams = clone(stripped);
  seams.questions = [];
  seams.seams[1].id = seams.seams[0].id.toLowerCase();
  seams.seams[0].id = seams.seams[0].id.toUpperCase();
  expectIssue(validatePlan(seams, { form: 'input' }), 'duplicate_value', '$.seams[1].id');
});
