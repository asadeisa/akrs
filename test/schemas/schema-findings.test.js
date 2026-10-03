import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCliAdapter } from '../../bin/cli-adapter.js';
import { commandHandlers, commandManifest } from '../../lib/core/index.js';
import {
  FINDING_CODE_FAMILIES,
  FINDING_FAMILY_DESCRIPTIONS,
  findingCatalog,
  getFindingDefinition,
  validateFindingCatalog,
} from '../../lib/findings/catalog.js';
import { validateFinding } from '../../lib/schemas/finding.js';
import {
  SCHEMA_REGISTRY,
  SCHEMA_VIOLATION_CODES,
  findingsForSchemaIssues,
  validateArtifact,
} from '../../lib/schemas/index.js';
import { clone, loadFixtures, setAt } from './schema-harness.js';

const providers = {
  now: () => '2026-08-25T10:30:00.000Z',
  runId: () => '01ARZ3NDEKTSV4RRFFQ69G5FAV',
};

const EXPECTED_CODES = {
  road: 'AKRS-R011',
  memory: 'AKRS-M001',
  state: 'AKRS-S001',
  tester: 'AKRS-T001',
  input: 'AKRS-C008',
};

test('Q24 catalog: one permanent schema-violation code per family; families and regex are unchanged', () => {
  assert.deepEqual(SCHEMA_VIOLATION_CODES, EXPECTED_CODES);
  assert.deepEqual(FINDING_CODE_FAMILIES, { R: 'road', M: 'memory', S: 'state', G: 'git', C: 'command', T: 'tester' });
  assert.equal(validateFindingCatalog(findingCatalog).ok, true);
  for (const code of Object.values(EXPECTED_CODES)) {
    const definition = getFindingDefinition(code);
    assert.notEqual(definition, null, code);
    assert.equal(definition.severity, 'error', code);
    assert.deepEqual(definition.data_schema.required, ['schema', 'pointer', 'issue'], code);
    assert.equal(definition.remediation.length > 20, true, code);
  }
});

test('Q25 catalog: the S family description covers state and the control plane', () => {
  assert.match(FINDING_FAMILY_DESCRIPTIONS.S, /state/);
  assert.match(FINDING_FAMILY_DESCRIPTIONS.S, /control plane/);
  assert.match(FINDING_FAMILY_DESCRIPTIONS.S, /executor/);
  assert.deepEqual(Object.keys(FINDING_FAMILY_DESCRIPTIONS), Object.keys(FINDING_CODE_FAMILIES));
});

test('Q24 explain works for every new schema-violation code', async () => {
  for (const code of Object.values(EXPECTED_CODES)) {
    const result = await runCliAdapter({
      argv: ['explain', code, '--json'],
      cwd: 'E:/project',
      manifest: commandManifest,
      handlers: commandHandlers,
      providers,
    });
    assert.equal(result.exitCode, 0, code);
    assert.deepEqual(JSON.parse(result.stdout).data.finding, getFindingDefinition(code));
  }
});

test('Q24 schema issues become findings with RFC 6901 pointers while validators keep $.a[0].b paths', async () => {
  const road = clone((await loadFixtures('road', 'valid')).find(({ name }) => name === 'full').value);
  const bad = setAt(setAt(road, 'status', 'queued'), 'reads[0].lines', [9, 1]);
  const result = validateArtifact('akrs.road/v1', bad, { form: 'stored' });
  assert.equal(result.ok, false);
  assert.equal(result.issues.every(({ path }) => path.startsWith('$')), true);
  const findings = findingsForSchemaIssues('akrs.road/v1', result.issues, { file: 'akrs/roads/R-P6-1.json' });
  assert.equal(findings.length, result.issues.length);
  for (const finding of findings) {
    assert.equal(validateFinding(finding).ok, true);
    assert.equal(finding.code, 'AKRS-R011');
    assert.equal(finding.severity, 'error');
    assert.equal(finding.file, 'akrs/roads/R-P6-1.json');
    assert.deepEqual(Object.keys(finding.detail).sort(), ['issue', 'pointer', 'schema']);
    assert.equal(finding.detail.schema, 'akrs.road/v1');
    assert.equal(finding.detail.pointer === '' || finding.detail.pointer.startsWith('/'), true);
  }
  assert.deepEqual(findings.map(({ detail }) => detail.pointer).sort(), ['/reads/0/lines', '/status']);
  const sorted = [...findings].map(({ detail }) => `${detail.pointer}:${detail.issue}`);
  assert.deepEqual(sorted, [...sorted].sort(), 'findings are emitted in a deterministic order');
});

