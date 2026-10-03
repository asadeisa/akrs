import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ARTIFACT_KINDS,
  ORDERING_TABLE,
  SCHEMA_REGISTRY,
  validateArtifact,
} from '../../lib/schemas/index.js';
import {
  canonicalizeJson,
  decodeJsonl,
  encodeJsonlRecord,
  parseMarkdownRecords,
  parseStrictJson,
  renderMarkdownHeader,
  renderMarkdownRecord,
  storedSpec,
  verifyMeta,
  withMeta,
} from '../../lib/store/canonical/index.js';
import { clone, describeIssues, loadFixtures } from './schema-harness.js';

const SCHEMAS = {
  road: 'akrs.road/v1',
  task: 'akrs.task/v1',
  state: 'akrs.state/v1',
  'memory-input': 'akrs.memory-input/v1',
  'memory-record': 'akrs.memory-record/v1',
  closure: 'akrs.closure/v1',
  'scope-request': 'akrs.scope-request/v1',
  'scope-resolution': 'akrs.scope-resolution/v1',
  verification: 'akrs.verification/v1',
  handoff: 'akrs.handoff/v1',
  result: 'akrs.result/v1',
  executors: 'akrs.executors/v1',
  plan: 'akrs.plan/v1',
  run: 'akrs.run/v1',
};
const FORMATS = {
  road: 'json', task: 'markdown', state: 'json', 'memory-input': 'json', 'memory-record': 'markdown',
  closure: 'jsonl', 'scope-request': 'jsonl', 'scope-resolution': 'jsonl', verification: 'json',
  handoff: 'jsonl', result: 'jsonl', executors: 'json', plan: 'json', run: 'json',
};
// CLI-owned keys in the stored form that the agent-authored input form omits
const CLI_OWNED = {
  road: ['status', 'meta'], state: ['updated', 'meta'], verification: ['meta'], executors: ['meta'], plan: ['findings', 'closure', 'meta'],
  'scope-request': ['id', 'hash', 'ts', 'type', 'snapshot'], handoff: ['id', 'hash', 'ts', 'snapshot', 'ready'],
  result: ['id', 'hash', 'ts', 'plan', 'tested_snapshot', 'contract_hash', 'run'],
};

test('F6 registry: every artifact kind is registered once, in the frozen order', () => {
  assert.deepEqual(ARTIFACT_KINDS, Object.keys(SCHEMAS));
  assert.deepEqual(Object.keys(SCHEMA_REGISTRY).sort(), Object.values(SCHEMAS).sort());
  for (const [kind, schema] of Object.entries(SCHEMAS)) {
    const entry = SCHEMA_REGISTRY[schema];
    assert.equal(entry.kind, kind);
    assert.equal(entry.format, FORMATS[kind], kind);
    assert.equal(typeof entry.validate, 'function', kind);
    assert.equal(Array.isArray(entry.storedKeys), true, kind);
    assert.equal(Object.isFrozen(entry), true, kind);
  }
});

test('F6 registry: inputKeys are the stored keys minus the CLI-owned keys (Q1, Q7, Q15)', () => {
  for (const [kind, owned] of Object.entries(CLI_OWNED)) {
    const entry = SCHEMA_REGISTRY[SCHEMAS[kind]];
    const expected = entry.storedKeys.filter((key) => !owned.includes(key));
    assert.deepEqual(entry.inputKeys, entry.storedKeys.includes('schema') ? expected : ['schema', ...expected], kind);
  }
  assert.deepEqual(SCHEMA_REGISTRY['akrs.scope-resolution/v1'].inputKeys, ['schema', 'request', 'outcome', 'reason']);
  assert.equal(SCHEMA_REGISTRY['akrs.closure/v1'].inputKeys, null, 'closure records are CLI-generated');
  assert.equal(SCHEMA_REGISTRY['akrs.run/v1'].inputKeys, null, 'run records are CLI-generated');
});

