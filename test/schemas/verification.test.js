import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EVIDENCE_TYPES,
  MEASUREMENT_DIRECTIONS,
  RUN_KEYS,
  RUN_SCHEMA,
  RUN_STATUSES,
  VERIFICATION_KEYS,
  VERIFICATION_POLICIES,
  VERIFICATION_SCHEMA,
  validateEvidenceRef,
  validateRun,
  validateVerification,
} from '../../lib/schemas/verification.js';
import {
  assertEnum,
  clone,
  defineClosedSchemaTests,
  describeIssues,
  expectIssue,
  loadFixtures,
  setAt,
} from './schema-harness.js';

const fixtures = await loadFixtures('verification', 'valid');
const full = fixtures.find(({ name }) => name === 'full').value;
const none = fixtures.find(({ name }) => name === 'policy-none').value;
const stored = { form: 'stored' };

test('F6/Q21 verification contract: frozen keys and vocabularies', () => {
  assert.equal(VERIFICATION_SCHEMA, 'akrs.verification/v1');
  assert.deepEqual(VERIFICATION_KEYS, [
    'schema', 'plan', 'roads', 'policy', 'reads', 'launch', 'setup', 'teardown', 'acceptance', 'measurements',
    'evidence_types', 'reachability', 'boundaries', 'timeout_ms', 'allowed_hosts', 'scenario', 'meta',
  ]);
  assert.deepEqual(VERIFICATION_POLICIES, ['none', 'checks', 'live', 'measured']);
  assert.deepEqual(EVIDENCE_TYPES, ['screenshot', 'console', 'network', 'a11y', 'timing', 'log', 'file']);
  assert.deepEqual(MEASUREMENT_DIRECTIONS, ['max', 'min']);
});

const scenarioClosedPaths = Array.from({ length: 17 }, (_, index) => `scenario[${index}]`);
defineClosedSchemaTests({
  title: 'F6 verification contract (stored form)',
  kind: 'verification',
  validate: validateVerification,
  options: stored,
  keys: VERIFICATION_KEYS,
  primary: 'full',
  skipPaths: ['scenario[11].expect_json.equals'],
  closedPaths: [
    '', 'reads[0]', 'reads[1]', 'launch', 'launch.ready', 'setup[0]', 'setup[1]', 'teardown[0]', 'teardown[1]',
    'measurements[0]', 'measurements[1]', ...scenarioClosedPaths,
    'scenario[11].headers[0]', 'scenario[11].headers[1]', 'scenario[11].expect_json', 'meta',
  ],
  atomicPaths: ['reads[].lines', 'launch.argv', 'setup[].argv', 'teardown[].argv'],
});

test('F6 verification: policy enum and the keys each policy requires (live/measured need a launch; measured needs a measurement)', () => {
  assertEnum(validateVerification, none, 'policy', ['none'], stored);
  for (const policy of ['live', 'measured']) {
    assert.equal(validateVerification(setAt(clone(full), 'policy', policy), stored).ok, true, policy);
  }
  expectIssue(validateVerification(setAt(clone(full), 'policy', 'MEASURED'), stored), 'invalid_value', '$.policy');
  const checks = setAt(clone(none), 'policy', 'checks');
  assert.equal(validateVerification(checks, stored).ok, true);
  const live = setAt(clone(none), 'policy', 'live');
  expectIssue(validateVerification(live, stored), 'invalid_value', '$.launch');
  const measuredNoMeasurement = setAt(clone(full), 'measurements', []);
  expectIssue(validateVerification(measuredNoMeasurement, stored), 'invalid_value', '$.measurements');
  expectIssue(validateVerification(setAt(clone(full), 'policy', 'none'), stored), 'invalid_value', '$.launch');
  expectIssue(validateVerification(setAt(clone(full), 'policy', 'checks'), stored), 'invalid_value', '$.scenario');
});

