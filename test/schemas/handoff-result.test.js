import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACCEPTANCE_ANSWERS,
  FINDING_STATUSES,
  HANDOFF_INPUT_KEYS,
  HANDOFF_KEYS,
  HANDOFF_SCHEMA,
  RESULT_INPUT_KEYS,
  RESULT_KEYS,
  RESULT_SCHEMA,
  VERDICTS,
  validateHandoff,
  validateResult,
} from '../../lib/schemas/handoff-result.js';
import {
  assertEnum,
  clone,
  defineClosedSchemaTests,
  describeIssues,
  expectIssue,
  loadFixtures,
  setAt,
} from './schema-harness.js';

const handoffs = await loadFixtures('handoff', 'valid');
const ready = handoffs.find(({ name }) => name === 'ready').value;
const results = await loadFixtures('result', 'valid');
const pass = results.find(({ name }) => name === 'pass').value;

test('F6/Q22 handoff and result: frozen records', () => {
  assert.equal(HANDOFF_SCHEMA, 'akrs.handoff/v1');
  assert.equal(RESULT_SCHEMA, 'akrs.result/v1');
  assert.deepEqual(HANDOFF_KEYS, ['id', 'hash', 'ts', 'road', 'snapshot', 'result', 'reach', 'expect', 'ready']);
  assert.deepEqual(HANDOFF_INPUT_KEYS, ['schema', 'road', 'result', 'reach', 'expect']);
  assert.deepEqual(RESULT_KEYS, [
    'id', 'hash', 'ts', 'plan', 'tested_snapshot', 'contract_hash', 'verdict', 'checks', 'measurements', 'evidence',
    'findings', 'user_acceptance', 'run',
  ]);
  assert.deepEqual(RESULT_INPUT_KEYS, ['schema', 'verdict', 'checks', 'measurements', 'evidence', 'findings', 'user_acceptance']);
  assert.deepEqual(VERDICTS, ['pass', 'fail', 'blocked']);
  assert.deepEqual(ACCEPTANCE_ANSWERS, ['yes', 'no']);
  assert.deepEqual(FINDING_STATUSES, ['open', 'resolved']);
});

defineClosedSchemaTests({
  title: 'F6 handoff record',
  kind: 'handoff',
  validate: (value) => validateHandoff(value),
  keys: HANDOFF_KEYS,
  primary: 'ready',
  closedPaths: [''],
});

defineClosedSchemaTests({
  title: 'F6 Tester result record',
  kind: 'result',
  validate: (value) => validateResult(value),
  keys: RESULT_KEYS,
  primary: 'pass',
  closedPaths: [
    '', 'checks[0]', 'checks[1]', 'measurements[0]', 'measurements[1]', 'evidence[0]', 'evidence[1]', 'findings[0]',
    'findings[1]', 'user_acceptance',
  ],
});

test('F6 handoff: it is a baton - it never changes acceptance and carries no acceptance field', () => {
  for (const key of ['acceptance', 'verdict', 'findings', 'measurements']) {
    expectIssue(validateHandoff({ ...clone(ready), [key]: [] }), 'unknown_key', `$.${key}`);
  }
  expectIssue(validateHandoff(setAt(clone(ready), 'reach', [])), 'invalid_value', '$.reach');
  expectIssue(validateHandoff(setAt(clone(ready), 'reach', ['ok', ''])), 'invalid_value', '$.reach[1]');
  expectIssue(validateHandoff(setAt(clone(ready), 'result', '')), 'invalid_value', '$.result');
  expectIssue(validateHandoff(setAt(clone(ready), 'road', 'R 1')), 'invalid_format', '$.road');
  expectIssue(validateHandoff(setAt(clone(ready), 'snapshot', 'x')), 'invalid_format', '$.snapshot');
});

test('F6 handoff: input form is the agent-authored subset (the CLI fills id, hash, ts, snapshot, ready)', () => {
  const input = {
    schema: 'akrs.handoff/v1', road: 'R-P6-1', result: 'The admin page lists items.',
    reach: ['Open /admin'], expect: 'A toast says Saved.',
  };
  assert.equal(validateHandoff(input, { form: 'input' }).ok, true);
  expectIssue(validateHandoff({ ...input, ready: true }, { form: 'input' }), 'unknown_key', '$.ready');
  expectIssue(validateHandoff({ ...input, snapshot: ready.snapshot }, { form: 'input' }), 'unknown_key', '$.snapshot');
  expectIssue(validateHandoff(input, { form: 'stored' }), 'missing_key', '$.id');
});

test('Q22 result: verdict, acceptance answer, finding status enums are exact', () => {
  assertEnum((value) => validateResult(value), pass, 'verdict', VERDICTS);
  assertEnum((value) => validateResult(value), pass, 'user_acceptance.answer', ACCEPTANCE_ANSWERS);
  assertEnum((value) => validateResult(value), pass, 'findings[0].status', FINDING_STATUSES);
});

test('Q22 result: input form carries only what the Tester authors', () => {
  const input = {
    schema: 'akrs.result/v1', verdict: 'pass', checks: [], measurements: [], evidence: [],
    findings: [], user_acceptance: { answer: 'yes', because: 'it works' },
  };
  assert.equal(validateResult(input, { form: 'input' }).ok, true);
  for (const key of ['plan', 'tested_snapshot', 'contract_hash', 'run', 'id', 'hash', 'ts']) {
    expectIssue(validateResult({ ...input, [key]: null }, { form: 'input' }), 'unknown_key', `$.${key}`);
  }
});

