// The validation-reader API for P1-W13: Memory files parse with the single P1-W01 codec into records that are
// `declared` or `unverified`; Unknown records are exposed (never promoted); prose is never scanned.
import assert from 'node:assert/strict';
import { cp } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  listMemoryFiles, parseMemoryText, readMemory, readMemoryFile, renderMemoryRecord,
} from '../../lib/store/memory/index.js';
import { createTempRepository } from '../helpers/temp-repository.js';
import { HASH_PATTERN, MEMORY_HEADER, createRepo, fixtureJson, memoryRow, seedMemory, submit, assumption, memoryInput, unknown } from './support.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/memory-unknown/repo/', import.meta.url));
const ID = (n) => `01ARZ3NDEKTSV4RRFFQ69G5FA${n}`;

async function fixtureRepo(t) {
  const repository = await createTempRepository(t, { prefix: 'akrs-memory-fixture-' });
  await cp(FIXTURE, repository.root, { recursive: true });
  return { ...repository, options: { repositoryRoot: repository.root, workflowRoot: repository.path('akrs') } };
}

const summary = (record) => ({
  id: record.id, label: record.label, state: record.meta_state, owner_plan: record.owner_plan, decided_by: record.decided_by,
});

test('renderMemoryRecord returns the canonical row and its hash, identical to what the codec marker carries', () => {
  const record = {
    id: ID(0), label: 'Decided', decided_by: 'P1', owner_plan: null, text: 'Use SQLite.', pointers: [{ path: 'src/own.js', lines: null }],
  };
  const { row, hash } = renderMemoryRecord(record);
  assert.equal(row, memoryRow({ id: ID(0), ...record }));
  assert.match(hash, HASH_PATTERN);
  assert.equal(row.includes(` ${hash} --> |\n`), true);
  assert.throws(() => renderMemoryRecord({ ...record, label: 'Fact' }), TypeError, 'an invalid record is never rendered');
  assert.throws(() => renderMemoryRecord({ ...record, text: 'a\r\nb' }), TypeError, 'a stored record is LF only');
});

test('parseMemoryText reads canonical records, tolerates BOM and CRLF, and reports declared with 1-based lines', () => {
  const rows = [
    memoryRow({ id: ID(0), label: 'Decided', decided_by: 'P1', text: 'One.', pointers: [{ path: 'src/own.js', lines: null }] }),
    memoryRow({ id: ID(1), label: 'Unknown', owner_plan: 'P2', text: 'Two\nlines.' }),
  ];
  const text = `# Memory: x\n\n${MEMORY_HEADER}${rows.join('')}`;
  for (const variant of [text, `﻿${text}`, text.replaceAll('\n', '\r\n'), `﻿${text.replaceAll('\n', '\r\n')}`]) {
    const parsed = parseMemoryText(variant);
    assert.equal(parsed.structured, true);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.issues, []);
    assert.deepEqual(parsed.records.map((record) => [record.id, record.line, record.meta_state]), [[ID(0), 5, 'declared'], [ID(1), 6, 'declared']]);
    assert.equal(parsed.records[1].text, 'Two\nlines.');
    assert.match(parsed.records[0].hash, HASH_PATTERN);
    assert.deepEqual(parsed.records[0].issues, []);
  }
});

test('a hash mismatch makes exactly that record unverified; it is still listed and the issue says why', () => {
  const rows = [
    memoryRow({ id: ID(0), label: 'Decided', decided_by: 'P1', text: 'Use SQLite.', pointers: [{ path: 'src/own.js', lines: null }] })
      .replace('Use SQLite.', 'Use Postgres.'),
    memoryRow({ id: ID(1), label: 'Unknown', owner_plan: 'P2', text: 'Open question.' }),
  ];
  const parsed = parseMemoryText(`${MEMORY_HEADER}${rows.join('')}`);
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.records.map(({ meta_state: state }) => state), ['unverified', 'declared']);
  assert.equal(parsed.records[0].text, 'Use Postgres.');
  assert.deepEqual(parsed.records[0].issues.map(({ code }) => code), ['unverified_record']);
  assert.deepEqual(parsed.issues.map(({ code, line }) => [code, line]), [['unverified_record', 3]]);
});