test('F6 verification: IDs, sets and ordered lists', () => {
  expectIssue(validateVerification(setAt(clone(full), 'plan', 'not an id'), stored), 'invalid_format', '$.plan');
  expectIssue(validateVerification(setAt(clone(full), 'roads', ['R-B', 'R-A']), stored), 'invalid_order', '$.roads');
  expectIssue(validateVerification(setAt(clone(full), 'roads', ['R-A', 'R-A']), stored), 'duplicate_value', '$.roads[1]');
  expectIssue(validateVerification(setAt(clone(full), 'roads', []), stored), 'invalid_value', '$.roads');
  expectIssue(validateVerification(setAt(clone(full), 'evidence_types', ['timing', 'a11y']), stored), 'invalid_order', '$.evidence_types');
  expectIssue(validateVerification(setAt(clone(full), 'evidence_types', ['video']), stored), 'invalid_value', '$.evidence_types[0]');
  expectIssue(validateVerification(setAt(clone(full), 'allowed_hosts', ['https://x.test']), stored), 'invalid_format', '$.allowed_hosts[0]');
  const reordered = clone(full);
  reordered.acceptance = ['second', 'first'];
  reordered.reachability = ['b', 'a'];
  reordered.boundaries = ['z', 'a'];
  assert.equal(validateVerification(reordered, stored).ok, true, 'authored order is preserved, not an error');
});

test('F6 verification: no-Plan tier keys the contract by a Road ID (Q13)', () => {
  assert.equal(none.plan, none.roads[0]);
  assert.equal(validateVerification(clone(none), stored).ok, true);
});

test('Q21 verification: launch, ready, setup/teardown, measurements and bounds', () => {
  expectIssue(validateVerification(setAt(clone(full), 'launch.argv', []), stored), 'invalid_argv', '$.launch.argv');
  expectIssue(validateVerification(setAt(clone(full), 'launch.url', 'file:///x'), stored), 'invalid_value', '$.launch.url');
  expectIssue(validateVerification(setAt(clone(full), 'launch.ready.status', 99), stored), 'invalid_value', '$.launch.ready.status');
  expectIssue(validateVerification(setAt(clone(full), 'launch.ready.timeout_ms', 0), stored), 'invalid_value', '$.launch.ready.timeout_ms');
  expectIssue(validateVerification(setAt(clone(full), 'setup', [{ name: 'x', argv: [] }]), stored), 'invalid_argv', '$.setup[0].argv');
  expectIssue(validateVerification(setAt(clone(full), 'measurements[0].direction', 'avg'), stored), 'invalid_value', '$.measurements[0].direction');
  expectIssue(validateVerification(setAt(clone(full), 'measurements[0].budget', 16.5), stored), 'invalid_type', '$.measurements[0].budget');
  expectIssue(validateVerification(setAt(clone(full), 'timeout_ms', 0), stored), 'invalid_value', '$.timeout_ms');
  expectIssue(validateVerification(setAt(clone(full), 'timeout_ms', 3600001), stored), 'invalid_value', '$.timeout_ms');
  const duplicateName = clone(full);
  duplicateName.measurements.push({ ...duplicateName.measurements[0] });
  expectIssue(validateVerification(duplicateName, stored), 'duplicate_value', '$.measurements[2].name');
});

test('Q21 verification: reads reuse the Road read entry shape, preserving order and why', () => {
  expectIssue(validateVerification(setAt(clone(full), 'reads[0].lines', [9, 1]), stored), 'invalid_line_range', '$.reads[0].lines');
  expectIssue(validateVerification(setAt(clone(full), 'reads[0].path', '../SOT/x.md'), stored), 'invalid_path', '$.reads[0].path');
});

