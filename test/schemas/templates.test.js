import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCHEMA_REGISTRY } from '../../lib/schemas/index.js';
import { TEMPLATE_KINDS, TEMPLATE_SCHEMAS, buildTemplate, findMissingInputs } from '../../lib/schemas/templates.js';
import { clone, loadFixtures } from './schema-harness.js';

const EXPECTED_MISSING = {
  road: ['/acceptance/0', '/id'],
  task: ['/id', '/objective', '/road'],
  verification: ['/plan', '/policy', '/roads/0'],
  memory: ['/label', '/text', '/topic'],
  scope: ['/add_reads/0', '/blocking', '/reason', '/road'],
  handoff: ['/expect', '/reach/0', '/result', '/road'],
  result: ['/user_acceptance/answer', '/user_acceptance/because', '/verdict'],
};

test('F16 templates: exactly seven kinds in the frozen order (A1 §4)', () => {
  assert.deepEqual(TEMPLATE_KINDS, ['road', 'task', 'verification', 'memory', 'scope', 'handoff', 'result']);
  assert.deepEqual(TEMPLATE_SCHEMAS, {
    road: 'akrs.road/v1',
    task: 'akrs.task/v1',
    verification: 'akrs.verification/v1',
    memory: 'akrs.memory-input/v1',
    scope: 'akrs.scope-request/v1',
    handoff: 'akrs.handoff/v1',
    result: 'akrs.result/v1',
  });
  for (const schema of Object.values(TEMPLATE_SCHEMAS)) assert.equal(Object.hasOwn(SCHEMA_REGISTRY, schema), true, schema);
});

test('F16 templates: unknown kinds and unknown classes are programming errors', () => {
  for (const kind of ['plan', 'state', 'ROAD', '', undefined]) assert.throws(() => buildTemplate(kind), TypeError, String(kind));
  assert.throws(() => buildTemplate('road', { class: 'strong' }), TypeError);
});

test('Q27 templates: skeletons do not validate until filled, and the finding names the exact missing input', () => {
  for (const kind of TEMPLATE_KINDS) {
    const template = buildTemplate(kind);
    assert.equal(template.kind, kind);
    assert.equal(template.schema, TEMPLATE_SCHEMAS[kind]);
    assert.equal(template.skeleton.schema, TEMPLATE_SCHEMAS[kind]);
    const missing = findMissingInputs(kind, template.skeleton);
    assert.deepEqual(missing.map(({ pointer }) => pointer), EXPECTED_MISSING[kind], kind);
    for (const entry of missing) {
      assert.equal(typeof entry.message, 'string');
      assert.equal(entry.message.length > 0, true);
    }
  }
});

test('Q27 templates: a skeleton is a fresh object each time and is closed to the input form', () => {
  const first = buildTemplate('road');
  first.skeleton.id = 'mutated';
  assert.equal(buildTemplate('road').skeleton.id, null);
  const { inputKeys } = SCHEMA_REGISTRY[TEMPLATE_SCHEMAS.road];
  assert.deepEqual(Object.keys(buildTemplate('road').skeleton), inputKeys);
  for (const kind of TEMPLATE_KINDS) {
    const entry = SCHEMA_REGISTRY[TEMPLATE_SCHEMAS[kind]];
    assert.deepEqual(Object.keys(buildTemplate(kind).skeleton), entry.inputKeys, kind);
  }
});

test('F15 templates: the class option shapes the Road skeleton (weak Roads need steps)', () => {
  const weak = buildTemplate('road', { class: 'weak' });
  assert.equal(weak.skeleton.executor_class, 'weak');
  assert.deepEqual(findMissingInputs('road', weak.skeleton).map(({ pointer }) => pointer),
    ['/acceptance/0', '/id'], 'weak-class steps are class fit (a later packet), not a schema requirement');
  const frontier = buildTemplate('road', { class: 'frontier' });
  assert.equal(frontier.skeleton.executor_class, 'frontier');
  assert.deepEqual(frontier.skeleton.steps, []);
  assert.equal(buildTemplate('road').skeleton.executor_class, null);
});

test('F16 templates: every input key has a field-guide entry', () => {
  for (const kind of TEMPLATE_KINDS) {
    const template = buildTemplate(kind);
    const guided = new Set(template.guide.map(({ pointer }) => pointer));
    for (const key of Object.keys(template.skeleton)) {
      assert.equal(guided.has(`/${key}`), true, `${kind} guide lacks /${key}`);
    }
    for (const entry of template.guide) {
      assert.equal(typeof entry.description, 'string');
      assert.equal(entry.description.length > 0, true);
      assert.equal(entry.pointer.startsWith('/'), true);
    }
  }
});

test('Q27 templates: filling the missing inputs makes the skeleton valid (road, memory, scope)', () => {
  const road = buildTemplate('road').skeleton;
  road.id = 'R-NEW-1';
  road.acceptance[0] = 'README.md mentions the example.';
  assert.deepEqual(findMissingInputs('road', road), []);

  const memory = buildTemplate('memory').skeleton;
  Object.assign(memory, { topic: 'ui', label: 'Unknown', owner_plan: 'P6', text: 'Open question.' });
  assert.deepEqual(findMissingInputs('memory', memory), []);

  const scope = buildTemplate('scope').skeleton;
  Object.assign(scope, { road: 'R1', reason: 'Need the flag file.', blocking: true });
  scope.add_reads[0] = { path: 'app/flag.ts', lines: null, why: null };
  assert.deepEqual(findMissingInputs('scope', scope), []);
});

test('F16 templates: valid agent-authored fixtures report no missing inputs', async () => {
  const road = (await loadFixtures('road', 'valid')).find(({ name }) => name === 'full').value;
  const input = clone(road);
  delete input.status;
  delete input.meta;
  assert.deepEqual(findMissingInputs('road', input), []);
  const task = (await loadFixtures('task', 'valid'))[0].value;
  assert.deepEqual(findMissingInputs('task', clone(task)), []);
});