test('a record whose hash verifies but whose content breaks the closed record schema is unverified, with the schema issues', () => {
  const forged = [
    memoryRow({ id: ID(0), label: 'Fact', text: 'A label nobody defined.' }),
    memoryRow({ id: ID(1), label: 'Decided', text: 'Decided with no decider and no pointer.' }),
    memoryRow({ id: ID(2), label: 'Unknown', owner_plan: null, text: 'Unknown with no owner.' }),
  ];
  const parsed = parseMemoryText(`${MEMORY_HEADER}${forged.join('')}`);
  assert.deepEqual(parsed.records.map(({ meta_state: state }) => state), ['unverified', 'unverified', 'unverified']);
  for (const record of parsed.records) {
    assert.equal(record.issues.length > 0, true);
    assert.equal(record.issues.every(({ code }) => code === 'schema_violation'), true);
    assert.equal(record.issues.every(({ pointer }) => typeof pointer === 'string' && pointer.startsWith('/')), true);
  }
  assert.deepEqual(parsed.records[0].issues.map(({ pointer }) => pointer), ['/label']);
});

test('no prose scanning: a file without the canonical table has no records, however much it looks like Memory', () => {
  const prose = [
    '# Model memory', '',
    '- Re-deriving it at a 99% precision target is optional work.',
    '  **Unknown** whether it will be done before the defense.',
    '- Assumption (High): the export runs nightly.',
    '- Decided: use SQLite.', '',
    'Unknown: who owns the retention policy.', '',
    '| Label | Text |', '|---|---|', '| Unknown | a hand-made table with another header |', '',
  ].join('\n');
  const parsed = parseMemoryText(prose);
  assert.equal(parsed.structured, false);
  assert.deepEqual(parsed.records, []);
  assert.deepEqual(parsed.issues.map(({ code }) => code), ['missing_header']);
});

test('prose around the canonical table is ignored too: only table rows are records', () => {
  const row = memoryRow({ id: ID(0), label: 'Unknown', owner_plan: 'P1', text: 'Open.' });
  const text = `# Memory\n\nUnknown: this line is prose.\n**Decided** this sentence is prose.\n\n${MEMORY_HEADER}${row}\nAssumption (Low): trailing prose.\n`;
  const parsed = parseMemoryText(text);
  assert.equal(parsed.structured, true);
  assert.deepEqual(parsed.records.map(({ id }) => id), [ID(0)]);
});

test('rows the codec cannot place are issues, never silently dropped records', () => {
  const row = memoryRow({ id: ID(0), label: 'Unknown', owner_plan: 'P1', text: 'Open.' });
  const second = memoryRow({ id: ID(1), label: 'Unknown', owner_plan: 'P1', text: 'Second.' });
  const parsed = parseMemoryText(`${MEMORY_HEADER}${row}\n${second}`);
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.issues.map(({ code }) => code), ['row_outside_table']);
  assert.deepEqual(parsed.records.map(({ id }) => id), [ID(0)]);
});

test('the committed fixture: Unknown records are visible with their owner Plan and never promoted to facts', async (t) => {
  const repo = await fixtureRepo(t);
  const expected = await fixtureJson('expected.json');
  const memory = await readMemory(repo.options);
  assert.deepEqual(memory.unknown.map(summary), expected.unknown);
  assert.deepEqual(memory.facts.map(summary), expected.facts);
  assert.equal(memory.facts.some(({ label }) => label === 'Unknown'), false, 'an Unknown is never a fact');
  assert.equal(memory.facts.every(({ meta_state: state }) => state === 'declared'), true);
  assert.deepEqual(memory.unverified.map(summary), expected.unverified);
  assert.deepEqual(memory.records.map(({ id }) => id).sort(), expected.record_ids);
  assert.deepEqual(memory.files.map(({ topic, structured, records }) => [topic, structured, records.length]), expected.files);
});

test('a tampered Unknown stays visible as an unverified Unknown: tampering cannot resolve or hide it', async (t) => {
  const repo = await fixtureRepo(t);
  const file = await readMemoryFile({ ...repo.options, topic: 'tampered' });
  const [first, second] = file.records;
  assert.deepEqual([first.label, first.meta_state, first.owner_plan], ['Unknown', 'unverified', 'P3']);
  assert.equal(first.text.endsWith('is settled: yes.'), true, 'the tampered text is reported as it is, never trusted');
  assert.deepEqual([second.label, second.meta_state], ['Decided', 'declared']);
  const memory = await readMemory(repo.options);
  assert.equal(memory.unknown.some(({ id }) => id === first.id), true);
  assert.equal(memory.facts.some(({ id }) => id === first.id), false);
});

