import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ROAD_INPUT_KEYS,
  ROAD_KEYS,
  ROAD_SCHEMA,
  ROAD_STATUSES,
  ROAD_UPDATE_INPUT_KEYS,
  ROAD_WRITE_ACTIONS,
  ROAD_WRITE_CLASSES,
  TASK_INPUT_KEYS,
  TASK_SCHEMA,
  validateRoad,
  validateTaskInput,
} from '../../lib/schemas/road.js';
import {
  assertEnum,
  clone,
  defineClosedSchemaTests,
  deleteAt,
  describeIssues,
  expectIssue,
  loadFixtures,
  setAt,
} from './schema-harness.js';

const fixtures = await loadFixtures('road', 'valid');
const full = fixtures.find(({ name }) => name === 'full').value;
const stored = { form: 'stored' };

test('F6 Road: frozen constants', () => {
  assert.equal(ROAD_SCHEMA, 'akrs.road/v1');
  assert.deepEqual(ROAD_KEYS, [
    'schema', 'id', 'plan', 'task', 'status', 'deps', 'reads', 'writes', 'forbidden', 'checks',
    'acceptance', 'boundaries', 'on_landing', 'complexity', 'executor_class', 'steps',
    'scope_policy', 'oversize_reason', 'meta',
  ]);
  assert.deepEqual(ROAD_INPUT_KEYS, ROAD_KEYS.filter((key) => key !== 'status' && key !== 'meta'));
  assert.deepEqual(ROAD_UPDATE_INPUT_KEYS, ROAD_KEYS.filter((key) => key !== 'meta'));
  assert.deepEqual(ROAD_STATUSES, ['QUEUED', 'ACTIVE', 'DONE']);
  assert.deepEqual(ROAD_WRITE_ACTIONS, ['create', 'modify', 'delete']);
  assert.deepEqual(ROAD_WRITE_CLASSES, ['file', 'dir', 'glob', 'ephemeral']);
});

defineClosedSchemaTests({
  title: 'F6 Road (stored form)',
  kind: 'road',
  validate: validateRoad,
  options: stored,
  keys: ROAD_KEYS,
  primary: 'full',
  closedPaths: [
    '', 'reads[0]', 'reads[1]', 'reads[2]', 'writes[0]', 'writes[1]', 'writes[2]', 'writes[3]',
    'checks[0]', 'checks[1]', 'scope_policy', 'meta',
  ],
  atomicPaths: ['reads[].lines', 'checks[].argv'],
});

test('F6 Road: input forms differ from the stored form only by CLI-owned keys (Q1, Q7)', () => {
  const input = clone(full);
  delete input.meta;
  delete input.status;
  assert.equal(validateRoad(input, { form: 'input' }).ok, true);
  assert.equal(validateRoad(input, stored).ok, false, 'stored form requires status and meta');

  const withStatus = { ...clone(input), status: 'ACTIVE' };
  expectIssue(validateRoad(withStatus, { form: 'input' }), 'unknown_key', '$.status');
  assert.equal(validateRoad(withStatus, { form: 'update' }).ok, true);
  expectIssue(validateRoad(input, { form: 'update' }), 'missing_key', '$.status');

  const withMeta = { ...clone(input), meta: full.meta };
  expectIssue(validateRoad(withMeta, { form: 'input' }), 'unknown_key', '$.meta');
});

test('F6 Road: unknown form names are a programming error', () => {
  assert.throws(() => validateRoad(full, { form: 'other' }), TypeError);
});

test('F6 Road: enums reject wrong case and padding', () => {
  assertEnum(validateRoad, full, 'status', ROAD_STATUSES, stored);
  assertEnum(validateRoad, full, 'writes[1].action', ROAD_WRITE_ACTIONS, stored);
  assertEnum(validateRoad, full, 'executor_class', ['weak', 'medium', 'frontier'], stored);
});