test('F6 registry: every valid fixture validates through validateArtifact; fixtures with CLI-owned keys also validate as input', async () => {
  for (const [kind, schema] of Object.entries(SCHEMAS)) {
    for (const { name, value } of await loadFixtures(kind, 'valid')) {
      const inputOnly = kind === 'task' || kind === 'memory-input';
      const result = validateArtifact(schema, clone(value), { form: inputOnly ? 'input' : 'stored' });
      assert.equal(result.ok, true, `${kind}/${name}: ${describeIssues(result)}`);
      const owned = CLI_OWNED[kind];
      if (owned !== undefined) {
        const input = clone(value);
        for (const key of owned) delete input[key];
        if (kind === 'result') input.evidence = input.evidence.map(({ path, type }) => ({ path, type })); // bytes and sha256 are CLI-filled
        if (!SCHEMA_REGISTRY[schema].storedKeys.includes('schema')) input.schema = schema;
        const inputResult = validateArtifact(schema, input, { form: 'input' });
        assert.equal(inputResult.ok, true, `${kind}/${name} as input: ${describeIssues(inputResult)}`);
      }
    }
  }
});

test('F6 registry: validateArtifact refuses unknown schema IDs instead of guessing', () => {
  for (const schema of ['akrs.road/v2', 'akrs.unknown/v1', '', undefined, 'akrs.packet/v2']) {
    assert.throws(() => validateArtifact(schema, {}), TypeError, String(schema));
  }
});

test('F6 registry: the stored schema key is pinned for JSON artifacts', async () => {
  for (const kind of ['road', 'state', 'verification', 'executors', 'plan', 'run']) {
    const schema = SCHEMAS[kind];
    const value = clone((await loadFixtures(kind, 'valid'))[0].value);
    value.schema = 'akrs.other/v1';
    const result = validateArtifact(schema, value, { form: 'stored' });
    assert.equal(result.ok, false, kind);
    assert.equal(result.issues.some((entry) => entry.path === '$.schema'), true, kind);
  }
});

// ---- ordering table (Q6) ---------------------------------------------------
test('Q6 ordering: binding ordered/set rows for the Road (single source of truth for the codec spec)', () => {
  assert.deepEqual(ORDERING_TABLE['akrs.road/v1'], [
    { path: 'deps', kind: 'set' },
    { path: 'reads', kind: 'ordered' },
    { path: 'reads[].lines', kind: 'ordered' },
    { path: 'writes', kind: 'set', sortKey: 'path' },
    { path: 'forbidden', kind: 'set' },
    { path: 'checks', kind: 'ordered' },
    { path: 'checks[].argv', kind: 'ordered' },
    { path: 'acceptance', kind: 'ordered' },
    { path: 'boundaries', kind: 'ordered' },
    { path: 'steps', kind: 'ordered' },
    { path: 'scope_policy.auto_reads', kind: 'set' },
    { path: 'scope_policy.auto_writes', kind: 'set' },
  ]);
  const handoff = ORDERING_TABLE['akrs.handoff/v1'];
  assert.deepEqual(handoff, [{ path: 'reach', kind: 'ordered' }]);
  const executors = ORDERING_TABLE['akrs.executors/v1'];
  assert.deepEqual(executors, [{ path: 'executors', kind: 'set', sortKey: 'id' }]);
  const verification = ORDERING_TABLE['akrs.verification/v1'];
  assert.deepEqual(verification.find(({ path }) => path === 'roads'), { path: 'roads', kind: 'set' });
  assert.deepEqual(verification.find(({ path }) => path === 'scenario'), { path: 'scenario', kind: 'ordered' });
  assert.deepEqual(verification.find(({ path }) => path === 'scenario[].headers'), { path: 'scenario[].headers', kind: 'set', sortKey: 'name' });
  for (const rows of Object.values(ORDERING_TABLE)) {
    for (const row of rows) {
      assert.equal(['ordered', 'set'].includes(row.kind), true, JSON.stringify(row));
      // Road writes and scope-request add_writes are sets of {path,...} entries keyed by path
      assert.equal(row.kind === 'set' && ['writes', 'add_writes'].includes(row.path) ? row.sortKey === 'path' : true, true);
    }
  }
});

function normalize(path) {
  return path.replace(/\[\d+\]/g, '[]');
}
function arrayPaths(value, base = '') {
  const found = [];
  if (Array.isArray(value)) {
    found.push([base, value]);
    value.forEach((entry) => found.push(...arrayPaths(entry, `${base}[]`)));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) found.push(...arrayPaths(entry, base === '' ? key : `${base}.${key}`));
  }
  return found;
}

