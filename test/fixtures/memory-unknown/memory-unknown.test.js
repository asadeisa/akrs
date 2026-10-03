// Self-check of the P1-W08 memory-unknown fixture: provenance lists exactly the files present, every invalid input
// fails the closed Memory input schema at exactly the declared RFC 6901 pointers, every valid input passes, the
// canonical Memory files really are canonical (or tampered, or prose, as declared) under the P1-W01 codec, and every
// pointer of a canonical record resolves inside the miniature repository.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MEMORY_LABELS, MEMORY_RECORD_SPEC, validateMemoryInput, validateMemoryRecord,
} from '../../../lib/schemas/memory.js';
import { toJsonPointer } from '../../../lib/schemas/primitives.js';
import { parseMarkdownRecords } from '../../../lib/store/canonical/index.js';

const directory = fileURLToPath(new URL('./', import.meta.url));
const read = (path) => readFile(join(directory, path), 'utf8');
const json = async (path) => JSON.parse(await read(path));
const provenance = await json('provenance.json');
const expected = await json('expected.json');

async function walk(relative) {
  const names = [];
  for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) names.push(...await walk(child));
    else names.push(child);
  }
  return names;
}
const names = async (folder) => (await readdir(join(directory, folder))).filter((name) => name.endsWith('.json')).sort();
const lineCount = (text) => text.replaceAll('\r\n', '\n').split('\n').filter((_, index, all) => index < all.length - 1 || all[index] !== '').length;

test('provenance describes the fixture and lists every runtime file', async () => {
  assert.equal(provenance.fixture, 'memory-unknown');
  assert.equal(provenance.kind, 'synthetic-regression');
  assert.match(provenance.capturedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(provenance.bugIds, ['B25']);
  assert.equal(typeof provenance.source, 'string');
  assert.equal(typeof provenance.note, 'string');
  const present = (await walk('')).filter((name) => !['provenance.json', 'package.json', 'memory-unknown.test.js'].includes(name)).sort();
  assert.deepEqual(provenance.runtimeFiles, present);
  for (const path of provenance.runtimeFiles) assert.equal(path.includes('\\'), false);
});

test('every invalid input fails the closed input schema at exactly the declared pointers (and nowhere else)', async () => {
  const files = await names('invalid');
  assert.equal(files.length >= 30, true);
  for (const name of files) {
    const fixture = await json(`invalid/${name}`);
    assert.deepEqual(Object.keys(fixture).sort(), ['document', 'expect'], name);
    assert.equal(fixture.expect.length > 0, true, name);
    const result = validateMemoryInput(fixture.document);
    assert.equal(result.ok, false, name);
    assert.deepEqual(result.issues.map(({ path, code }) => ({ pointer: toJsonPointer(path), code })), fixture.expect, name);
  }
});

test('the invalid corpus covers the label, owner and pointer rules of Q18', async () => {
  const files = (await names('invalid')).map((name) => name.slice(0, -'.json'.length));
  for (const required of [
    'label-missing', 'label-lowercase', 'label-unknown-word', 'label-assumption-bare', 'label-assumption-parenthesised',
    'decided-without-pointers', 'assumption-without-pointers', 'decided-without-decided-by', 'unknown-with-pointers',
    'unknown-without-owner-plan', 'pointer-path-traversal', 'pointer-window-reversed', 'pointer-glob', 'topic-traversal',
  ]) assert.equal(files.includes(required), true, required);
});

test('the valid inputs are exactly one per frozen label and pass the closed input schema', async () => {
  const labels = [];
  for (const name of await names('valid')) {
    const document = await json(`valid/${name}`);
    assert.equal(validateMemoryInput(document).ok, true, name);
    labels.push(document.label);
  }
  assert.deepEqual(labels.sort(), [...MEMORY_LABELS].sort());
});

test('the canonical Memory file is canonical: declared records that pass the closed record schema, one of them Unknown with an owner Plan', async () => {
  const parsed = parseMarkdownRecords(await read('repo/akrs/memory/use-cases.md'), MEMORY_RECORD_SPEC);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.issues));
  assert.deepEqual(parsed.records.map(({ state }) => state), ['declared', 'declared', 'declared']);
  for (const { value } of parsed.records) assert.equal(validateMemoryRecord(value).ok, true, JSON.stringify(validateMemoryRecord(value).issues));
  assert.deepEqual(parsed.records.map(({ value }) => value.label), ['Decided', 'Assumption Med', 'Unknown']);
  const [, , open] = parsed.records;
  assert.equal(open.value.owner_plan, 'P2');
  assert.deepEqual(open.value.pointers, []);
});

test('every pointer of a canonical record resolves inside the fixture repository, windows in range', async () => {
  for (const file of ['use-cases', 'tampered']) {
    const parsed = parseMarkdownRecords(await read(`repo/akrs/memory/${file}.md`), MEMORY_RECORD_SPEC);
    for (const { value } of parsed.records) {
      for (const { path, lines } of value.pointers) {
        const count = lineCount(await read(`repo/${path}`));
        if (lines !== null) assert.equal(lines[1] <= count, true, `${file}: ${path}`);
      }
    }
  }
});

test('the tampered file has one record whose text no longer matches its hash, and it is an Unknown', async () => {
  const parsed = parseMarkdownRecords(await read('repo/akrs/memory/tampered.md'), MEMORY_RECORD_SPEC);
  assert.deepEqual(parsed.records.map(({ state }) => state), ['unverified', 'declared']);
  assert.equal(parsed.records[0].value.label, 'Unknown');
  assert.deepEqual(parsed.issues.map(({ code }) => code), ['unverified_record']);
});

test('the prose file is a trap: it names labels and an Unknown in prose but has no canonical table', async () => {
  const text = await read('repo/akrs/memory/legacy-prose.md');
  assert.equal(/\*\*Unknown\*\*/.test(text) && /Assumption \(High\)/.test(text) && /\*\*Decided\*\*/.test(text), true);
  const parsed = parseMarkdownRecords(text, MEMORY_RECORD_SPEC);
  assert.deepEqual(parsed.records, []);
  assert.deepEqual(parsed.issues.map(({ code }) => code), ['missing_header']);
});

test('expected.json is consistent with the files: unique ULIDs, the file table, and the Unknown/fact split', async () => {
  const ids = [];
  const unknownIds = [];
  for (const [topic, structured, count] of expected.files) {
    const parsed = parseMarkdownRecords(await read(`repo/akrs/memory/${topic}.md`), MEMORY_RECORD_SPEC);
    assert.equal(parsed.records.length, count, topic);
    assert.equal(structured, count > 0, topic);
    for (const { value } of parsed.records) {
      ids.push(value.id);
      if (value.label === 'Unknown') unknownIds.push(value.id);
    }
  }
  assert.deepEqual([...ids].sort(), expected.record_ids);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...unknownIds].sort(), expected.unknown.map(({ id }) => id).sort());
  assert.equal(expected.facts.some(({ label }) => label === 'Unknown'), false);
  assert.deepEqual(expected.unverified.map(({ id }) => id), ['01ARZ3NDEKTSV4RRFFQ69G5FA3']);
});
