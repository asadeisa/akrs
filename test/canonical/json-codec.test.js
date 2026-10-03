import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalizeJson,
  canonicalizeJsonCompact,
  compareCodePoints,
  parseStrictJson,
} from '../../lib/store/canonical/index.js';
import { SAMPLE_SPEC } from './support.js';

function sample(overrides = {}) {
  return {
    note: 'n',
    nested: { b: false, a: 7 },
    checks: ['second', 'first'],
    writes: [
      { action: 'create', class: 'file', path: 'src/z.js' },
      { path: 'src/a.js', class: 'file', action: 'modify' },
    ],
    reads: [{ why: null, lines: [3, 9], path: 'docs/b.md' }, { path: 'docs/a.md', lines: [], why: 'x' }],
    deps: ['R-2', 'R-1'],
    id: 'R-9',
    schema: 'akrs.sample/v1',
    ...overrides,
  };
}

const EXPECTED = `{
  "schema": "akrs.sample/v1",
  "id": "R-9",
  "deps": [
    "R-1",
    "R-2"
  ],
  "reads": [
    {
      "path": "docs/b.md",
      "lines": [
        3,
        9
      ],
      "why": null
    },
    {
      "path": "docs/a.md",
      "lines": [],
      "why": "x"
    }
  ],
  "writes": [
    {
      "path": "src/a.js",
      "class": "file",
      "action": "modify"
    },
    {
      "path": "src/z.js",
      "class": "file",
      "action": "create"
    }
  ],
  "checks": [
    "second",
    "first"
  ],
  "nested": {
    "a": 7,
    "b": false
  },
  "note": "n"
}
`;

test('F4 canonical JSON uses schema-declared key order, 2-space indent, LF, and one final newline', () => {
  assert.equal(canonicalizeJson(sample(), SAMPLE_SPEC), EXPECTED);
  const text = canonicalizeJson(sample(), SAMPLE_SPEC);
  assert.equal(text.includes('\r'), false);
  assert.equal(text.startsWith('\uFEFF'), false);
  assert.equal(text.endsWith('}\n'), true);
  assert.equal(text.endsWith('\n\n'), false);
});