test('Q6 ordering: no array in any valid fixture is missing from the table, and every row is exercised with 2+ elements', async () => {
  for (const [kind, schema] of Object.entries(SCHEMAS)) {
    if (kind === 'task') continue;
    const rows = ORDERING_TABLE[schema];
    assert.equal(Array.isArray(rows), true, `${kind} has no ordering rows`);
    const known = new Set(rows.map(({ path }) => path));
    const exercised = new Set();
    for (const { name, value } of await loadFixtures(kind, 'valid')) {
      for (const [path, array] of arrayPaths(value)) {
        assert.equal(known.has(path), true, `${kind}/${name}: array ${path} is not in the ordering table`);
        if (array.length >= 2) exercised.add(path);
      }
    }
    for (const { path } of rows) {
      assert.equal(exercised.has(path), true, `${kind}: ordering row ${path} has no fixture with two or more elements`);
    }
  }
});

// ---- canonical codec integration (Stream A) --------------------------------
function swapAt(value, rowPath) {
  const copy = clone(value);
  let swapped = false;
  const walk = (node, parts) => {
    if (swapped || node === null || typeof node !== 'object') return;
    const [head, ...rest] = parts;
    const isArrayStep = head.endsWith('[]');
    const key = isArrayStep ? head.slice(0, -2) : head;
    const child = key === '' ? node : node[key];
    if (child === undefined) return;
    if (rest.length === 0) {
      if (isArrayStep) return;
      if (Array.isArray(child) && child.length >= 2) {
        [child[0], child[1]] = [child[1], child[0]];
        swapped = true;
      }
      return;
    }
    if (isArrayStep) {
      for (const entry of child) walk(entry, rest);
    } else {
      walk(child, rest);
    }
  };
  walk(copy, rowPath.split('.'));
  return swapped ? copy : null;
}

test('F4 codec x schemas: JSON artifacts canonicalize to LF bytes, round trip, and are idempotent', async () => {
  for (const kind of ['road', 'state', 'verification', 'executors', 'plan', 'run']) {
    const entry = SCHEMA_REGISTRY[SCHEMAS[kind]];
    for (const { name, value } of await loadFixtures(kind, 'valid')) {
      const text = canonicalizeJson(clone(value), storedSpec(entry.spec));
      assert.equal(text.endsWith('\n') && !text.endsWith('\n\n'), true, `${kind}/${name}`);
      assert.equal(text.includes('\r'), false, `${kind}/${name}: raw CR in canonical bytes`);
      assert.equal(text.includes('\u2028') || text.includes('\u2029'), false, `${kind}/${name}: raw U+2028/2029`);
      assert.equal(Object.keys(parseStrictJson(text).value).join(','), [...entry.storedKeys].join(','), `${kind}/${name} key order`);
      const parsed = parseStrictJson(text);
      assert.equal(parsed.ok, true, `${kind}/${name}: ${describeIssues(parsed)}`);
      assert.deepEqual(parsed.value, value, `${kind}/${name} round trip`);
      assert.equal(canonicalizeJson(parsed.value, storedSpec(entry.spec)), text, `${kind}/${name} idempotent`);
    }
  }
});

test('F4 codec x schemas: authored order is preserved for ordered arrays and normalized for sets', async () => {
  let ordered = 0;
  let sets = 0;
  for (const kind of ['road', 'state', 'verification', 'executors', 'plan', 'run']) {
    const schema = SCHEMAS[kind];
    const entry = SCHEMA_REGISTRY[schema];
    for (const row of ORDERING_TABLE[schema]) {
      for (const { name, value } of await loadFixtures(kind, 'valid')) {
        const swapped = swapAt(value, row.path);
        if (swapped === null) continue;
        const before = canonicalizeJson(clone(value), storedSpec(entry.spec));
        const after = canonicalizeJson(swapped, storedSpec(entry.spec));
        if (row.kind === 'ordered') {
          assert.notEqual(after, before, `${kind}/${name} ${row.path}: swapping authored order must change the bytes`);
          ordered += 1;
        } else {
          assert.equal(after, before, `${kind}/${name} ${row.path}: set order must not change the bytes`);
          sets += 1;
        }
        break;
      }
    }
  }
  assert.equal(ordered > 20 && sets > 10, true, `exercised ${ordered} ordered and ${sets} set rows`);
});