test('the legacy prose file is reported as unstructured with zero records: no Unknown is invented from prose', async (t) => {
  const repo = await fixtureRepo(t);
  const file = await readMemoryFile({ ...repo.options, topic: 'legacy-prose' });
  assert.equal(file.structured, false);
  assert.deepEqual(file.records, []);
  assert.deepEqual(file.issues.map(({ code }) => code), ['missing_header']);
  assert.equal((await readMemory(repo.options)).unknown.every(({ topic }) => topic !== 'legacy-prose'), true);
});

test('readMemoryFile: null for a topic without a file; a bad topic is a TypeError; paths and topics are reported', async (t) => {
  const repo = await fixtureRepo(t);
  assert.equal(await readMemoryFile({ ...repo.options, topic: 'nothing-here' }), null);
  await assert.rejects(() => readMemoryFile({ ...repo.options, topic: '../x' }), TypeError);
  const file = await readMemoryFile({ ...repo.options, topic: 'use-cases' });
  assert.equal(file.topic, 'use-cases');
  assert.equal(file.path, 'akrs/memory/use-cases.md');
  assert.deepEqual(file.records.map(({ topic, path }) => [topic, path]), Array(3).fill(['use-cases', 'akrs/memory/use-cases.md']));
});

test('listMemoryFiles is sorted and covers top-level markdown files only; an empty workflow has none', async (t) => {
  const repo = await fixtureRepo(t);
  assert.deepEqual((await listMemoryFiles(repo.options)).map(({ topic, path, workflow_path: workflowPath }) => [topic, path, workflowPath]), [
    ['legacy-prose', 'akrs/memory/legacy-prose.md', 'memory/legacy-prose.md'],
    ['tampered', 'akrs/memory/tampered.md', 'memory/tampered.md'],
    ['use-cases', 'akrs/memory/use-cases.md', 'memory/use-cases.md'],
  ]);
  await repo.write('akrs/memory/notes.txt', 'not markdown');
  await repo.write('akrs/memory/nested/deep.md', 'nested');
  assert.equal((await listMemoryFiles(repo.options)).length, 3);
  const empty = await createRepo(t);
  assert.deepEqual(await listMemoryFiles(empty.options), []);
  const memory = await readMemory(empty.options);
  assert.deepEqual([memory.files, memory.records, memory.facts, memory.unknown, memory.unverified, memory.issues], [[], [], [], [], [], []]);
});

test('a binary or non-UTF-8 Memory file is reported as unreadable, not guessed at', async (t) => {
  const repo = await createRepo(t);
  await repo.write('akrs/memory/bad.md', Buffer.from([0xff, 0xfe, 0x00]));
  const file = await readMemoryFile({ ...repo.options, topic: 'bad' });
  assert.equal(file.structured, false);
  assert.deepEqual(file.records, []);
  assert.deepEqual(file.issues.map(({ code }) => code), ['not_text']);
});

test('what the writer wrote is what the reader reads: declared records in file order, Unknown visible and unpromoted', async (t) => {
  const repo = await createRepo(t);
  await submit(repo, memoryInput());
  await submit(repo, unknown({ text: 'Do refunds reverse the paid state?' }));
  await submit(repo, assumption('Med'));
  const memory = await readMemory(repo.options);
  assert.deepEqual(memory.records.map(({ label }) => label), ['Decided', 'Unknown', 'Assumption Med']);
  assert.deepEqual(memory.unknown.map(({ owner_plan: owner }) => owner), ['P6']);
  assert.deepEqual(memory.facts.map(({ label }) => label), ['Decided', 'Assumption Med']);
  assert.equal(memory.records.every(({ meta_state: state }) => state === 'declared'), true);
  assert.deepEqual(memory.issues, []);
});

test('hand-appended rows in the same syntax are read like any other; a hand-written record without a valid hash is unverified', async (t) => {
  const repo = await createRepo(t);
  await seedMemory(repo, 'notes', [
    memoryRow({ id: ID(0), label: 'Unknown', owner_plan: 'P1', text: 'Open.' }),
    `| Unknown | null | "P1" | Hand written, no marker. | [] |\n`,
  ]);
  const file = await readMemoryFile({ ...repo.options, topic: 'notes' });
  assert.deepEqual(file.records.map(({ id }) => id), [ID(0)]);
  assert.deepEqual(file.issues.map(({ code }) => code), ['missing_marker']);
});
