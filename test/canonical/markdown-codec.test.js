import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  contentHash,
  parseMarkdownRecords,
  renderMarkdownHeader,
  renderMarkdownRecord,
} from '../../lib/store/canonical/index.js';

const SPEC = {
  columns: [
    { key: 'label', header: 'Label', kind: 'text' },
    { key: 'text', header: 'Memory', kind: 'text' },
    { key: 'decided_by', header: 'Decided by', kind: 'json' },
    { key: 'pointers', header: 'Pointers', kind: 'json' },
  ],
};
const ID_1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ID_2 = '01ARZ3NDEKTSV4RRFFQ69G5FAW';

function memory(id, overrides = {}) {
  return {
    id,
    label: 'Decided',
    text: 'Use SQLite.',
    decided_by: 'P1',
    pointers: [{ path: 'docs/a.md', lines: [1, 2] }],
    ...overrides,
  };
}

const table = (...records) => renderMarkdownHeader(SPEC) + records.map((value) => renderMarkdownRecord(value, SPEC)).join('');

test('F4 the Memory table renders a header, a separator, and one row with a hidden id/hash marker', () => {
  assert.equal(renderMarkdownHeader(SPEC), '| Label | Memory | Decided by | Pointers |\n|---|---|---|---|\n');
  const row = renderMarkdownRecord(memory(ID_1), SPEC);
  assert.equal(row.endsWith(' |\n'), true);
  assert.equal(row.split('\n').length, 2);
  const cells = ['Decided', 'Use SQLite.', '"P1"', '[{"path":"docs/a.md","lines":[1,2]}]'];
  const hash = contentHash([ID_1, ...cells].join('\n'));
  assert.equal(
    row,
    `| Decided | Use SQLite. | "P1" | [{"path":"docs/a.md","lines":[1,2]}] <!-- akrs:record ${ID_1} ${hash} --> |\n`,
  );
});

test('F4 records round-trip losslessly including pipes, backslashes, newlines, markup, and Unicode', () => {
  const awkward = [
    'a | b',
    'back\\slash \\| not-a-pipe',
    'line one\nline two\n\nline four',
    '<br> literal and <!-- akrs:record X sha256:00 -->',
    'trailing space ',
    ' leading space',
    '',
    'مرحبا بالعالم',
    '日本語のメモ',
    'emoji \u{1F600} and \u2028 separator',
    '- [ ] not a task | `code`',
    '-->',
  ];
  const values = awkward.map((text, index) => memory(`01ARZ3NDEKTSV4RRFFQ69G5F${'ABCDEFGHJKMN'[index]}${'V'}`, { text }));
  const result = parseMarkdownRecords(table(...values), SPEC);
  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.records.map(({ value }) => value), values);
  assert.deepEqual(result.records.map(({ state }) => state), values.map(() => 'declared'));
  for (const { value } of result.records) assert.deepEqual(Object.keys(value), ['id', 'label', 'text', 'decided_by', 'pointers']);
});

test('F4 json columns carry null, lists, and nested values exactly', () => {
  const values = [
    memory(ID_1, { decided_by: null, pointers: [] }),
    memory(ID_2, { decided_by: 'plan | phase', pointers: [{ path: 'a|b.md', lines: null }, { path: 'c.md', lines: [3, 4] }] }),
  ];
  const result = parseMarkdownRecords(table(...values), SPEC);
  assert.equal(result.ok, true);
  assert.deepEqual(result.records.map(({ value }) => value), values);
});

test('F4 the parser ignores plain text around the table, tolerates CRLF, and reports 1-based line numbers', () => {
  const body = `# Memory: ui\n\nIntro paragraph | with a pipe.\n\n${table(memory(ID_1), memory(ID_2))}\nTrailing prose.\n`;
  const result = parseMarkdownRecords(body.replaceAll('\n', '\r\n'), SPEC);
  assert.equal(result.ok, true);
  assert.deepEqual(result.records.map(({ line }) => line), [7, 8]);
  assert.deepEqual(parseMarkdownRecords(`# nothing here\n`, SPEC).issues.map(({ code }) => code), ['missing_header']);
});