test('F6 Road: ID grammar (Q8) applies to id, plan, task, deps', () => {
  const bad = ['', '1abc', 'R 1', 'R_1', 'R--1', '-R1', 'R1-', 'R/1', 'R\n1', 'a'.repeat(65), 'é1', 'R1.', 'R..1'];
  for (const value of bad) {
    for (const path of ['id', 'plan', 'task', 'deps[0]']) {
      const candidate = setAt(clone(full), path, value);
      const result = validateRoad(candidate, stored);
      assert.equal(result.ok, false, `${path}=${JSON.stringify(value)}`);
      assert.equal(result.issues.some((entry) => entry.path === `$.${path}`.replace('.deps[0]', '.deps[0]')), true,
        `${path}=${JSON.stringify(value)}: ${describeIssues(result)}`);
    }
  }
  for (const value of ['R1', 'R-P6-1', 'P6', 'r.1', 'A'.repeat(64), 'T-P6-1']) {
    const candidate = setAt(setAt(setAt(clone(full), 'id', value), 'plan', null), 'task', null);
    assert.equal(validateRoad(candidate, stored).ok, true, value);
  }
});

test('F6 Road: Plan and Road IDs share one namespace; a Road cannot be its own Plan or dependency', () => {
  expectIssue(validateRoad(setAt(clone(full), 'plan', 'R-P6-1'), stored), 'invalid_value', '$.plan');
  expectIssue(validateRoad(setAt(clone(full), 'deps', ['R-P6-1']), stored), 'invalid_value', '$.deps[0]');
  expectIssue(validateRoad(setAt(clone(full), 'task', 'R-P6-1'), stored), 'invalid_value', '$.task');
});

test('F6 Road: set arrays are unique, and sorted in the stored form only (Q6)', () => {
  const unsorted = setAt(clone(full), 'deps', ['R-B', 'R-A']);
  expectIssue(validateRoad(unsorted, stored), 'invalid_order', '$.deps');
  const input = clone(unsorted);
  delete input.meta;
  delete input.status;
  assert.equal(validateRoad(input, { form: 'input' }).ok, true, 'input form accepts any order');
  expectIssue(validateRoad(setAt(clone(input), 'deps', ['R-A', 'R-A']), { form: 'input' }), 'duplicate_value', '$.deps[1]');
  expectIssue(validateRoad(setAt(clone(full), 'forbidden', ['b/**', 'a/**']), stored), 'invalid_order', '$.forbidden');
  const writes = clone(full);
  writes.writes.reverse();
  expectIssue(validateRoad(writes, stored), 'invalid_order', '$.writes');
  const duplicate = clone(full);
  duplicate.writes = [duplicate.writes[0], { ...duplicate.writes[0] }];
  expectIssue(validateRoad(duplicate, stored), 'duplicate_value', '$.writes[1].path');
});

test('F6 Road: ordered arrays keep authored order and may repeat nothing the schema forbids', () => {
  const reordered = clone(full);
  reordered.reads.reverse();
  reordered.acceptance = ['second', 'first'];
  reordered.checks.reverse();
  assert.equal(validateRoad(reordered, stored).ok, true, 'authored order is not an error');
  const duplicateCheck = clone(full);
  duplicateCheck.checks[1].name = duplicateCheck.checks[0].name;
  expectIssue(validateRoad(duplicateCheck, stored), 'duplicate_value', '$.checks[1].name');
  const duplicateRead = clone(full);
  duplicateRead.reads[1] = { ...duplicateRead.reads[0] };
  expectIssue(validateRoad(duplicateRead, stored), 'duplicate_value', '$.reads[1]');
  const sameFileOtherWindow = clone(full);
  sameFileOtherWindow.reads[1] = { ...sameFileOtherWindow.reads[0], lines: [50, 60] };
  assert.equal(validateRoad(sameFileOtherWindow, stored).ok, true);
});

test('F6 Road: read line ranges are null or an inclusive 1-based [start,end] (Q9)', () => {
  for (const lines of [null, [1, 1], [28, 41], [3, 3], [1, 100000]]) {
    assert.equal(validateRoad(setAt(clone(full), 'reads[0].lines', lines), stored).ok, true, JSON.stringify(lines));
  }
  for (const lines of [[0, 3], [5, 3], [1], [1, 2, 3], [1.5, 2], ['1', '3'], '1-3', [], {}, [-1, 4], [1, null]]) {
    const result = validateRoad(setAt(clone(full), 'reads[0].lines', lines), stored);
    assert.equal(result.ok, false, JSON.stringify(lines));
    assert.equal(result.issues.some((entry) => entry.path.startsWith('$.reads[0].lines')), true, describeIssues(result));
  }
  assert.equal(validateRoad(setAt(clone(full), 'reads[0].why', ''), stored).ok, false, 'why is null or non-empty');
});