test('Q22 result: measurements are integers (canonical JSON) and checks carry integer exit codes', () => {
  expectIssue(validateResult(setAt(clone(pass), 'measurements[0].value', 16.7)), 'invalid_type', '$.measurements[0].value');
  expectIssue(validateResult(setAt(clone(pass), 'checks[0].exit_code', 0.5)), 'invalid_type', '$.checks[0].exit_code');
  assert.equal(validateResult(setAt(clone(pass), 'checks[0].exit_code', null)).ok, true, 'a check that did not run has no exit code');
  assert.equal(validateResult(setAt(clone(pass), 'measurements[0].value', -3)).ok, true);
  expectIssue(validateResult(setAt(clone(pass), 'measurements[0].unit', '')), 'invalid_value', '$.measurements[0].unit');
});

test('Q22 result: findings have unique IDs, evidence is a set sorted by path, run is a ULID or null', () => {
  const duplicate = clone(pass);
  duplicate.findings = [{ id: 'F-1', text: 'a', status: 'open' }, { id: 'F-1', text: 'b', status: 'open' }];
  expectIssue(validateResult(duplicate), 'duplicate_value', '$.findings[1].id');
  const unsorted = clone(pass);
  unsorted.evidence.reverse();
  expectIssue(validateResult(unsorted), 'invalid_order', '$.evidence');
  expectIssue(validateResult(setAt(clone(pass), 'run', 'P6')), 'invalid_format', '$.run');
  assert.equal(validateResult(setAt(clone(pass), 'run', null)).ok, true);
  expectIssue(validateResult(setAt(clone(pass), 'user_acceptance.because', '')), 'invalid_value', '$.user_acceptance.because');
});

test('Q22/Q33 result: evidence must sit under this Plan evidence directory and stay a closed reference', () => {
  expectIssue(validateResult(setAt(clone(pass), 'evidence[0].path', 'akrs/verifications/P7/evidence/home.png')), 'invalid_value', '$.evidence[0].path');
  expectIssue(validateResult(setAt(clone(pass), 'evidence[0].path', 'home.png')), 'invalid_value', '$.evidence[0].path');
  expectIssue(validateResult(setAt(clone(pass), 'evidence[0].type', 'video')), 'invalid_value', '$.evidence[0].type');
  expectIssue(validateResult(setAt(clone(pass), 'evidence[0].data', 'AAAA')), 'unknown_key', '$.evidence[0].data');
});

test('Q33 result and handoff: embedded binary is rejected in every free-text field', () => {
  const payloads = [
    'data:image/png;base64,iVBORw0KGgo=', 'x'.repeat(10) + 'A'.repeat(600), 'nul\u0000byte',
  ];
  for (const payload of payloads) {
    const targets = [
      [validateResult, pass, 'findings[0].text'], [validateResult, pass, 'user_acceptance.because'],
      [validateResult, pass, 'checks[0].name'], [validateHandoff, ready, 'result'], [validateHandoff, ready, 'reach[0]'],
      [validateHandoff, ready, 'expect'],
    ];
    for (const [validate, base, path] of targets) {
      const result = validate(setAt(clone(base), path, payload));
      assert.equal(result.ok, false, `${path} ${payload.slice(0, 12)}`);
      assert.equal(
        result.issues.some((entry) => entry.path === `$.${path}`),
        true,
        `${path}: ${describeIssues(result)}`,
      );
    }
  }
});

test('F4 Unicode free text is accepted verbatim in handoff and result fields', () => {
  for (const { name, value } of handoffs) assert.equal(validateHandoff(clone(value)).ok, true, name);
  for (const { name, value } of results) assert.equal(validateResult(clone(value)).ok, true, name);
});

test('Q30 result: evidence must sit under the discovered workflow root', () => {
  const moved = clone(pass);
  moved.evidence = moved.evidence.map((ref) => ({ ...ref, path: ref.path.replace('akrs/', 'wf/') }));
  assert.equal(validateResult(moved, { workflowRoot: 'wf' }).ok, true);
  expectIssue(validateResult(moved), 'invalid_value', '$.evidence[0].path');
  expectIssue(validateResult(pass, { workflowRoot: 'wf' }), 'invalid_value', '$.evidence[0].path');
});

test('NIT AX rule: the Result input names evidence by path and type only; the CLI fills bytes and sha256', () => {
  const input = {
    schema: 'akrs.result/v1', verdict: 'pass', checks: [], measurements: [], findings: [],
    evidence: [{ path: 'akrs/verifications/P6/evidence/home.png', type: 'screenshot' }],
    user_acceptance: { answer: 'yes', because: 'it works' },
  };
  assert.equal(validateResult(clone(input), { form: 'input' }).ok, true);
  expectIssue(validateResult({ ...clone(input), evidence: [{ ...input.evidence[0], bytes: 5, sha256: `sha256:${'a'.repeat(64)}` }] }, { form: 'input' }),
    'unknown_key', '$.evidence[0].bytes');
  expectIssue(validateResult({ ...clone(input), evidence: [{ path: input.evidence[0].path }] }, { form: 'input' }), 'missing_key', '$.evidence[0].type');
  expectIssue(validateResult({ ...clone(input), evidence: [{ path: 'elsewhere/home.png', type: 'screenshot' }] }, { form: 'input', workflowRoot: 'akrs' }),
    'invalid_value', '$.evidence[0].path');
  expectIssue(validateResult(setAt(clone(pass), 'evidence[0]', { path: pass.evidence[0].path, type: 'screenshot' })), 'missing_key', '$.evidence[0].bytes');
});