test('F4 canonical bytes do not depend on input key order or the process time zone', () => {
  const reversed = Object.fromEntries(Object.entries(sample()).reverse());
  const expected = canonicalizeJson(sample(), SAMPLE_SPEC);
  assert.equal(canonicalizeJson(reversed, SAMPLE_SPEC), expected);
  const zone = process.env.TZ;
  try {
    for (const candidate of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
      process.env.TZ = candidate;
      assert.equal(canonicalizeJson(sample(), SAMPLE_SPEC), expected);
    }
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test('F4 ordered arrays keep authored order and set arrays are sorted by code point and unique', () => {
  const ordered = canonicalizeJson(sample({ checks: ['b', 'a', 'c'] }), SAMPLE_SPEC);
  const reorderedChecks = canonicalizeJson(sample({ checks: ['c', 'b', 'a'] }), SAMPLE_SPEC);
  assert.notEqual(ordered, reorderedChecks);
  assert.deepEqual(parseStrictJson(reorderedChecks).value.checks, ['c', 'b', 'a']);

  const shuffled = canonicalizeJson(sample({ deps: ['R-1', 'R-2'] }), SAMPLE_SPEC);
  assert.equal(shuffled, canonicalizeJson(sample({ deps: ['R-2', 'R-1'] }), SAMPLE_SPEC));

  const astral = canonicalizeJson(sample({ deps: ['\u{1F600}', '￿', 'a', 'B'] }), SAMPLE_SPEC);
  assert.deepEqual(parseStrictJson(astral).value.deps, ['B', 'a', '￿', '\u{1F600}']);
  assert.equal(compareCodePoints('\u{1F600}', '￿'), 1);
  assert.equal(compareCodePoints('￿', '\u{1F600}'), -1);
  assert.equal(compareCodePoints('a', 'a'), 0);
  assert.equal(compareCodePoints('a', 'ab'), -1);
  assert.equal(compareCodePoints('b', 'a'), 1);
});

test('F4 duplicate set members and duplicate set sort keys are rejected', () => {
  assert.throws(() => canonicalizeJson(sample({ deps: ['R-1', 'R-1'] }), SAMPLE_SPEC), /duplicate/);
  assert.throws(() => canonicalizeJson(sample({
    writes: [
      { path: 'a', class: 'file', action: 'create' },
      { path: 'a', class: 'dir', action: 'modify' },
    ],
  }), SAMPLE_SPEC), /duplicate/);
});

test('F4 the writer is closed: missing keys, unknown keys, and undeclared arrays throw', () => {
  const base = sample();
  for (const key of SAMPLE_SPEC.keys) {
    const copy = { ...base };
    delete copy[key];
    assert.throws(() => canonicalizeJson(copy, SAMPLE_SPEC), TypeError, key);
  }
  assert.throws(() => canonicalizeJson({ ...base, extra: 1 }, SAMPLE_SPEC), /unknown key/);
  assert.throws(() => canonicalizeJson(sample({ nested: { a: 1, b: 2, c: 3 } }), SAMPLE_SPEC), /unknown key/);
  assert.throws(() => canonicalizeJson(sample({ note: ['x'] }), SAMPLE_SPEC), /undeclared array|scalar/);
  assert.throws(() => canonicalizeJson(sample({ deps: 'R-1' }), SAMPLE_SPEC), /array/);
  assert.throws(() => canonicalizeJson(sample({ reads: [{ path: 'a', lines: 'x', why: null }] }), SAMPLE_SPEC), /array/);
  assert.throws(() => canonicalizeJson([], SAMPLE_SPEC), /object/);
  assert.throws(() => canonicalizeJson(sample({ nested: [] }), SAMPLE_SPEC), /object/);
  assert.equal(canonicalizeJson(sample({ nested: null }), SAMPLE_SPEC).includes('"nested": null'), true);
});

test('F4 only canonical scalars are written: integers, strings, booleans, null', () => {
  for (const bad of [1.5, Number.NaN, Infinity, -Infinity, -0, 2 ** 53, undefined, 10n, () => 1, new Date(0), Symbol('x')]) {
    assert.throws(() => canonicalizeJson(sample({ note: bad }), SAMPLE_SPEC), TypeError, String(typeof bad));
  }
  const text = canonicalizeJson(sample({ note: null, nested: { a: -5, b: true } }), SAMPLE_SPEC);
  assert.equal(text.includes('"note": null'), true);
  assert.equal(text.includes('"a": -5'), true);
  assert.equal(canonicalizeJson(sample({ nested: { a: 9007199254740991, b: false } }), SAMPLE_SPEC).includes('9007199254740991'), true);
});

test('F4 string escaping follows JSON.stringify plus escaped U+2028/U+2029 and rejects lone surrogates', () => {
  const text = canonicalizeJson(sample({ note: 'q"\\ \u0001\n\r\t \u2028\u2029 é \u{1F600} \u007f' }), SAMPLE_SPEC);
  assert.equal(text.includes('"note": "q\\"\\\\ \\u0001\\n\\r\\t \\u2028\\u2029 é \u{1F600} \u007f"'), true);
  assert.equal(text.includes('\u2028'), false);
  assert.equal(text.includes('\u2029'), false);
  assert.equal(parseStrictJson(text).value.note, 'q"\\ \u0001\n\r\t \u2028\u2029 é \u{1F600} \u007f');
  for (const note of ['\ud800', 'a\udc00', '\udc00\ud800']) {
    assert.throws(() => canonicalizeJson(sample({ note }), SAMPLE_SPEC), /surrogate/);
  }
  assert.throws(() => canonicalizeJson(sample({ deps: ['\ud800'] }), SAMPLE_SPEC), /surrogate/);
});

test('F4 a nullable array is written as null; any other array must be an array', () => {
  const text = canonicalizeJson(sample({ reads: [{ path: 'a.md', lines: null, why: null }] }), SAMPLE_SPEC);
  assert.equal(text.includes('"lines": null'), true);
  assert.equal(canonicalizeJson(parseStrictJson(text).value, SAMPLE_SPEC), text);
  assert.throws(() => canonicalizeJson(sample({ deps: null }), SAMPLE_SPEC), /array/);
  assert.throws(() => canonicalizeJson({ a: null }, { keys: ['a'], arrays: { a: { kind: 'ordered', nullable: 'yes' } }, objects: {} }), /spec/);
});

test('F4 canonical bytes round-trip through the strict reader and are idempotent', () => {
  const first = canonicalizeJson(sample(), SAMPLE_SPEC);
  const parsed = parseStrictJson(first);
  assert.equal(parsed.ok, true);
  assert.equal(canonicalizeJson(parsed.value, SAMPLE_SPEC), first);
  assert.deepEqual(Object.keys(parsed.value), SAMPLE_SPEC.keys);
});

test('F4 invalid specs are programming errors', () => {
  assert.throws(() => canonicalizeJson({}, { keys: ['1'], arrays: {}, objects: {} }), /spec/);
  assert.throws(() => canonicalizeJson({ a: [] }, { keys: ['a'], arrays: { a: { kind: 'bag' } }, objects: {} }), /spec/);
  assert.throws(() => canonicalizeJson({ a: [] }, { keys: ['a'], arrays: { a: { kind: 'set', sortKey: 'x' } }, objects: {} }), /spec/);
  assert.throws(() => canonicalizeJson({}, null), /spec/);
  assert.throws(() => canonicalizeJson({ a: [{ x: 1 }] }, { keys: ['a'], arrays: { a: { kind: 'ordered' } }, objects: {} }), /object item/);
});

const STEP_SPEC = {
  keys: ['id', 'scenario'],
  arrays: {
    scenario: {
      kind: 'ordered',
      item: {
        discriminator: 'step',
        variants: {
          goto: { keys: ['step', 'url', 'soft'] },
          http: {
            keys: ['step', 'method', 'url', 'headers', 'expect_json'],
            arrays: { headers: { kind: 'set', sortKey: 'name', item: { keys: ['name', 'value'] } } },
            objects: { expect_json: { keys: ['pointer', 'equals'], json: ['equals'] } },
          },
          wait_for: { keys: ['step', 'ms'] },
        },
      },
    },
  },
  objects: {},
};

const steps = (...items) => ({ id: 'V-1', scenario: items });

test('Q3 extension: discriminated array items pick a closed variant by the first key and keep authored order', () => {
  const text = canonicalizeJson(steps(
    { soft: false, url: '/a', step: 'goto' },
    { ms: 50, step: 'wait_for' },
    {
      expect_json: { equals: 1, pointer: '/n' },
      headers: [{ value: 'v2', name: 'z' }, { value: 'v1', name: 'a' }],
      url: '/b',
      method: 'GET',
      step: 'http',
    },
  ), STEP_SPEC);
  const parsed = parseStrictJson(text).value;
  assert.deepEqual(parsed.scenario.map((item) => Object.keys(item)), [
    ['step', 'url', 'soft'],
    ['step', 'ms'],
    ['step', 'method', 'url', 'headers', 'expect_json'],
  ]);
  assert.deepEqual(parsed.scenario[2].headers.map(({ name }) => name), ['a', 'z']);
  assert.equal(canonicalizeJson(parsed, STEP_SPEC), text);
  assert.equal(canonicalizeJson(steps(), STEP_SPEC).includes('"scenario": []'), true);
});

test('Q3 extension: a discriminated item with an unknown, missing, or inherited discriminator throws', () => {
  for (const item of [
    { step: 'teleport', url: '/a', soft: false },
    { url: '/a', soft: false },
    { step: 5, url: '/a', soft: false },
    { step: null, url: '/a', soft: false },
    { step: 'constructor' },
    { step: '__proto__' },
    { step: 'toString' },
  ]) {
    assert.throws(() => canonicalizeJson(steps(item), STEP_SPEC), TypeError, JSON.stringify(item));
  }
  assert.throws(() => canonicalizeJson(steps({ step: 'goto', url: '/a' }), STEP_SPEC), /missing key/);
  assert.throws(() => canonicalizeJson(steps({ step: 'goto', url: '/a', soft: false, extra: 1 }), STEP_SPEC), /unknown key/);
  assert.throws(() => canonicalizeJson(steps({ step: 'wait_for', ms: 1, soft: false }), STEP_SPEC), /unknown key/);
  assert.throws(() => canonicalizeJson(steps('goto'), STEP_SPEC), /expected an object/);
  assert.throws(() => canonicalizeJson(steps(null), STEP_SPEC), /expected an object/);
});

test('Q3 extension: discriminated item specs are validated (ordered only, discriminator first in every variant)', () => {
  const wrap = (array) => ({ keys: ['a'], arrays: { a: array }, objects: {} });
  const variants = { one: { keys: ['kind', 'x'] } };
  assert.throws(() => canonicalizeJson({ a: [] }, wrap({ kind: 'set', item: { discriminator: 'kind', variants } })), /spec/);
  assert.throws(() => canonicalizeJson({ a: [] }, wrap({ kind: 'ordered', sortKey: 'kind', item: { discriminator: 'kind', variants } })), /spec/);
  assert.throws(() => canonicalizeJson({ a: [] }, wrap({ kind: 'ordered', item: { discriminator: 'kind', variants: { one: { keys: ['x', 'kind'] } } } })), /spec/);
  assert.throws(() => canonicalizeJson({ a: [] }, wrap({ kind: 'ordered', item: { discriminator: 'kind', variants: { one: { keys: ['x'] } } } })), /spec/);
  assert.throws(() => canonicalizeJson({ a: [] }, wrap({ kind: 'ordered', item: { discriminator: 'kind', variants: {} } })), /spec/);
  assert.throws(() => canonicalizeJson({ a: [] }, wrap({ kind: 'ordered', item: { discriminator: 'kind' } })), /spec/);
  assert.throws(() => canonicalizeJson({ a: [] }, wrap({ kind: 'ordered', item: { discriminator: 7, variants } })), /spec/);
  assert.throws(() => canonicalizeJson({ a: [] }, wrap({ kind: 'ordered', item: { discriminator: 'kind', variants: [] } })), /spec/);
  assert.throws(() => canonicalizeJson({ a: [] }, wrap({ kind: 'ordered', item: { discriminator: 'kind', variants: { one: null } } })), /spec/);
  assert.equal(canonicalizeJson({ a: [{ kind: 'one', x: 1 }] }, wrap({ kind: 'ordered', item: { discriminator: 'kind', variants } })).includes('"x": 1'), true);
});

const JSON_SPEC = { keys: ['id', 'equals'], json: ['equals'], arrays: {}, objects: {} };

test('Q3 extension: spec.json keys carry any canonical JSON value with object keys sorted by code point', () => {
  const value = { z: [3, { b: 2, a: 1 }], B: null, a: { y: true, x: 'text' }, '\u{1F600}': 1, '￿': 2 };
  const text = canonicalizeJson({ id: 'X', equals: value }, JSON_SPEC);
  const parsed = parseStrictJson(text).value;
  assert.deepEqual(Object.keys(parsed.equals), ['B', 'a', 'z', '￿', '\u{1F600}']);
  assert.deepEqual(Object.keys(parsed.equals.a), ['x', 'y']);
  assert.deepEqual(Object.keys(parsed.equals.z[1]), ['a', 'b']);
  assert.deepEqual(parsed.equals.z.map((entry) => (typeof entry === 'number' ? entry : 'object')), [3, 'object']);
  assert.equal(canonicalizeJson(parsed, JSON_SPEC), text);
  assert.equal(canonicalizeJson({ equals: { b: 1, a: 2 }, id: 'X' }, JSON_SPEC), canonicalizeJson({ id: 'X', equals: { a: 2, b: 1 } }, JSON_SPEC));
  for (const scalarValue of [null, true, false, 'text', 0, -5, 9007199254740991, [], {}, [[]], [1, 'a', null]]) {
    const out = canonicalizeJson({ id: 'X', equals: scalarValue }, JSON_SPEC);
    assert.deepEqual(parseStrictJson(out).value.equals, scalarValue);
  }
});

test('Q3 extension: spec.json values keep array order, the integer-only rule, and the surrogate rule', () => {
  assert.deepEqual(parseStrictJson(canonicalizeJson({ id: 'X', equals: ['b', 'a', 'c'] }, JSON_SPEC)).value.equals, ['b', 'a', 'c']);
  for (const bad of [1.5, Number.NaN, -0, undefined, 10n, new Date(0), () => 1, { a: 1.5 }, [Infinity], { a: undefined }, ['\ud800'], { '\udc00': 1 }]) {
    assert.throws(() => canonicalizeJson({ id: 'X', equals: bad }, JSON_SPEC), TypeError, String(typeof bad));
  }
  assert.throws(() => canonicalizeJson({ id: 'X', equals: { 10: 'a', 2: 'b' } }, JSON_SPEC), /index-like/);
  for (const key of ['__proto__', 'constructor']) {
    const forbidden = JSON.parse(`{"${key}": 1}`);
    assert.throws(() => canonicalizeJson({ id: 'X', equals: { nested: forbidden } }, JSON_SPEC), /forbidden/, key);
  }
  assert.equal(({}).polluted, undefined);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalizeJson({ id: 'X', equals: cyclic }, JSON_SPEC), /deep/);
  const sparse = [1];
  sparse[3] = 2;
  assert.throws(() => canonicalizeJson({ id: 'X', equals: sparse }, JSON_SPEC), TypeError);
  assert.throws(() => canonicalizeJson({ id: 'X', equals: Object.create({ inherited: 1 }) }, JSON_SPEC), /object/);
});

test('Q3 extension: spec.json is validated and a non-json key still rejects arbitrary values', () => {
  assert.throws(() => canonicalizeJson({ a: 1 }, { keys: ['a'], json: ['b'], arrays: {}, objects: {} }), /spec/);
  assert.throws(() => canonicalizeJson({ a: 1 }, { keys: ['a'], json: 'a', arrays: {}, objects: {} }), /spec/);
  assert.throws(() => canonicalizeJson({ a: [] }, { keys: ['a'], json: ['a'], arrays: { a: { kind: 'ordered' } }, objects: {} }), /spec/);
  assert.throws(() => canonicalizeJson({ a: {} }, { keys: ['a'], json: ['a'], arrays: {}, objects: { a: { keys: [] } } }), /spec/);
  assert.throws(() => canonicalizeJson({ a: 1 }, { keys: ['a', 'a'], json: ['a'], arrays: {}, objects: {} }), /spec/);
  assert.throws(() => canonicalizeJson({ id: 'X', equals: { a: 1 }, other: { a: 1 } }, JSON_SPEC), /unknown key/);
  assert.throws(() => canonicalizeJson({ id: { a: 1 }, equals: 1 }, JSON_SPEC), /scalar/);
  assert.throws(() => canonicalizeJson({ id: 'X' }, JSON_SPEC), /missing key/);
});

const OPTIONAL_SPEC = {
  keys: ['id', 'class_overrides'],
  arrays: {},
  objects: {
    class_overrides: {
      keys: ['weak', 'medium', 'frontier'],
      optional: ['weak', 'medium', 'frontier'],
      objects: {
        weak: { keys: ['max_writes', 'read_budget'], optional: ['max_writes', 'read_budget'] },
        medium: { keys: ['max_writes', 'read_budget'], optional: ['max_writes', 'read_budget'] },
        frontier: { keys: ['max_writes', 'read_budget'], optional: ['max_writes', 'read_budget'] },
      },
    },
  },
};

test('Q3 extension: optional keys may be absent and present ones keep declared key order', () => {
  assert.equal(canonicalizeJson({ id: 'E', class_overrides: {} }, OPTIONAL_SPEC).includes('"class_overrides": {}'), true);
  const text = canonicalizeJson({
    class_overrides: { frontier: { read_budget: 9 }, weak: { read_budget: 2, max_writes: 1 } },
    id: 'E',
  }, OPTIONAL_SPEC);
  const parsed = parseStrictJson(text).value;
  assert.deepEqual(Object.keys(parsed.class_overrides), ['weak', 'frontier']);
  assert.deepEqual(Object.keys(parsed.class_overrides.weak), ['max_writes', 'read_budget']);
  assert.deepEqual(parsed.class_overrides.frontier, { read_budget: 9 });
  assert.equal(canonicalizeJson(parsed, OPTIONAL_SPEC), text);
  assert.equal(canonicalizeJson({ id: 'E', class_overrides: { weak: {} } }, OPTIONAL_SPEC).includes('"weak": {}'), true);
});

test('Q3 extension: optional only relaxes the missing-key rule; everything else stays closed', () => {
  assert.throws(() => canonicalizeJson({ class_overrides: {} }, OPTIONAL_SPEC), /missing key/);
  assert.throws(() => canonicalizeJson({ id: 'E', class_overrides: { huge: {} } }, OPTIONAL_SPEC), /unknown key/);
  assert.throws(() => canonicalizeJson({ id: 'E', class_overrides: { weak: { max_writes: 1.5 } } }, OPTIONAL_SPEC), TypeError);
  assert.throws(() => canonicalizeJson({ id: 'E', class_overrides: { weak: { max_writes: undefined } } }, OPTIONAL_SPEC), TypeError);
  assert.throws(() => canonicalizeJson({ id: 'E', class_overrides: { weak: { other: 1 } } }, OPTIONAL_SPEC), /unknown key/);
  assert.throws(() => canonicalizeJson({ id: 'E', class_overrides: [] }, OPTIONAL_SPEC), /object/);
  const unrelated = { keys: ['a', 'b'], optional: ['a'], arrays: {}, objects: {} };
  assert.throws(() => canonicalizeJson({ a: 1 }, unrelated), /missing key/);
  assert.equal(canonicalizeJson({ b: 2 }, unrelated), '{\n  "b": 2\n}\n');
  assert.equal(canonicalizeJson({ b: 2, a: 1 }, unrelated), '{\n  "a": 1,\n  "b": 2\n}\n');
});

test('Q3 extension: optional is validated and works with arrays and discriminated items', () => {
  assert.throws(() => canonicalizeJson({}, { keys: ['a'], optional: ['b'], arrays: {}, objects: {} }), /spec/);
  assert.throws(() => canonicalizeJson({}, { keys: ['a'], optional: 'a', arrays: {}, objects: {} }), /spec/);
  assert.throws(() => canonicalizeJson({}, { keys: ['a'], optional: ['a', 'a'], arrays: {}, objects: {} }), /spec/);
  const withArray = { keys: ['a', 'list'], optional: ['list'], arrays: { list: { kind: 'set' } }, objects: {} };
  assert.equal(canonicalizeJson({ a: 1 }, withArray), '{\n  "a": 1\n}\n');
  assert.equal(canonicalizeJson({ a: 1, list: ['y', 'x'] }, withArray).includes('"x",\n    "y"'), true);
  const withVariants = {
    keys: ['steps'],
    arrays: { steps: { kind: 'ordered', item: { discriminator: 'k', variants: { s: { keys: ['k', 'note'], optional: ['note'] } } } } },
    objects: {},
  };
  assert.equal(canonicalizeJson({ steps: [{ k: 's' }, { note: 'n', k: 's' }] }, withVariants).includes('"note": "n"'), true);
});

test('F4 sparse arrays are rejected in ordered, set, and nested arrays instead of being written as null', () => {
  const sparse = (length, ...filled) => {
    const array = new Array(length);
    for (const [index, value] of filled) array[index] = value;
    return array;
  };
  const spec = { keys: ['a', 'b'], arrays: { a: { kind: 'ordered' }, b: { kind: 'set' } }, objects: {} };
  assert.throws(() => canonicalizeJson({ a: new Array(2), b: [] }, spec), /sparse array at \$\.a\[0\]/);
  assert.throws(() => canonicalizeJson({ a: sparse(3, [0, 'x'], [2, 'y']), b: [] }, spec), /sparse array at \$\.a\[1\]/);
  assert.throws(() => canonicalizeJson({ a: [], b: new Array(1) }, spec), /sparse array at \$\.b\[0\]/);
  assert.throws(() => canonicalizeJson({ a: [], b: sparse(3, [0, 'x'], [2, 'y']) }, spec), TypeError);
  assert.throws(() => canonicalizeJson(sample({ reads: sparse(2, [0, { path: 'a', lines: null, why: null }]) }), SAMPLE_SPEC), /sparse array/);
  assert.throws(() => canonicalizeJson({ id: 'X' , equals: sparse(2, [1, 1]) }, { keys: ['id', 'equals'], json: ['equals'], arrays: {}, objects: {} }), /sparse array/);
  assert.equal(canonicalizeJson({ a: [undefined].slice(1), b: [] }, spec), '{\n  "a": [],\n  "b": []\n}\n');
});

test('F4 a spec that declares a __proto__ key is a programming error', () => {
  assert.throws(() => canonicalizeJson({}, { keys: ['__proto__'], arrays: {}, objects: {} }), /spec/);
  assert.throws(() => canonicalizeJson({ a: {} }, { keys: ['a'], arrays: {}, objects: { a: { keys: ['x', '__proto__'] } } }), /spec/);
  assert.throws(() => canonicalizeJson({ a: [] }, {
    keys: ['a'], arrays: { a: { kind: 'ordered', item: { discriminator: 'k', variants: { v: { keys: ['k', '__proto__'] } } } } }, objects: {},
  }), /spec|__proto__/);
  assert.equal(canonicalizeJson({ constructor_name: 1 }, { keys: ['constructor_name'], arrays: {}, objects: {} }), '{\n  "constructor_name": 1\n}\n');
});

function nested(depth, leaf, wrap) {
  let value = leaf;
  for (let level = 0; level < depth; level += 1) value = wrap(value);
  return value;
}

test('F4 json values count absolute document depth so the writer never emits bytes the strict reader rejects', () => {
  const spec = { keys: ['id', 'equals'], json: ['equals'], arrays: {}, objects: {} };
  // root object is level 1 and `equals` sits at level 2, so 63 nested containers is the deepest legal value
  for (const wrap of [(inner) => [inner], (inner) => ({ k: inner })]) {
    const ok = canonicalizeJson({ id: 'X', equals: nested(63, 1, wrap) }, spec);
    const reread = parseStrictJson(ok);
    assert.equal(reread.ok, true, JSON.stringify(reread.issues));
    assert.equal(canonicalizeJson(reread.value, spec), ok);
    assert.throws(() => canonicalizeJson({ id: 'X', equals: nested(64, 1, wrap) }, spec), /too deep/);
    assert.throws(() => canonicalizeJson({ id: 'X', equals: nested(200, 1, wrap) }, spec), /too deep/);
    assert.equal(parseStrictJson(JSON.stringify({ id: 'X', equals: nested(64, 1, wrap) })).ok, false);
  }
  assert.equal(canonicalizeJsonCompact({ id: 'X', equals: nested(63, 1, (inner) => [inner]) }, spec).includes('[[[['), true);
  assert.throws(() => canonicalizeJsonCompact({ id: 'X', equals: nested(64, 1, (inner) => [inner]) }, spec), /too deep/);
});

test('F4 json values nested under declared objects and arrays count the enclosing levels', () => {
  const inner = { keys: ['equals'], json: ['equals'], arrays: {}, objects: {} };
  const spec = { keys: ['list', 'box'], arrays: { list: { kind: 'ordered', item: inner } }, objects: { box: inner } };
  // box.equals: root(1) -> box(2) -> equals value starts at level 3, so 62 containers is the maximum
  const wrap = (value) => [value];
  const build = (listValue, boxValue) => ({ list: [{ equals: listValue }], box: { equals: boxValue } });
  const text = canonicalizeJson(build(nested(61, 1, wrap), nested(62, 1, wrap)), spec);
  assert.equal(parseStrictJson(text).ok, true);
  assert.throws(() => canonicalizeJson(build(nested(61, 1, wrap), nested(63, 1, wrap)), spec), /too deep/);
  // list -> item object -> equals: root(1) -> list(2) -> item(3) -> value at level 4 (61 containers max)
  assert.throws(() => canonicalizeJson({ list: [{ equals: nested(62, 1, (value) => [value]) }], box: { equals: 1 } }, spec), /too deep/);
  assert.equal(parseStrictJson(canonicalizeJson({ list: [{ equals: nested(61, 1, (value) => [value]) }], box: { equals: 1 } }, spec)).ok, true);
});

test('F4 declared object nesting is bounded by the same absolute depth', () => {
  const chain = (levels) => {
    let spec = { keys: ['leaf'], arrays: {}, objects: {} };
    for (let level = 1; level < levels; level += 1) spec = { keys: ['o'], arrays: {}, objects: { o: spec } };
    return spec;
  };
  const value = (levels) => {
    let result = { leaf: 1 };
    for (let level = 1; level < levels; level += 1) result = { o: result };
    return result;
  };
  assert.equal(parseStrictJson(canonicalizeJson(value(64), chain(64))).ok, true);
  assert.throws(() => canonicalizeJson(value(65), chain(65)), /too deep/);
});