test('F11 Road: read, write, forbidden and envelope paths use the shared path rules', () => {
  const unsafe = ['/abs/x', 'C:/x', 'C:x', '//server/share/x', '../x', 'a/../b', 'a/./b', 'a\\b', 'a\0b', 'a:b', 'a::$DATA', 'a//b', 'a/', ''];
  for (const value of unsafe) {
    for (const path of ['reads[0].path', 'writes[1].path', 'forbidden[0]', 'on_landing', 'scope_policy.auto_reads[0]']) {
      const candidate = setAt(clone(full), path, value);
      if (path === 'scope_policy.auto_reads[0]') candidate.scope_policy.auto_reads = [value];
      const result = validateRoad(candidate, stored);
      assert.equal(result.ok, false, `${path}=${JSON.stringify(value)}`);
    }
  }
  assert.equal(validateRoad(setAt(clone(full), 'reads[0].path', 'src/*.ts'), stored).ok, false, 'reads are literal paths');
});

test('F11 Road: a write path must agree with its declared class (ambiguous values fail)', () => {
  const bad = [
    ['file', 'app/*.vue'], ['file', 'app/**'], ['dir', 'app/**'], ['ephemeral', 'tmp/*.md'],
    ['glob', 'app/pages/admin.vue'], ['dir', 'app/components/'], ['file', 'app/'], ['directory', 'app'],
  ];
  for (const [writeClass, path] of bad) {
    const candidate = clone(full);
    candidate.writes = [{ path, class: writeClass, action: 'create' }];
    const result = validateRoad(candidate, stored);
    assert.equal(result.ok, false, `${writeClass} ${path}`);
    assert.equal(result.issues.some((entry) => entry.path.startsWith('$.writes[0]')), true, describeIssues(result));
  }
  for (const [writeClass, path] of [['file', 'a.txt'], ['dir', 'src/lib'], ['glob', 'src/**/*.ts'], ['ephemeral', 'akrs/handoffs/x.md']]) {
    const candidate = clone(full);
    candidate.writes = [{ path, class: writeClass, action: 'modify' }];
    assert.equal(validateRoad(candidate, stored).ok, true, `${writeClass} ${path}`);
  }
});

test('F6 Road: complexity is an advisory integer 0..10 or null', () => {
  for (const value of [null, 0, 1, 10]) assert.equal(validateRoad(setAt(clone(full), 'complexity', value), stored).ok, true, String(value));
  for (const value of [-1, 11, 2.5, '3', true]) assert.equal(validateRoad(setAt(clone(full), 'complexity', value), stored).ok, false, String(value));
});

test('F6 Road: checks are argv arrays with bounded timeouts, never shell strings', () => {
  for (const argv of [[], 'npm test', [''], ['npm', 7], ['a\0b'], [['npm']]]) {
    const result = validateRoad(setAt(clone(full), 'checks[0].argv', argv), stored);
    assert.equal(result.ok, false, JSON.stringify(argv));
    assert.equal(result.issues.some((entry) => entry.path.startsWith('$.checks[0].argv')), true, describeIssues(result));
  }
  for (const timeout of [0, -1, 3600001, 1.5, '5', null]) {
    assert.equal(validateRoad(setAt(clone(full), 'checks[0].timeout_ms', timeout), stored).ok, false, String(timeout));
  }
  for (const timeout of [1, 120000, 3600000]) {
    assert.equal(validateRoad(setAt(clone(full), 'checks[0].timeout_ms', timeout), stored).ok, true, String(timeout));
  }
});

test('Q12 Road: scope_policy rejects anything not provably disjoint from akrs/** or SOT/**', () => {
  const rejected = ['akrs/**', 'SOT/**', '**', '**/*.md', '*/**', 'akrs/drafts/*', 'SOT/a.md', 'akrs/x.json', 'AKRS/**', 'sot/notes.md', '*'];
  for (const key of ['auto_writes', 'auto_reads']) {
    for (const entry of rejected) {
      const candidate = clone(full);
      candidate.scope_policy = { auto_reads: [], auto_writes: [] };
      candidate.scope_policy[key] = [entry];
      expectIssue(validateRoad(candidate, stored), 'invalid_envelope', `$.scope_policy.${key}[0]`);
    }
    for (const entry of ['app/**', 'src/*.ts', 'docs/readme.md', 'akrsx/**', 'lib']) {
      const candidate = clone(full);
      candidate.scope_policy = { auto_reads: [], auto_writes: [] };
      candidate.scope_policy[key] = [entry];
      assert.equal(validateRoad(candidate, stored).ok, true, `${key} ${entry}`);
    }
  }
  const extraKey = clone(full);
  extraKey.scope_policy.forbidden = [];
  expectIssue(validateRoad(extraKey, stored), 'unknown_key', '$.scope_policy.forbidden');
});