test('F4 Unicode free text survives canonicalization byte for byte (Arabic, CJK, emoji, U+2028, CRLF inside strings)', async () => {
  const road = (await loadFixtures('road', 'valid')).find(({ name }) => name === 'unicode-text').value;
  const entry = SCHEMA_REGISTRY['akrs.road/v1'];
  const text = canonicalizeJson(clone(road), storedSpec(entry.spec));
  assert.equal(text.includes('يعرض النظام الرسالة «مرحبا» بشكل صحيح'), true);
  assert.equal(text.includes('界面显示「你好」'), true);
  assert.equal(text.includes('🚀'), true);
  assert.equal(text.includes('\\u2028'), true, 'U+2028 is escaped');
  assert.equal(text.includes('\\r\\n'), true, 'CRLF inside a string stays an escaped CRLF');
  assert.deepEqual(parseStrictJson(text).value.acceptance, road.acceptance);
  const state = (await loadFixtures('state', 'valid')).find(({ name }) => name === 'freefield-unicode').value;
  const stateText = canonicalizeJson(clone(state), storedSpec(SCHEMA_REGISTRY['akrs.state/v1'].spec));
  assert.equal(parseStrictJson(stateText).value.next, state.next);
});

function firstStringLeaf(value, skip = new Set(['schema', 'meta', 'id', 'hash', 'ts'])) {
  const walk = (node, path) => {
    if (typeof node === 'string') return path;
    if (node === null || typeof node !== 'object') return null;
    for (const [key, entry] of Object.entries(node)) {
      if (path.length === 0 && skip.has(key)) continue;
      const found = walk(entry, [...path, key]);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(value, []);
}
function appendAt(value, path) {
  let node = value;
  for (const key of path.slice(0, -1)) node = node[key];
  node[path.at(-1)] = `${node[path.at(-1)]}x`;
}

test('F4 stored meta: withMeta adds meta, a tampered artifact is unverified, an untouched one is declared', async () => {
  for (const kind of ['road', 'state', 'verification', 'executors', 'plan', 'run']) {
    const entry = SCHEMA_REGISTRY[SCHEMAS[kind]];
    const fixture = clone((await loadFixtures(kind, 'valid'))[0].value);
    delete fixture.meta;
    const stored = withMeta(fixture, { schema: SCHEMAS[kind], generator: 'akrs/2.0.0-alpha.0', spec: entry.spec });
    assert.equal(validateArtifact(SCHEMAS[kind], clone(stored), { form: 'stored' }).ok, true, kind);
    assert.equal(verifyMeta(stored, { spec: entry.spec }), 'declared', kind);
    const tampered = clone(stored);
    const leaf = firstStringLeaf(tampered);
    appendAt(tampered, leaf);
    assert.equal(verifyMeta(tampered, { spec: entry.spec }), 'unverified', `${kind}.${leaf.join('.')}`);
  }
});

test('F4 JSONL records: id + hash per record, declared on decode, unverified when edited', async () => {
  for (const kind of ['closure', 'scope-request', 'scope-resolution', 'handoff', 'result']) {
    const schema = SCHEMAS[kind];
    const entry = SCHEMA_REGISTRY[schema];
    const lines = [];
    for (const { value } of await loadFixtures(kind, 'valid')) {
      const { hash: _hash, ...record } = clone(value); // the codec computes the hash
      lines.push(encodeJsonlRecord(record, entry.spec));
    }
    for (const line of lines) {
      assert.equal(line.endsWith('\n') && line.indexOf('\n') === line.length - 1, true, `${kind}: one line per record`);
    }
    const decoded = decodeJsonl(lines.join(''), () => entry.spec);
    assert.equal(decoded.ok, true, `${kind}: ${describeIssues(decoded)}`);
    assert.deepEqual(decoded.records.map(({ state }) => state), lines.map(() => 'declared'), kind);
    for (const record of decoded.records) assert.equal(validateArtifact(schema, clone(record.value)).ok, true, `${kind} decoded record`);
    const record = JSON.parse(lines[0]);
    appendAt(record, firstStringLeaf(record, new Set(['id', 'hash', 'ts', 'type', 'kind', 'schema'])));
    const again = decodeJsonl(`${JSON.stringify(record)}
`, () => entry.spec);
    assert.equal(again.records[0].state, 'unverified', kind);
  }
});

test('F4 Memory records: one table row each with a hidden id/hash marker; Unicode survives', async () => {
  const entry = SCHEMA_REGISTRY['akrs.memory-record/v1'];
  const records = (await loadFixtures('memory-record', 'valid')).map(({ value }) => clone(value));
  records.push({
    id: '01HZX9Q7M3T5V8W2K4N6P0R1S2', label: 'Assumption Low', decided_by: null, owner_plan: null,
    text: 'مكوّن الجدول 界面 🚀 | pipe', pointers: [{ path: 'app/a.vue', lines: null }],
  });
  const text = renderMarkdownHeader(entry.spec) + records.map((record) => renderMarkdownRecord(record, entry.spec)).join('');
  assert.equal(text.includes('\r'), false);
  const parsed = parseMarkdownRecords(text, entry.spec);
  assert.equal(parsed.ok, true, describeIssues(parsed));
  assert.deepEqual(parsed.records.map(({ value }) => value), records);
  assert.deepEqual(parsed.records.map(({ state }) => state), records.map(() => 'declared'));
  const edited = text.replace('shared table component', 'other table component');
  assert.equal(parseMarkdownRecords(edited, entry.spec).records[0].state, 'unverified');
});

test('Q30 registry: validateArtifact threads workflowRoot to the validators that depend on it', async () => {
  const road = clone((await loadFixtures('road', 'valid')).find(({ name }) => name === 'full').value);
  road.scope_policy = { auto_reads: [], auto_writes: ['wf/**'] };
  const withDefault = validateArtifact('akrs.road/v1', clone(road), { form: 'stored' });
  assert.equal(withDefault.ok, true, 'wf/** is just a directory under the default root');
  const withRoot = validateArtifact('akrs.road/v1', clone(road), { form: 'stored', workflowRoot: 'wf' });
  assert.equal(withRoot.issues.some((entry) => entry.code === 'invalid_envelope'), true);
  const result = clone((await loadFixtures('result', 'valid')).find(({ name }) => name === 'pass').value);
  assert.equal(validateArtifact('akrs.result/v1', clone(result), { workflowRoot: 'wf' }).ok, false);
  assert.throws(() => validateArtifact('akrs.road/v1', clone(road), { form: 'stored', workflowRoot: '/abs' }), TypeError);
});

function concretePaths(value, base = []) {
  const found = [];
  if (Array.isArray(value)) found.push(base);
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) found.push(...concretePaths(entry, [...base, Array.isArray(value) ? Number(key) : key]));
  }
  return found;
}