test('F4 the parser never silently drops a record: rows or markers outside the table are row_outside_table issues', () => {
  const header = renderMarkdownHeader(SPEC);
  const row1 = renderMarkdownRecord(memory(ID_1), SPEC);
  const row2 = renderMarkdownRecord(memory(ID_2), SPEC);
  const outside = (text) => {
    const result = parseMarkdownRecords(text, SPEC);
    return { ok: result.ok, found: result.records.length, issues: result.issues.map(({ code, line }) => [code, line]) };
  };
  // a blank line between rows hides the second one from the table
  assert.deepEqual(outside(`${header}${row1}\n${row2}`), { ok: false, found: 1, issues: [['row_outside_table', 5]] });
  // prose between rows
  assert.deepEqual(outside(`${header}${row1}Some prose.\n${row2}`), { ok: false, found: 1, issues: [['row_outside_table', 5]] });
  // a row that lost its leading pipe still carries a marker
  assert.deepEqual(outside(`${header}${row1}${row2.slice(1)}`), { ok: false, found: 1, issues: [['row_outside_table', 4]] });
  // a second table with the same header
  assert.deepEqual(outside(`${header}${row1}\n${header}${row2}`), {
    ok: false, found: 1, issues: [['row_outside_table', 5], ['row_outside_table', 6], ['row_outside_table', 7]],
  });
  // a marker in a paragraph before the table
  assert.deepEqual(outside(`<!-- akrs:record ${ID_2} sha256:${'a'.repeat(64)} -->\n\n${header}${row1}`), {
    ok: false, found: 1, issues: [['row_outside_table', 1]],
  });
  // CRLF input reports the same lines
  assert.deepEqual(outside(`${header}${row1}\n${row2}`.replaceAll('\n', '\r\n')).issues, [['row_outside_table', 5]]);
  // text around the table without rows or markers stays allowed
  assert.equal(outside(`# Title\n\nIntro | pipe.\n\n${header}${row1}${row2}\nClosing words.\n- list\n`).ok, true);
  assert.equal(outside(`${header}${row1}`).ok, true);
});

test('F4 a tampered row is unverified and fails the result without dropping the record', () => {
  const text = table(memory(ID_1)).replace('Use SQLite.', 'Use Postgres.');
  const result = parseMarkdownRecords(text, SPEC);
  assert.equal(result.ok, false);
  assert.equal(result.records[0].state, 'unverified');
  assert.equal(result.records[0].value.text, 'Use Postgres.');
  assert.deepEqual(result.issues.map(({ code, line }) => [code, line]), [['unverified_record', 3]]);
});

test('F4 malformed rows report issues: missing marker, bad id, wrong column count, bad json cell, duplicate id', () => {
  const good = renderMarkdownRecord(memory(ID_1), SPEC);
  const header = renderMarkdownHeader(SPEC);
  const codes = (rows) => parseMarkdownRecords(header + rows, SPEC).issues.map(({ code }) => code);
  assert.deepEqual(codes(good.replace(/ <!-- akrs:record [^>]*-->/, '')), ['missing_marker']);
  assert.deepEqual(codes(good.replace(ID_1, 'not-a-ulid')), ['invalid_marker']);
  assert.deepEqual(codes('| Decided | only two |\n'), ['invalid_row']);
  assert.deepEqual(codes(good.replace('"P1"', 'P1 unquoted')), ['invalid_json', 'unverified_record']);
  assert.deepEqual(codes(good + good), ['duplicate_record_id']);
});

test('F4 rendering is closed and canonical: no CR, NUL, lone surrogates, extra keys, or missing columns', () => {
  assert.throws(() => renderMarkdownRecord(memory(ID_1, { text: 'a\rb' }), SPEC), /carriage return/);
  assert.throws(() => renderMarkdownRecord(memory(ID_1, { text: 'a\u0000b' }), SPEC), /NUL/);
  assert.throws(() => renderMarkdownRecord(memory(ID_1, { text: '\ud800' }), SPEC), /surrogate/);
  assert.throws(() => renderMarkdownRecord(memory(ID_1, { text: 5 }), SPEC), /string/);
  assert.throws(() => renderMarkdownRecord(memory('nope'), SPEC), /id/);
  assert.throws(() => renderMarkdownRecord({ ...memory(ID_1), extra: 1 }, SPEC), /unknown key/);
  const { pointers: _pointers, ...missing } = memory(ID_1);
  assert.throws(() => renderMarkdownRecord(missing, SPEC), /missing key/);
  assert.throws(() => renderMarkdownHeader({ columns: [] }), /spec/);
  assert.throws(() => renderMarkdownHeader({ columns: [{ key: 'a', header: 'A | B', kind: 'text' }] }), /spec/);
  assert.throws(() => renderMarkdownHeader({ columns: [{ key: 'a', header: 'A', kind: 'xml' }] }), /spec/);
  assert.throws(() => renderMarkdownRecord(memory(ID_1, { pointers: 1.5 }), SPEC), TypeError);
  const text = renderMarkdownRecord(memory(ID_1, { text: 'x\r\ny'.replace('\r', '') }), SPEC);
  assert.equal(text.includes('\r'), false);
});

test('F4 a JSON cell is bounded by the strict reader depth, so a written row always parses back', () => {
  const nest = (depth) => {
    let value = 1;
    for (let level = 0; level < depth; level += 1) value = [value];
    return value;
  };
  const row = (value) => renderMarkdownRecord(memory(ID_1, { pointers: value }), SPEC);
  const ok = row(nest(64));
  const parsed = parseMarkdownRecords(renderMarkdownHeader(SPEC) + ok, SPEC);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.issues));
  assert.throws(() => row(nest(65)), /too deep/);
  assert.throws(() => row(nest(5000)), /too deep/);
});