test('F6 Road: Task prose can never become an executable field', () => {
  for (const key of ['approach', 'objective', 'constraints', 'notes', 'task_text', 'description']) {
    const candidate = clone(full);
    candidate[key] = 'Build the page, then wire the router.';
    expectIssue(validateRoad(candidate, stored), 'unknown_key', `$.${key}`);
  }
  const candidate = clone(full);
  candidate.task = '# Task\n\nImplement the page.';
  expectIssue(validateRoad(candidate, stored), 'invalid_format', '$.task');
});

test('F6 Road: meta is closed and shape-checked, but a wrong hash is "unverified", not invalid', () => {
  expectIssue(validateRoad(setAt(clone(full), 'meta.generator', 'something'), stored), 'invalid_format', '$.meta.generator');
  expectIssue(validateRoad(setAt(clone(full), 'meta.content_hash', 'sha256:xyz'), stored), 'invalid_format', '$.meta.content_hash');
  const wrongButWellFormed = setAt(clone(full), 'meta.content_hash', `sha256:${'0'.repeat(64)}`);
  assert.equal(validateRoad(wrongButWellFormed, stored).ok, true);
  deleteAt(wrongButWellFormed, 'meta');
  assert.equal(validateRoad(wrongButWellFormed, stored).ok, false);
});

test('F6 Road: schema value is pinned', () => {
  expectIssue(validateRoad(setAt(clone(full), 'schema', 'akrs.road/v2'), stored), 'invalid_value', '$.schema');
});

// ---- Task (input form; Markdown is rendered by the Task writer)
const task = (await loadFixtures('task', 'valid'))[0].value;

test('F6 Task: frozen scaffold input keys (Q31)', () => {
  assert.equal(TASK_SCHEMA, 'akrs.task/v1');
  assert.deepEqual(TASK_INPUT_KEYS, ['schema', 'id', 'plan', 'road', 'objective', 'constraints', 'approach', 'notes']);
  assert.equal(validateTaskInput(clone(task)).ok, true);
});

defineClosedSchemaTests({
  title: 'F6 Task input',
  kind: 'task',
  validate: (value) => validateTaskInput(value),
  keys: ['schema', 'id', 'plan', 'road', 'objective', 'constraints', 'approach', 'notes'],
  primary: 'full',
  closedPaths: [''],
});

test('F6 Task: narrative stays narrative; identity fields are IDs', () => {
  expectIssue(validateTaskInput(setAt(clone(task), 'road', 'not an id')), 'invalid_format', '$.road');
  expectIssue(validateTaskInput(setAt(clone(task), 'objective', '')), 'invalid_value', '$.objective');
  expectIssue(validateTaskInput({ ...clone(task), writes: [] }), 'unknown_key', '$.writes');
  expectIssue(validateTaskInput({ ...clone(task), acceptance: ['x'] }), 'unknown_key', '$.acceptance');
});

test('F4 Road: anything the validator accepts, the canonical writer can encode (no lone surrogates)', () => {
  expectIssue(validateRoad(setAt(clone(full), 'checks[0].argv[0]', '\ud800'), stored), 'invalid_argv', '$.checks[0].argv[0]');
  expectIssue(validateRoad(setAt(clone(full), 'acceptance[0]', 'half \udc00 pair'), stored), 'invalid_value', '$.acceptance[0]');
  expectIssue(validateRoad(setAt(clone(full), 'reads[0].why', '\ud83d'), stored), 'invalid_value', '$.reads[0].why');
});