test('Q33/F6 evidence reference is closed and lives under the Plan evidence directory', () => {
  const ok = { path: 'akrs/verifications/P6/evidence/home.png', type: 'screenshot', bytes: 10, sha256: `sha256:${'a'.repeat(64)}` };
  const check = (value, options = { plan: 'P6' }) => {
    const issues = [];
    validateEvidenceRef(value, '$.e', issues, options);
    return { ok: issues.length === 0, issues };
  };
  assert.equal(check(ok).ok, true);
  assert.equal(check({ ...ok, path: 'akrs/verifications/P6/evidence/run-1/a/b.log', type: 'log' }).ok, true);
  for (const path of [
    'akrs/verifications/P7/evidence/home.png', 'akrs/verifications/P6/home.png', 'akrs/verifications/P6/evidence/',
    'akrs/verifications/P6/evidence/../x', 'evidence/home.png', '/abs/evidence/home.png',
    'akrs/verifications/P6/evidence/a:b', 'akrs/verifications/P6/evidence/a\\b',
  ]) {
    assert.equal(check({ ...ok, path }).ok, false, path);
  }
  assert.equal(check({ ...ok, type: 'video' }).ok, false);
  assert.equal(check({ ...ok, bytes: -1 }).ok, false);
  assert.equal(check({ ...ok, bytes: 1.5 }).ok, false);
  assert.equal(check({ ...ok, sha256: 'abc' }).ok, false);
  assert.equal(check({ ...ok, data: 'iVBORw0KGgo=' }).ok, false, 'no inline data key');
  assert.equal(check({ ...ok, path: 'akrs/verifications/other/evidence/x.png' }, { plan: null }).ok, true, 'the plan segment is not checked without a plan');
});

test('Q33 verification: embedded binary payloads are rejected anywhere in free text', () => {
  const base = clone(full);
  for (const text of [
    'data:image/png;base64,iVBORw0KGgo=', `payload ${'QUJD'.repeat(200)} end`, 'nul\u0000byte',
  ]) {
    const result = validateVerification(setAt(clone(base), 'acceptance', [text]), stored);
    assert.equal(result.ok, false, text.slice(0, 20));
    assert.equal(result.issues.some((entry) => entry.code === 'embedded_binary' && entry.path === '$.acceptance[0]'), true, describeIssues(result));
  }
  const prose = `A long sentence about base64 ${'word '.repeat(300)}is not a base64 run.`;
  assert.equal(validateVerification(setAt(clone(base), 'acceptance', [prose]), stored).ok, true);
});

// ---- run record
const runs = await loadFixtures('run', 'valid');
const passed = runs.find(({ name }) => name === 'passed').value;

test('F18/Q21 run record: frozen shape', () => {
  assert.equal(RUN_SCHEMA, 'akrs.run/v1');
  assert.deepEqual(RUN_KEYS, [
    'schema', 'id', 'plan', 'snapshot', 'contract_hash', 'started_at', 'ended_at', 'status', 'steps', 'evidence', 'meta',
  ]);
  assert.deepEqual(RUN_STATUSES, ['passed', 'failed', 'blocked']);
});

defineClosedSchemaTests({
  title: 'F18 run record (stored form)',
  kind: 'run',
  validate: validateRun,
  options: stored,
  keys: RUN_KEYS,
  primary: 'passed',
  closedPaths: [
    '', 'steps[0]', 'steps[1]', 'steps[1].evidence[0]', 'steps[1].evidence[1]', 'steps[2]', 'evidence[0]', 'evidence[1]', 'meta',
  ],
});