test('Q24 every artifact family maps to its code', () => {
  const byKind = {
    'akrs.road/v1': 'AKRS-R011', 'akrs.task/v1': 'AKRS-R011', 'akrs.scope-request/v1': 'AKRS-R011',
    'akrs.scope-resolution/v1': 'AKRS-R011', 'akrs.memory-input/v1': 'AKRS-M001', 'akrs.memory-record/v1': 'AKRS-M001',
    'akrs.state/v1': 'AKRS-S001', 'akrs.executors/v1': 'AKRS-S001', 'akrs.plan/v1': 'AKRS-S001',
    'akrs.closure/v1': 'AKRS-S001', 'akrs.verification/v1': 'AKRS-T001', 'akrs.handoff/v1': 'AKRS-T001',
    'akrs.result/v1': 'AKRS-T001', 'akrs.run/v1': 'AKRS-T001',
  };
  assert.deepEqual(Object.keys(byKind).sort(), Object.keys(SCHEMA_REGISTRY).sort());
  for (const [schema, code] of Object.entries(byKind)) {
    const [finding] = findingsForSchemaIssues(schema, [{ path: '$.x', code: 'invalid_value', message: 'bad' }], { file: null });
    assert.equal(finding.code, code, schema);
    assert.equal(finding.file, null);
  }
  assert.throws(() => findingsForSchemaIssues('akrs.unknown/v1', [], { file: null }), TypeError);
});

test('Q24 hostile keys: unknown keys with empty, dotted, bracketed or non-ASCII names still produce RFC 6901 pointers', async () => {
  const road = clone((await loadFixtures('road', 'valid')).find(({ name }) => name === 'full').value);
  const cases = [
    ['', '/'], ['a.b', '/a.b'], ['x[0]', '/x[0]'], ['a/b', '/a~1b'], ['a~b', '/a~0b'], ['مفتاح 🚀', '/مفتاح 🚀'], ['$', '/$'], ['a"b', '/a"b'],
  ];
  const targets = [
    ['', (key, value) => ({ ...value, [key]: 1 })],
    ['/reads/0', (key, value) => { value.reads[0][key] = 1; return value; }],
    ['/scope_policy', (key, value) => { value.scope_policy[key] = []; return value; }],
    ['/checks/1', (key, value) => { value.checks[1][key] = 1; return value; }],
  ];
  for (const [prefix, mutate] of targets) {
    for (const [key, token] of cases) {
      const result = validateArtifact('akrs.road/v1', mutate(key, clone(road)), { form: 'stored' });
      const unknown = result.issues.filter((entry) => entry.code === 'unknown_key');
      assert.equal(unknown.length, 1, `${prefix} ${JSON.stringify(key)}: ${JSON.stringify(result.issues)}`);
      const findings = findingsForSchemaIssues('akrs.road/v1', result.issues, { file: null });
      const pointers = findings.map(({ detail }) => detail.pointer);
      const expected = prefix === '' && token === '/' ? '/' : `${prefix}${token}`;
      assert.equal(pointers.includes(expected), true, `${prefix} ${JSON.stringify(key)}: expected ${expected} in ${JSON.stringify(pointers)}`);
      for (const finding of findings) assert.equal(validateFinding(finding).ok, true);
    }
  }
});

test('Q24 hostile keys: other families report them too (state, plan, verification scenario step)', async () => {
  const state = clone((await loadFixtures('state', 'valid')).find(({ name }) => name === 'full').value);
  const stateResult = validateArtifact('akrs.state/v1', { ...state, 'a.b': 1, '': 2 }, { form: 'stored' });
  const statePointers = findingsForSchemaIssues('akrs.state/v1', stateResult.issues, { file: null }).map(({ detail }) => detail.pointer);
  assert.deepEqual(statePointers.sort(), ['/', '/a.b']);
  const contract = clone((await loadFixtures('verification', 'valid')).find(({ name }) => name === 'full').value);
  contract.scenario[0]['x[0]'] = true;
  const contractResult = validateArtifact('akrs.verification/v1', contract, { form: 'stored' });
  const contractPointers = findingsForSchemaIssues('akrs.verification/v1', contractResult.issues, { file: null }).map(({ detail }) => detail.pointer);
  assert.deepEqual(contractPointers, ['/scenario/0/x[0]']);
});

test('Q24 hostile keys inside free-form JSON (expect_json.equals) keep unambiguous pointers', async () => {
  const contract = clone((await loadFixtures('verification', 'valid')).find(({ name }) => name === 'full').value);
  const index = contract.scenario.findIndex((entry) => entry.step === 'http' && entry.expect_json !== null);
  contract.scenario[index].expect_json.equals = { fine: { '7': 1, 'a.b': [1.5] } };
  const result = validateArtifact('akrs.verification/v1', contract, { form: 'stored' });
  const pointers = findingsForSchemaIssues('akrs.verification/v1', result.issues, { file: null }).map(({ detail }) => detail.pointer).sort();
  assert.deepEqual(pointers, [
    `/scenario/${index}/expect_json/equals/fine/7`,
    `/scenario/${index}/expect_json/equals/fine/a.b/0`,
  ]);
});

test('NIT 11 an input form that does not exist for the kind is a programming error', () => {
  assert.throws(() => validateArtifact('akrs.closure/v1', {}, { form: 'input' }), TypeError);
});