test('Q30 Road: the envelope exclusion follows the discovered workflow root (SOT/** stays fixed)', () => {
  const withEnvelope = (key, entry) => ({ ...clone(full), scope_policy: { auto_reads: [], auto_writes: [], [key]: [entry] } });
  const wf = { form: 'stored', workflowRoot: 'wf' };
  for (const key of ['auto_reads', 'auto_writes']) {
    for (const entry of ['wf/**', 'wf/drafts/*', 'wf/x.json', 'WF/**', '**', 'SOT/**']) {
      expectIssue(validateRoad(withEnvelope(key, entry), wf), 'invalid_envelope', `$.scope_policy.${key}[0]`);
    }
    // the default root name is just another directory when the workflow root is `wf`
    for (const entry of ['akrs/**', 'akrs/x.json', 'app/**', 'wfx/**']) {
      assert.equal(validateRoad(withEnvelope(key, entry), wf).ok, true, `${key} ${entry}`);
    }
    // and the default root is protected only when it is the root
    expectIssue(validateRoad(withEnvelope(key, 'akrs/**'), stored), 'invalid_envelope', `$.scope_policy.${key}[0]`);
    expectIssue(validateRoad(withEnvelope(key, 'akrs/**'), { form: 'stored', workflowRoot: 'akrs' }), 'invalid_envelope', `$.scope_policy.${key}[0]`);
  }
  const nested = { form: 'stored', workflowRoot: 'tools/wf' };
  expectIssue(validateRoad(withEnvelope('auto_writes', 'tools/wf/roads/*'), nested), 'invalid_envelope', '$.scope_policy.auto_writes[0]');
  assert.equal(validateRoad(withEnvelope('auto_writes', 'tools/other/*'), nested).ok, true);
});

test('Q30 Road: workflowRoot must be a normalized workflow-relative literal root (a programming error otherwise)', () => {
  for (const workflowRoot of ['', '/abs', '../x', 'a/../b', 'a/', 'a\\b', 'wf/**', 'wf?', 'C:/x', 7, null, {}]) {
    assert.throws(() => validateRoad(clone(full), { form: 'stored', workflowRoot }), TypeError, JSON.stringify(workflowRoot));
  }
  assert.equal(validateRoad(clone(full), { form: 'stored', workflowRoot: undefined }).ok, true);
  assert.equal(validateRoad(clone(full), { form: 'stored', workflowRoot: 'akrs' }).ok, true);
});

test('Q4 Road: path sets and ID sets collide case-folded (and under non-1:1 folds)', () => {
  const cases = [
    ['forbidden', ['A/b', 'a/b'], '$.forbidden[1]'],
    ['forbidden', ['stra\u00dfe/x', 'STRASSE/x'], '$.forbidden[1]'],
    ['deps', ['R-A', 'r-a'], '$.deps[1]'],
  ];
  for (const [key, list, path] of cases) {
    const input = setAt(clone(full), key, list);
    delete input.meta;
    delete input.status;
    expectIssue(validateRoad(input, { form: 'input' }), 'duplicate_value', path);
  }
  for (const key of ['auto_reads', 'auto_writes']) {
    const input = clone(full);
    input.scope_policy = { auto_reads: [], auto_writes: [], [key]: ['SRC/**', 'src/**'] };
    delete input.meta;
    delete input.status;
    expectIssue(validateRoad(input, { form: 'input' }), 'duplicate_value', `$.scope_policy.${key}[1]`);
  }
  const writes = clone(full);
  writes.writes = [{ path: 'A.js', class: 'file', action: 'create' }, { path: 'a.js', class: 'file', action: 'modify' }];
  expectIssue(validateRoad(writes, stored), 'duplicate_value', '$.writes[1].path');
});

test('Q4/F11 Road: a line window needs a literal file path; a glob read carries lines: null', () => {
  const globRead = setAt(clone(full), 'reads[0]', { path: 'src/*.ts', lines: [1, 5], why: null });
  expectIssue(validateRoad(globRead, stored), 'invalid_value', '$.reads[0].lines');
  expectIssue(validateRoad(globRead, stored), 'class_mismatch', '$.reads[0].path');
});

test('F4 sparse arrays are rejected by every list check and never crash a validator', () => {
  const holes = () => new Array(2);
  for (const path of ['deps', 'reads', 'writes', 'forbidden', 'checks', 'checks[0].argv', 'acceptance', 'boundaries', 'steps',
    'scope_policy.auto_reads', 'scope_policy.auto_writes', 'reads[0].lines']) {
    const candidate = setAt(clone(full), path, holes());
    let result;
    assert.doesNotThrow(() => { result = validateRoad(candidate, stored); }, path);
    assert.equal(result.ok, false, path);
    assert.equal(result.issues.some((entry) => entry.path.startsWith(`$.${path}`)), true, `${path}: ${describeIssues(result)}`);
  }
});
