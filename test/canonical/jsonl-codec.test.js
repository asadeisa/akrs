import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalizeJsonCompact,
  contentHash,
  decodeJsonl,
  encodeJsonlRecord,
} from '../../lib/store/canonical/index.js';

const CLOSURE_SPEC = {
  keys: ['id', 'hash', 'ts', 'road', 'outcome', 'deviations'],
  arrays: { deviations: { kind: 'ordered' } },
  objects: {},
};
const ID_1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ID_2 = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const ID_3 = '01ARZ3NDEKTSV4RRFFQ69G5FAX';

function record(id, overrides = {}) {
  return {
    deviations: ['one', 'two\nlines'],
    outcome: 'DONE',
    road: 'R-1',
    ts: '2026-10-03T10:00:00.000Z',
    id,
    ...overrides,
  };
}

function expectedHash(value) {
  const withoutHash = { keys: CLOSURE_SPEC.keys.filter((key) => key !== 'hash'), arrays: CLOSURE_SPEC.arrays, objects: {} };
  const { hash: _hash, ...rest } = value;
  return contentHash(canonicalizeJsonCompact(rest, withoutHash));
}

const lookup = () => CLOSURE_SPEC;

test('F4 a JSONL record is one compact line with spec key order and a per-record hash', () => {
  const line = encodeJsonlRecord(record(ID_1), CLOSURE_SPEC);
  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.slice(0, -1).includes('\n'), false);
  assert.equal(line.includes('\r'), false);
  const hash = expectedHash(record(ID_1));
  assert.equal(
    line,
    `{"id":"${ID_1}","hash":"${hash}","ts":"2026-10-03T10:00:00.000Z","road":"R-1","outcome":"DONE",`
    + '"deviations":["one","two\\nlines"]}\n',
  );
});

test('F4 encoding is deterministic, independent of other records, and never rewrites earlier lines', () => {
  const first = encodeJsonlRecord(record(ID_1), CLOSURE_SPEC);
  const second = encodeJsonlRecord(record(ID_2), CLOSURE_SPEC);
  assert.equal(encodeJsonlRecord(record(ID_1), CLOSURE_SPEC), first);
  const segment = first + second;
  assert.equal(segment.startsWith(first), true);
  const extended = segment + encodeJsonlRecord(record(ID_3), CLOSURE_SPEC);
  assert.equal(extended.startsWith(segment), true);
});

test('F4 encoding is closed: id must be a ULID, hash is computed, the spec must declare id and hash', () => {
  assert.throws(() => encodeJsonlRecord(record('not-a-ulid'), CLOSURE_SPEC), /id/);
  assert.throws(() => encodeJsonlRecord(record(ID_1, { hash: contentHash('x') }), CLOSURE_SPEC), /hash/);
  assert.throws(() => encodeJsonlRecord(record(ID_1, { extra: 1 }), CLOSURE_SPEC), /unknown key/);
  assert.throws(() => encodeJsonlRecord({ ...record(ID_1), deviations: undefined }, CLOSURE_SPEC), TypeError);
  assert.throws(() => encodeJsonlRecord(record(ID_1), { keys: ['id', 'ts'], arrays: {}, objects: {} }), /spec/);
  assert.throws(() => encodeJsonlRecord(record(ID_1), { keys: ['hash', 'ts'], arrays: {}, objects: {} }), /spec/);
});

test('F4 decoding returns declared records with line numbers and tolerates CRLF and a missing final newline', () => {
  const lines = [ID_1, ID_2, ID_3].map((id) => encodeJsonlRecord(record(id), CLOSURE_SPEC));
  const lf = lines.join('');
  for (const text of [lf, lf.replaceAll('\n', '\r\n'), lf.slice(0, -1)]) {
    const result = decodeJsonl(text, lookup);
    assert.equal(result.ok, true);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.records.map(({ line }) => line), [1, 2, 3]);
    assert.deepEqual(result.records.map(({ state }) => state), ['declared', 'declared', 'declared']);
    assert.deepEqual(result.records.map(({ value }) => value.id), [ID_1, ID_2, ID_3]);
    assert.deepEqual(result.records[0].value.deviations, ['one', 'two\nlines']);
  }
  assert.deepEqual(decodeJsonl('', lookup), { ok: true, records: [], issues: [] });
});

test('F4 a hash mismatch yields an unverified record and a failing result, never silent acceptance', () => {
  const good = encodeJsonlRecord(record(ID_1), CLOSURE_SPEC);
  const tampered = good.replace('"DONE"', '"BLOCKED"');
  const result = decodeJsonl(tampered, lookup);
  assert.equal(result.ok, false);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].state, 'unverified');
  assert.deepEqual(result.issues.map(({ code, line }) => [code, line]), [['unverified_record', 1]]);
  const noHash = decodeJsonl(good.replace(/"hash":"[^"]*",/, '"hash":"sha256:00",'), lookup);
  assert.equal(noHash.records[0].state, 'unverified');
});

test('F4 structural problems are reported per line: blank, invalid JSON, duplicate id, unknown record, bad shape', () => {
  const a = encodeJsonlRecord(record(ID_1), CLOSURE_SPEC);
  const b = encodeJsonlRecord(record(ID_2), CLOSURE_SPEC);
  const blank = decodeJsonl(`${a}\n${b}`, lookup);
  assert.deepEqual(blank.issues.map(({ code, line }) => [code, line]), [['blank_line', 2]]);
  assert.equal(blank.records.length, 2);

  const invalid = decodeJsonl(`${a}{not json}\n${b}`, lookup);
  assert.deepEqual(invalid.issues.map(({ code, line }) => [code, line]), [['invalid_json', 2]]);

  const duplicateKey = decodeJsonl(`${a.replace('"deviations":', '"road":"x","deviations":')}`, lookup);
  assert.equal(duplicateKey.issues.some(({ code }) => code === 'duplicate_key'), true);

  const duplicateId = decodeJsonl(`${a}${encodeJsonlRecord(record(ID_1, { road: 'R-2' }), CLOSURE_SPEC)}`, lookup);
  assert.deepEqual(duplicateId.issues.map(({ code, line }) => [code, line]), [['duplicate_record_id', 2]]);

  const unknown = decodeJsonl(a, () => null);
  assert.deepEqual(unknown.issues.map(({ code, line }) => [code, line]), [['unknown_record_type', 1]]);

  const extra = decodeJsonl(a.replace('"road"', '"surprise":1,"road"'), lookup);
  assert.equal(extra.issues.some(({ code, line }) => code === 'invalid_record' && line === 1), true);
  const notObject = decodeJsonl('[1]\n', lookup);
  assert.deepEqual(notObject.issues.map(({ code }) => code), ['invalid_record']);
  assert.equal(decodeJsonl(7, lookup).ok, false);
});
