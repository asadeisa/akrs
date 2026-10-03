import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  canonicalizeJson,
  decodeJsonl,
  normalizeInput,
  parseMarkdownRecords,
  parseStrictJson,
  storedSpec,
  verifyMeta,
} from '../../lib/store/canonical/index.js';
import { CLOSURE_SPEC, GOLDEN, MEMORY_SPEC } from './golden-inputs.js';
import { SAMPLE_SPEC } from './support.js';

const goldenUrl = (name) => new URL(`../fixtures/canonical/golden/${name}`, import.meta.url);
const table = JSON.parse(await readFile(goldenUrl('golden.sha256.json'), 'utf8')).files;
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

test('F4 the committed sha256 table lists exactly the golden files', () => {
  assert.deepEqual(Object.keys(table).sort(), Object.keys(GOLDEN).sort());
  for (const value of Object.values(table)) assert.match(value, /^sha256:[0-9a-f]{64}$/);
});

for (const [name, build] of Object.entries(GOLDEN)) {
  test(`F4 golden bytes for ${name} are produced exactly and match the committed hash`, async () => {
    const committed = await readFile(goldenUrl(name));
    assert.equal(sha256(committed), table[name], 'committed bytes match the hash table');
    assert.equal(Buffer.from(build(), 'utf8').equals(committed), true, 'codec output equals committed bytes');
    assert.equal(committed.includes(0x0d), false, 'LF only');
    assert.equal(committed[0] === 0xef && committed[1] === 0xbb && committed[2] === 0xbf, false, 'no BOM');
    assert.equal(committed.at(-1), 0x0a, 'final newline');
    assert.equal(committed.at(-2) === 0x0a && name.endsWith('.json'), false, 'exactly one final newline');
  });
}

function crlfWithBom(text) {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text.replaceAll('\n', '\r\n'), 'utf8')]);
}

test('F16 CRLF and BOM variants of every golden normalize back to the committed canonical bytes', async () => {
  const sample = await readFile(goldenUrl('sample-artifact.json'), 'utf8');
  const unicode = await readFile(goldenUrl('unicode-artifact.json'), 'utf8');
  for (const [text, spec] of [[sample, storedSpec(SAMPLE_SPEC)], [unicode, SAMPLE_SPEC]]) {
    const normalized = normalizeInput(crlfWithBom(text));
    assert.equal(normalized.ok, true);
    assert.equal(normalized.text, text);
    const parsed = parseStrictJson(normalized.text);
    assert.equal(parsed.ok, true);
    assert.equal(canonicalizeJson(parsed.value, spec), text);
  }

  const closure = await readFile(goldenUrl('closure.jsonl'), 'utf8');
  const decoded = decodeJsonl(normalizeInput(crlfWithBom(closure)).text, () => CLOSURE_SPEC);
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.records.map(({ state }) => state), ['declared', 'declared', 'declared']);
  assert.deepEqual(decoded.records.map(({ value }) => value.road), ['R-1', 'R-1', 'R-2']);

  const memory = await readFile(goldenUrl('memory.md'), 'utf8');
  const parsed = parseMarkdownRecords(normalizeInput(crlfWithBom(memory)).text, MEMORY_SPEC);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.records.map(({ state }) => state), ['declared', 'declared']);
  assert.equal(parsed.records[1].value.text.includes('\n'), true);
});

test('F4 the stored golden verifies as declared and any byte change makes it unverified', async () => {
  const stored = parseStrictJson(await readFile(goldenUrl('sample-artifact.json'), 'utf8')).value;
  assert.equal(verifyMeta(stored, { spec: SAMPLE_SPEC }), 'declared');
  assert.equal(verifyMeta({ ...stored, note: 'golden note!' }, { spec: SAMPLE_SPEC }), 'unverified');
  assert.equal(verifyMeta({ ...stored, checks: [...stored.checks].reverse() }, { spec: SAMPLE_SPEC }), 'unverified');
});

test('F4 unicode text survives byte-for-byte while separators are escaped in the file', async () => {
  const text = await readFile(goldenUrl('unicode-artifact.json'), 'utf8');
  assert.equal(text.includes('\\u2028'), true);
  assert.equal(text.includes('\\u2029'), true);
  assert.equal(text.includes('café 日本語 \u{1F600}'), true);
  const value = parseStrictJson(text).value;
  assert.equal(value.note.includes(String.fromCharCode(0x2028)), true);
  assert.equal(value.note.includes('\ttab\nnewline'), true);
});
