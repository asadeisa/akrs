import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_INPUT_BYTES, parseStrictJson } from '../../lib/store/canonical/index.js';
import { isPlainObject } from '../../lib/schemas/validation.js';

const codes = (result) => result.issues.map(({ code }) => code);

test('F4 the strict reader accepts valid JSON and preserves authored key order', () => {
  const result = parseStrictJson('{"b":1,"a":[true,null,"x",{"c":-3}],"z":"é\\u00e9\\n"}');
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(Object.keys(result.value), ['b', 'a', 'z']);
  assert.deepEqual(result.value, { b: 1, a: [true, null, 'x', { c: -3 }], z: 'éé\n' });
  assert.equal(isPlainObject(result.value), true);
  assert.equal(parseStrictJson('0').value, 0);
  assert.equal(parseStrictJson(' [ ] ').ok, true);
});

test('F4 duplicate keys are rejected at every depth with a path', () => {
  const top = parseStrictJson('{"a":1,"a":2}');
  assert.equal(top.ok, false);
  assert.deepEqual(top.issues.map(({ code, path }) => [code, path]), [['duplicate_key', '$.a']]);
  const nested = parseStrictJson('{"o":{"x":1,"y":2,"x":3},"l":[{"k":1,"k":1}]}');
  assert.deepEqual(nested.issues.map(({ code, path }) => [code, path]), [
    ['duplicate_key', '$.o.x'],
    ['duplicate_key', '$.l[0].k'],
  ]);
  assert.equal(parseStrictJson('{"a":1,"\\u0061":2}').ok, false);
});

test('F4 __proto__ and constructor keys are rejected, including escaped spellings', () => {
  for (const text of [
    '{"__proto__":1}',
    '{"constructor":{}}',
    '{"a":{"__proto__":{}}}',
    '[{"constructor":1}]',
    '{"\\u005f_proto__":1}',
    '{"constr\\u0075ctor":1}',
  ]) {
    const result = parseStrictJson(text);
    assert.equal(result.ok, false, text);
    assert.equal(codes(result).includes('forbidden_key'), true, text);
  }
  assert.equal(parseStrictJson('{"proto":1,"constructors":2}').ok, true);
});

test('F4 a BOM, NUL, and oversize input are rejected before parsing', () => {
  assert.deepEqual(codes(parseStrictJson('\uFEFF{}')), ['bom']);
  assert.deepEqual(codes(parseStrictJson('{"a":"x\u0000y"}')), ['nul_byte']);
  assert.deepEqual(codes(parseStrictJson(`"${'a'.repeat(MAX_INPUT_BYTES)}"`)), ['too_large']);
  assert.equal(MAX_INPUT_BYTES, 1024 * 1024);
  const exact = `"${'a'.repeat(MAX_INPUT_BYTES - 2)}"`;
  assert.equal(Buffer.byteLength(exact), MAX_INPUT_BYTES);
  assert.equal(parseStrictJson(exact).ok, true);
  const multibyte = `"${'é'.repeat(MAX_INPUT_BYTES / 2)}"`;
  assert.deepEqual(codes(parseStrictJson(multibyte)), ['too_large']);
});

test('F4 only safe integers are numbers: no fractions, exponents, -0, leading zeros, or unsafe integers', () => {
  for (const text of ['1.5', '1e2', '1E2', '-0', '01', '+1', '.5', '5.', '9007199254740993', '-9007199254740993', '1e400', 'NaN', 'Infinity']) {
    const result = parseStrictJson(`[${text}]`);
    assert.equal(result.ok, false, text);
    assert.equal(codes(result).some((code) => code === 'invalid_number' || code === 'invalid_json'), true, text);
  }
  assert.deepEqual(parseStrictJson('[0,-1,9007199254740991,-9007199254740991]').value, [
    0, -1, 9007199254740991, -9007199254740991,
  ]);
  assert.deepEqual(codes(parseStrictJson('[1.5]')), ['invalid_number']);
});

test('F4 lone surrogate escapes are rejected; valid pairs and raw U+2028 are accepted', () => {
  for (const text of ['"\\ud800"', '"\\udc00"', '"\\ud800x"', '"\\udc00\\ud800"']) {
    assert.deepEqual(codes(parseStrictJson(text)), ['lone_surrogate'], text);
  }
  assert.equal(parseStrictJson('"\\ud83d\\ude00"').value, '\u{1F600}');
  assert.equal(parseStrictJson('"a\u2028b"').value, 'a\u2028b');
});

test('F4 malformed JSON reports invalid_json instead of throwing', () => {
  for (const text of [
    '', '   ', '{', '}', '[1,]', '{"a":1,}', '{"a" 1}', "{'a':1}", '{"a":1} x', '[1] [2]', '"unterminated',
    '{"a":tru}', '{a:1}', '"a\nb"', '"\\x41"', '"\\u12"', '[01]',
  ]) {
    const result = parseStrictJson(text);
    assert.equal(result.ok, false, JSON.stringify(text));
    assert.equal(result.issues.length > 0, true, JSON.stringify(text));
    assert.equal(result.value, undefined, JSON.stringify(text));
  }
  assert.equal(parseStrictJson(7).ok, false);
});

test('F4 nesting depth is capped', () => {
  const deep = (levels) => `${'['.repeat(levels)}${']'.repeat(levels)}`;
  assert.equal(parseStrictJson(deep(64)).ok, true);
  assert.deepEqual(codes(parseStrictJson(deep(65))), ['too_deep']);
});

test('F4 the reader never mutates prototypes', () => {
  const before = Object.keys(Object.prototype).length;
  parseStrictJson('{"__proto__":{"polluted":true}}');
  assert.equal(Object.keys(Object.prototype).length, before);
  assert.equal({}.polluted, undefined);
});

test('Q24 strict reader issue paths use the unambiguous key form for non-identifier keys', () => {
  const dup = parseStrictJson('{"a.b": 1, "a.b": 2, "": 1, "": 2, "x[0]": {"k": 1, "k": 2}}');
  assert.deepEqual(dup.issues.map(({ code, path }) => [code, path]), [
    ['duplicate_key', '$["a.b"]'],
    ['duplicate_key', '$[""]'],
    ['duplicate_key', '$["x[0]"].k'],
  ]);
  const proto = parseStrictJson('{"list": [{"__proto__": 1}]}');
  assert.deepEqual(proto.issues.map(({ code, path }) => [code, path]), [['forbidden_key', '$.list[0].__proto__']]);
});