test('F18 run record: steps are consecutive from 0 and evidence stays under the Plan evidence dir', () => {
  expectIssue(validateRun(setAt(clone(passed), 'steps[1].index', 3), stored), 'invalid_value', '$.steps[1].index');
  expectIssue(validateRun(setAt(clone(passed), 'steps[0].step', 'eval'), stored), 'unknown_step', '$.steps[0].step');
  expectIssue(validateRun(setAt(clone(passed), 'evidence[0].path', 'akrs/verifications/P9/evidence/x.png'), stored), 'invalid_value', '$.evidence[0].path');
  expectIssue(validateRun(setAt(clone(passed), 'steps[0].status', 'ok'), stored), 'invalid_value', '$.steps[0].status');
  expectIssue(validateRun(setAt(clone(passed), 'steps[0].duration_ms', -1), stored), 'invalid_value', '$.steps[0].duration_ms');
  // the status must also agree with the hard steps, so each valid status gets a consistent step list
  const consistent = (status) => {
    const run = setAt(clone(passed), 'status', status);
    if (status === 'failed') run.steps[2].soft = false;
    return run;
  };
  for (const status of RUN_STATUSES) assert.equal(validateRun(consistent(status), stored).ok, true, status);
  for (const status of ['PASSED', 'passed ', 'ok', null, 4.5]) {
    expectIssue(validateRun(setAt(clone(passed), 'status', status), stored), 'invalid_value', '$.status');
  }
});

test('Q30 evidence directory follows the discovered workflow root', () => {
  const ref = (path) => ({ path, type: 'screenshot', bytes: 10, sha256: `sha256:${'a'.repeat(64)}` });
  const check = (path, options) => {
    const issues = [];
    validateEvidenceRef(ref(path), '$.e', issues, options);
    return issues.length === 0;
  };
  assert.equal(check('wf/verifications/P6/evidence/home.png', { plan: 'P6', workflowRoot: 'wf' }), true);
  assert.equal(check('akrs/verifications/P6/evidence/home.png', { plan: 'P6', workflowRoot: 'wf' }), false);
  assert.equal(check('wf/verifications/P7/evidence/home.png', { plan: 'P6', workflowRoot: 'wf' }), false);
  assert.equal(check('wf/verifications/other/evidence/x.png', { plan: null, workflowRoot: 'wf' }), true);
  assert.equal(check('akrs/verifications/other/evidence/x.png', { plan: null, workflowRoot: 'wf' }), false);
  assert.equal(check('tools/wf/verifications/P6/evidence/a/b.log', { plan: 'P6', workflowRoot: 'tools/wf' }), true);
  assert.equal(check('akrs/verifications/P6/evidence/home.png', { plan: 'P6' }), true, 'the default root is akrs');
  assert.throws(() => check('x', { plan: 'P6', workflowRoot: '../x' }), TypeError);
});

test('Q30 verification and run validators thread workflowRoot to evidence paths', () => {
  const wfPassed = clone(passed);
  const move = (ref) => ({ ...ref, path: ref.path.replace('akrs/', 'wf/') });
  wfPassed.evidence = wfPassed.evidence.map(move);
  wfPassed.steps.forEach((entry) => { entry.evidence = entry.evidence.map(move); });
  assert.equal(validateRun(wfPassed, { form: 'stored', workflowRoot: 'wf' }).ok, true);
  expectIssue(validateRun(wfPassed, stored), 'invalid_value', '$.evidence[0].path');
  expectIssue(validateRun(passed, { form: 'stored', workflowRoot: 'wf' }), 'invalid_value', '$.evidence[0].path');
});

test('Q33 evidence path: payload screens and length caps apply to the one free string of the closed shape', () => {
  const base = 'akrs/verifications/P6/evidence/';
  const check = (path) => {
    const issues = [];
    validateEvidenceRef({ path, type: 'file', bytes: 1, sha256: `sha256:${'a'.repeat(64)}` }, '$.e', issues, { plan: 'P6' });
    return issues;
  };
  assert.equal(check(`${base}${'a'.repeat(251)}.png`).length, 0, 'a 255-character segment is fine');
  assert.equal(check(`${base}${'a'.repeat(252)}.png`).length > 0, true, '256 characters in one segment');
  assert.equal(check(`${base}${Array.from({ length: 5 }, () => 'b'.repeat(250)).join('/')}`).length > 0, true, 'over 1024 characters in total');
  const run = clone(passed);
  run.evidence[0].path = `${base}${'A'.repeat(600)}.png`;
  assert.equal(validateRun(run, stored).ok, false);
  const payload = check(`${base}${'QUJD'.repeat(200)}`);
  assert.equal(payload.some((entry) => entry.code === 'embedded_binary' || entry.path === '$.e.path'), true);
  assert.equal(check(`${base}data:image/png;base64,AAAA`).length > 0, true);
});