test('F4 sparse arrays: no validator throws on a hole, and none accepts one, at any array of any valid fixture', async () => {
  for (const [kind, schema] of Object.entries(SCHEMAS)) {
    for (const { name, value } of await loadFixtures(kind, 'valid')) {
      for (const location of concretePaths(value)) {
        if (location.length === 0) continue;
        const candidate = clone(value);
        let parent = candidate;
        for (const key of location.slice(0, -1)) parent = parent[key];
        parent[location.at(-1)] = new Array(2);
        const options = { form: kind === 'task' || kind === 'memory-input' ? 'input' : 'stored' };
        let result;
        assert.doesNotThrow(() => { result = validateArtifact(schema, candidate, options); }, `${kind}/${name} ${location.join('.')}`);
        assert.equal(result.ok, false, `${kind}/${name} ${location.join('.')} accepted a sparse array`);
      }
    }
  }
});

test('F4 unknown forms throw for every kind (not only the kinds that have several forms)', () => {
  for (const schema of Object.values(SCHEMAS)) {
    assert.throws(() => validateArtifact(schema, {}, { form: 'bogus' }), TypeError, schema);
  }
  assert.throws(() => validateArtifact('akrs.closure/v1', {}, { form: 'input' }), TypeError);
  assert.throws(() => validateArtifact('akrs.run/v1', {}, { form: 'input' }), TypeError);
  assert.throws(() => validateArtifact('akrs.task/v1', {}, { form: 'stored' }), TypeError);
  assert.throws(() => validateArtifact('akrs.memory-record/v1', {}, { form: 'input' }), TypeError);
});
