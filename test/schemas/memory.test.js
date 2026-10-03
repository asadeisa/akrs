import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MEMORY_INPUT_KEYS,
  MEMORY_INPUT_SCHEMA,
  MEMORY_LABELS,
  MEMORY_RECORD_KEYS,
  MEMORY_RECORD_SCHEMA,
  MEMORY_RECORD_SPEC,
  validateMemoryInput,
  validateMemoryRecord,
} from '../../lib/schemas/memory.js';
import {
  assertEnum,
  clone,
  defineClosedSchemaTests,
  expectIssue,
  loadFixtures,
  setAt,
} from './schema-harness.js';

const inputs = await loadFixtures('memory-input', 'valid');
const decided = inputs.find(({ name }) => name === 'decided').value;
const unknown = inputs.find(({ name }) => name === 'unknown').value;
const assumption = inputs.find(({ name }) => name === 'assumption-med').value;
const loadedRecord = (await loadFixtures('memory-record', 'valid')).find(({ name }) => name === 'decided').value;

test('F6 Memory: frozen labels and keys (Q18)', () => {
  assert.equal(MEMORY_INPUT_SCHEMA, 'akrs.memory-input/v1');
  assert.equal(MEMORY_RECORD_SCHEMA, 'akrs.memory-record/v1');
  assert.deepEqual(MEMORY_LABELS, ['Decided', 'Assumption High', 'Assumption Med', 'Assumption Low', 'Unknown']);
  assert.deepEqual(MEMORY_INPUT_KEYS, ['schema', 'topic', 'label', 'decided_by', 'owner_plan', 'text', 'pointers']);
  assert.deepEqual(MEMORY_RECORD_KEYS, ['id', 'label', 'decided_by', 'owner_plan', 'text', 'pointers']);
});

defineClosedSchemaTests({
  title: 'F6 Memory input',
  kind: 'memory-input',
  validate: (value) => validateMemoryInput(value),
  keys: MEMORY_INPUT_KEYS,
  primary: 'decided',
  closedPaths: ['', 'pointers[0]', 'pointers[1]'],
  atomicPaths: ['pointers[].lines'],
});

defineClosedSchemaTests({
  title: 'F6 Memory record',
  kind: 'memory-record',
  validate: (value) => validateMemoryRecord(value),
  keys: MEMORY_RECORD_KEYS,
  primary: 'decided',
  closedPaths: ['', 'pointers[0]', 'pointers[1]'],
  atomicPaths: ['pointers[].lines'],
});

test('F6 Memory: label enum is exact (no "Medium", no case variants)', () => {
  assertEnum((value) => validateMemoryInput(value), assumption, 'label', ['Assumption High', 'Assumption Med', 'Assumption Low']);
  for (const label of ['Assumption Medium', 'assumption med', 'DECIDED', 'Assumption', 'Decided (by P6)', 'Unknown ']) {
    expectIssue(validateMemoryInput(setAt(clone(decided), 'label', label)), 'invalid_value', '$.label');
  }
});

test('F6 Memory: label-dependent fields (Decided needs decided_by; Unknown needs an owner Plan and no pointers)', () => {
  expectIssue(validateMemoryInput(setAt(clone(decided), 'decided_by', null)), 'invalid_value', '$.decided_by');
  expectIssue(validateMemoryInput(setAt(clone(decided), 'pointers', [])), 'invalid_value', '$.pointers');
  expectIssue(validateMemoryInput(setAt(clone(assumption), 'decided_by', 'P6')), 'invalid_value', '$.decided_by');
  expectIssue(validateMemoryInput(setAt(clone(assumption), 'pointers', [])), 'invalid_value', '$.pointers');
  expectIssue(validateMemoryInput(setAt(clone(unknown), 'owner_plan', null)), 'invalid_value', '$.owner_plan');
  expectIssue(validateMemoryInput(setAt(clone(unknown), 'pointers', [{ path: 'SOT/a.md', lines: null }])), 'invalid_value', '$.pointers');
  expectIssue(validateMemoryInput(setAt(clone(decided), 'owner_plan', 'P6')), 'invalid_value', '$.owner_plan');
  expectIssue(validateMemoryInput(setAt(clone(unknown), 'decided_by', 'P6')), 'invalid_value', '$.decided_by');
});

test('F6 Memory: topic is an ID; text is non-empty and may hold any Unicode; pointers use path+lines', () => {
  expectIssue(validateMemoryInput(setAt(clone(decided), 'topic', 'ui/notes')), 'invalid_format', '$.topic');
  expectIssue(validateMemoryInput(setAt(clone(decided), 'text', '')), 'invalid_value', '$.text');
  expectIssue(validateMemoryInput(setAt(clone(decided), 'pointers[0].lines', [9, 3])), 'invalid_line_range', '$.pointers[0].lines');
  const unsafe = validateMemoryInput(setAt(clone(decided), 'pointers[0].path', '../x'));
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.issues.some((entry) => entry.path === '$.pointers[0].path'), true);
  assert.equal(validateMemoryInput(clone(assumption)).ok, true);
});

test('F4 Memory: the Markdown record spec is one table row per record with a Label column (Q18)', () => {
  assert.deepEqual(MEMORY_RECORD_SPEC.columns.map(({ key }) => key), ['label', 'decided_by', 'owner_plan', 'text', 'pointers']);
  assert.equal(MEMORY_RECORD_SPEC.columns[0].header, 'Label');
  assert.deepEqual(MEMORY_RECORD_SPEC.columns.map(({ kind }) => kind), ['text', 'json', 'json', 'text', 'json']);
});

test('F4 Memory: a stored record is LF-only (a Markdown cell cannot hold CR); the input form may carry CRLF', () => {
  assert.equal(validateMemoryInput(clone(assumption)).ok, true);
  assert.equal(assumption.text.includes('\r\n'), true);
  const record = { ...clone(loadedRecord), text: 'line one\r\nline two' };
  expectIssue(validateMemoryRecord(record), 'invalid_value', '$.text');
  assert.equal(validateMemoryRecord({ ...record, text: 'line one\nline two' }).ok, true);
});

test('Q4/F11 Memory pointers: a glob pointer carries no line window', () => {
  const candidate = setAt(clone(decided), 'pointers[0]', { path: 'src/*.ts', lines: [1, 2] });
  expectIssue(validateMemoryInput(candidate), 'invalid_value', '$.pointers[0].lines');
});