test('Q4 evidence lists collide case-folded', () => {
  const run = clone(passed);
  const ref = run.evidence[0];
  run.evidence = [{ ...ref, path: 'akrs/verifications/P6/evidence/HOME.png' }, { ...ref, path: 'akrs/verifications/P6/evidence/home.png' }];
  expectIssue(validateRun(run, stored), 'duplicate_value', '$.evidence[1].path');
});

test('F18 run record: the status agrees with the hard steps (passed => no failed hard step; failed => at least one)', () => {
  const failedHard = clone(passed);
  failedHard.steps[2].soft = false;
  expectIssue(validateRun(failedHard, stored), 'invalid_value', '$.status');
  failedHard.status = 'failed';
  assert.equal(validateRun(failedHard, stored).ok, true);
  const noFailure = clone(passed);
  noFailure.status = 'failed';
  expectIssue(validateRun(noFailure, stored), 'invalid_value', '$.status');
  const blocked = clone(passed);
  blocked.status = 'blocked';
  assert.equal(validateRun(blocked, stored).ok, true, 'a blocked run says nothing about its steps');
});

test('Q21 equals depth: the cap leaves room under the strict reader absolute depth 64, and the boundary round-trips', async () => {
  const { canonicalizeJson, parseStrictJson, storedSpec } = await import('../../lib/store/canonical/index.js');
  const { SCHEMA_REGISTRY } = await import('../../lib/schemas/index.js');
  const index = full.scenario.findIndex((entry) => entry.step === 'http' && entry.expect_json !== null);
  const nest = (levels) => {
    let value = 1;
    for (let level = 0; level < levels; level += 1) value = [value];
    return value;
  };
  const accepted = [];
  for (let levels = 1; levels <= 70; levels += 1) {
    const contract = setAt(clone(full), `scenario[${index}].expect_json.equals`, nest(levels));
    if (!validateVerification(contract, stored).ok) continue;
    accepted.push(levels);
    const text = canonicalizeJson(contract, storedSpec(SCHEMA_REGISTRY['akrs.verification/v1'].spec));
    assert.equal(parseStrictJson(text).ok, true, `depth ${levels} must round-trip`);
  }
  assert.equal(accepted.length > 0 && accepted.at(-1) >= 40, true, `accepted depths: ${accepted.at(-1)}`);
  assert.equal(accepted.length, accepted.at(-1), 'accepted depths are contiguous from 1');
  assert.equal(validateVerification(setAt(clone(full), `scenario[${index}].expect_json.equals`, nest(accepted.at(-1) + 1)), stored).ok, false);
});

test('Q33 equals strings: NUL is rejected', () => {
  const index = full.scenario.findIndex((entry) => entry.step === 'http' && entry.expect_json !== null);
  expectIssue(validateVerification(setAt(clone(full), `scenario[${index}].expect_json.equals`, 'a\u0000b'), stored),
    'embedded_binary', `$.scenario[${index}].expect_json.equals`);
  expectIssue(validateVerification(setAt(clone(full), `scenario[${index}].expect_json.equals`, { k: ['x\u0000'] }), stored),
    'embedded_binary', `$.scenario[${index}].expect_json.equals.k[0]`);
});

test('F4 sparse list inside the contract: argv and free-form equals', () => {
  const index = full.scenario.findIndex((entry) => entry.step === 'http' && entry.expect_json !== null);
  for (const path of ['launch.argv', 'setup[0].argv', `scenario[${index}].expect_json.equals`]) {
    const candidate = setAt(clone(full), path, new Array(2));
    let result;
    assert.doesNotThrow(() => { result = validateVerification(candidate, stored); });
    assert.equal(result.ok, false, path);
  }
});
