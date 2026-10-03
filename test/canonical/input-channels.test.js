import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_INPUT_BYTES,
  canonicalizeJson,
  normalizeInput,
  parseStrictJson,
} from '../../lib/store/canonical/index.js';
import { SAMPLE_SPEC } from './support.js';

const codes = (result) => result.issues.map(({ code }) => code);

const DOCUMENT = {
  schema: 'akrs.sample/v1',
  id: 'R-1',
  deps: ['R-2'],
  reads: [{ path: 'a.md', lines: null, why: 'café \u{1F600}' }],
  writes: [{ path: 'src/a.js', class: 'file', action: 'create' }],
  checks: ['x'],
  nested: null,
  note: 'a\\r\\nb',
};

test('F16 stdin with BOM+CRLF, a file with LF, and BOM-less bytes normalize to identical text and bytes', () => {
  const pretty = JSON.stringify(DOCUMENT, null, 2);
  const lf = Buffer.from(pretty, 'utf8');
  const crlf = Buffer.from(pretty.replaceAll('\n', '\r\n'), 'utf8');
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), crlf]);
  const channels = [lf, crlf, bom, new Uint8Array(bom)];
  const texts = channels.map((bytes) => {
    const result = normalizeInput(bytes);
    assert.equal(result.ok, true);
    assert.deepEqual(result.issues, []);
    return result.text;
  });
  assert.equal(new Set(texts).size, 1);
  assert.equal(texts[0].includes('\r'), false);
  assert.equal(texts[0].startsWith('\uFEFF'), false);
  const canonical = texts.map((text) => canonicalizeJson(parseStrictJson(text).value, SAMPLE_SPEC));
  assert.equal(new Set(canonical).size, 1);
  assert.equal(Buffer.from(canonical[0]).equals(Buffer.from(canonical[2])), true);
});

test('F16 normalization strips exactly one UTF-8 BOM and leaves escaped line breaks inside strings alone', () => {
  assert.equal(normalizeInput(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])).text, '{}');
  const double = normalizeInput(Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x7b, 0x7d]));
  assert.equal(double.ok, false);
  assert.equal(double.text, '');
  assert.deepEqual(codes(double), ['bom']);
  assert.match(double.issues[0].message, /more than one/);
  assert.deepEqual(codes(normalizeInput(Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]))), ['bom']);
  assert.equal(normalizeInput(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])).ok, true);
  // a BOM that is not at the start is ordinary text for the channel; the strict reader rejects it
  const inner = normalizeInput(Buffer.from([0x20, 0xef, 0xbb, 0xbf, 0x7b, 0x7d]));
  assert.equal(inner.ok, true);
  assert.equal(parseStrictJson(inner.text).ok, false);
  assert.equal(normalizeInput(Buffer.from('{"a":"x\\r\\ny"}')).text, '{"a":"x\\r\\ny"}');
  assert.deepEqual(normalizeInput(Buffer.alloc(0)), { ok: true, text: '', issues: [] });
  assert.equal(normalizeInput(Buffer.from('a\r\nb\r\n')).text, 'a\nb\n');
});

test('F16 UTF-16, invalid UTF-8, NUL, and oversize input are rejected with stable codes', () => {
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{}', 'utf16le')]);
  const utf16be = Buffer.from([0xfe, 0xff, 0x00, 0x7b, 0x00, 0x7d]);
  assert.deepEqual(codes(normalizeInput(utf16le)), ['invalid_encoding']);
  assert.deepEqual(codes(normalizeInput(utf16be)), ['invalid_encoding']);
  assert.deepEqual(codes(normalizeInput(Buffer.from('{}', 'utf16le'))), ['nul_byte']);
  assert.deepEqual(codes(normalizeInput(Buffer.from([0x7b, 0xc3, 0x28, 0x7d]))), ['invalid_encoding']);
  assert.deepEqual(codes(normalizeInput(Buffer.from([0xed, 0xa0, 0x80]))), ['invalid_encoding']);
  assert.deepEqual(codes(normalizeInput(Buffer.from([0xc0, 0xaf]))), ['invalid_encoding']);
  assert.deepEqual(codes(normalizeInput(Buffer.from('{"a":"x\u0000"}'))), ['nul_byte']);
  assert.deepEqual(codes(normalizeInput(Buffer.alloc(MAX_INPUT_BYTES + 1, 0x20))), ['too_large']);
  assert.equal(normalizeInput(Buffer.alloc(MAX_INPUT_BYTES, 0x20)).ok, true);
  for (const result of [normalizeInput(utf16le), normalizeInput(Buffer.from([0xc3, 0x28]))]) {
    assert.equal(result.ok, false);
    assert.equal(result.text, '');
  }
});

test('F16 only byte buffers are accepted as input', () => {
  for (const bad of ['{}', 5, null, undefined, {}, []]) assert.throws(() => normalizeInput(bad), TypeError);
});

test('F16 a NUL-byte rejection hints at UTF-16 only when the byte pattern fits', () => {
  const hint = /UTF-16/;
  const messageOf = (bytes) => normalizeInput(bytes).issues[0].message;
  assert.match(messageOf(Buffer.from('{"a": 1}', 'utf16le')), hint);
  assert.match(messageOf(Buffer.from('{"a": 1}', 'utf16le').swap16()), hint);
  assert.match(messageOf(Buffer.from('{}', 'utf16le')), hint);
  assert.match(messageOf(Buffer.from('caf\u00e9 \u65e5\u672c', 'utf16le')), hint);
  assert.doesNotMatch(messageOf(Buffer.from('{"a":"x\u0000"}')), hint);
  assert.doesNotMatch(messageOf(Buffer.from([0x7b, 0x00, 0x7d])), hint);
  assert.doesNotMatch(messageOf(Buffer.from('plain text with a NUL \u0000 inside it, long enough')), hint);
  for (const bytes of [Buffer.from('{}', 'utf16le'), Buffer.from('{"a":"x\u0000"}')]) {
    assert.deepEqual(codes(normalizeInput(bytes)), ['nul_byte']);
  }
});
