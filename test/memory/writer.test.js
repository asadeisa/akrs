import assert from 'node:assert/strict';
import { readFile, readdir, symlink } from 'node:fs/promises';
import { test } from 'node:test';
import { MEMORY_RECORD_SPEC } from '../../lib/schemas/memory.js';
import { buildTemplate, findMissingInputs } from '../../lib/schemas/templates.js';
import { validateMutationChanges, validateReadOnlyPacket } from '../../lib/schemas/packet.js';
import { parseMarkdownRecords } from '../../lib/store/canonical/index.js';
import { commandSnapshot } from '../../lib/store/snapshots/index.js';
import { readMemoryFile } from '../../lib/store/memory/index.js';
import {
  HASH_PATTERN, MEMORY_HEADER, ULID_PATTERN, assertFindingsMatchCatalog, assumption, codesOf, createRepo, draftDocument, everything,
  fakeProviders, fixtureJson, fixtureNames, fromFile, listFiles, memoryInput, memoryRow, pointersOf, seedMemory, strict, submit,
  treeDigest, unknown,
} from './support.js';

const MEMORY_FILE = 'akrs/memory/payments.md';
const expectedRow = (input, id) => memoryRow({
  id, label: input.label, decided_by: input.decided_by, owner_plan: input.owner_plan, text: input.text, pointers: input.pointers,
});

// ---- creating and appending ----------------------------------------------------------------------------------
test('the first record of a topic creates memory/<topic>.md: canonical header, then exactly one canonical row', async (t) => {
  const repo = await createRepo(t);
  const input = memoryInput();
  const before = await listFiles(repo.root);
  const result = await submit(repo, input);
  assert.equal(result.outcome, 'committed');
  const { packet } = result;
  assert.equal(packet.status, 'ok');
  assert.equal(packet.command, 'memory-add');
  assert.match(packet.request_id, ULID_PATTERN);
  assert.deepEqual(packet.changed, ['memory/payments.md']);
  assert.deepEqual(packet.findings, []);
  const { record } = packet.data;
  assert.equal(packet.data.kind, 'memory_add');
  assert.equal(packet.data.dry_run, false);
  assert.equal(packet.data.draft, null);
  assert.match(record.id, ULID_PATTERN);
  assert.match(record.hash, HASH_PATTERN);
  assert.deepEqual(
    { ...record, id: null, hash: null },
    { id: null, topic: 'payments', label: 'Decided', path: MEMORY_FILE, line: 5, hash: null, meta_state: 'declared' },
  );
  const text = await repo.read(MEMORY_FILE);
  assert.equal(text, `# Memory: payments\n\n${MEMORY_HEADER}${expectedRow(input, record.id)}`);
  assert.equal(text.endsWith(`${record.hash} --> |\n`), true, 'the packet hash is the hash marker of the row');
  const parsed = parseMarkdownRecords(text, MEMORY_RECORD_SPEC);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.records.map(({ line, state }) => [line, state]), [[5, 'declared']]);
  assert.deepEqual(parsed.records[0].value, {
    id: record.id, label: 'Decided', decided_by: 'P6', owner_plan: null, text: input.text, pointers: input.pointers,
  });
  const after = (await listFiles(repo.root)).filter((name) => !name.startsWith('akrs/.ops/'));
  assert.deepEqual(after, [...before, MEMORY_FILE].sort());
  assert.equal(validateMutationChanges(packet, ['memory/payments.md']).ok, true);
  assert.notEqual(packet.snapshot.before, packet.snapshot.after);
});

test('a second record appends exactly one row and leaves every earlier byte alone; another topic is another file', async (t) => {
  const repo = await createRepo(t);
  const first = await submit(repo, memoryInput());
  const afterFirst = await repo.read(MEMORY_FILE);
  const secondInput = assumption('Low', { text: 'Settlement events arrive in order.' });
  const second = await submit(repo, secondInput);
  assert.equal(second.outcome, 'committed');
  assert.deepEqual(second.packet.changed, ['memory/payments.md']);
  assert.equal(second.packet.data.record.line, 6);
  const text = await repo.read(MEMORY_FILE);
  assert.equal(text, `${afterFirst}${expectedRow(secondInput, second.packet.data.record.id)}`);
  assert.notEqual(second.packet.data.record.id, first.packet.data.record.id);

  const other = await submit(repo, memoryInput({ topic: 'ui', text: 'The admin page lists reservations.' }));
  assert.deepEqual(other.packet.changed, ['memory/ui.md']);
  assert.equal(await repo.read(MEMORY_FILE), text, 'the first topic file is untouched');
  assert.deepEqual((await readdir(repo.path('akrs/memory'))).sort(), ['payments.md', 'ui.md']);
});

test('every frozen label round-trips through the writer and back through the reader without loss or invention', async (t) => {
  const repo = await createRepo(t);
  const inputs = [memoryInput(), assumption('High'), assumption('Med'), assumption('Low'), unknown()];
  for (const input of inputs) assert.equal((await submit(repo, input)).outcome, 'committed', input.label);
  const file = await readMemoryFile({ ...repo.options, topic: 'payments' });
  assert.deepEqual(file.records.map(({ label }) => label), inputs.map(({ label }) => label));
  file.records.forEach((record, index) => {
    const { schema, topic, ...expected } = inputs[index];
    assert.deepEqual({
      label: record.label, decided_by: record.decided_by, owner_plan: record.owner_plan, text: record.text, pointers: record.pointers,
    }, expected, inputs[index].label);
    assert.equal(record.meta_state, 'declared');
  });
});

test('every valid fixture input is accepted', async (t) => {
  for (const name of await fixtureNames('valid')) {
    const repo = await createRepo(t, { files: { 'SOT/04-use-cases.md': 'line\n'.repeat(20) } });
    const result = await submit(repo, await fixtureJson(`valid/${name}.json`));
    assert.equal(result.outcome, 'committed', name);
  }
});

test('a submitted id or hash is refused: the CLI owns record identity', async (t) => {
  const repo = await createRepo(t);
  const before = await strict(repo);
  const result = await submit(repo, { ...memoryInput(), id: '01ARZ3NDEKTSV4RRFFQ69G5FA0' });
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(pointersOf(result.packet), ['/id']);
  assert.equal(await strict(repo), before);
});

// ---- write-time validation: labels, owners, pointers, nothing written ------------------------------------------
const invalidNames = await fixtureNames('invalid');

test('there are enough invalid fixtures to mean something', () => {
  assert.equal(invalidNames.length >= 30, true);
});

for (const name of invalidNames) {
  test(`invalid fixture ${name}: rejected with JSON pointers, usage kind, byte tree unchanged`, async (t) => {
    const repo = await createRepo(t, { files: { 'SOT/04-use-cases.md': 'line\n'.repeat(20) } });
    const { document, expect } = await fixtureJson(`invalid/${name}.json`);
    const before = await strict(repo);
    const result = await submit(repo, document);
    assert.equal(result.outcome, 'rejected');
    const { packet } = result;
    assert.equal(packet.status, 'error');
    assert.equal(packet.data.kind, 'usage');
    assert.equal(packet.data.reason, 'invalid_input');
    assert.deepEqual(codesOf(packet), ['AKRS-M001']);
    assert.deepEqual(pointersOf(packet), [...expect.map(({ pointer }) => pointer)].sort());
    assert.equal(packet.changed.length, 0);
    assertFindingsMatchCatalog(packet);
    assert.equal(await strict(repo), before, 'the byte tree is unchanged, .ops included');
  });
}

test('an unfilled memory template is rejected and the packet names the exact missing inputs', async (t) => {
  const repo = await createRepo(t);
  const skeleton = buildTemplate('memory').skeleton;
  const before = await strict(repo);
  const result = await submit(repo, skeleton);
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(result.packet.data.missing_inputs, findMissingInputs('memory', skeleton));
  assert.equal(result.packet.data.missing_inputs.length > 0, true);
  assert.equal(result.packet.next_commands.some(({ command, args }) => command === 'template' && args.join(' ') === 'memory'), true);
  assert.equal(await strict(repo), before);
});

test('every problem of one document is reported at once with its own pointer', async (t) => {
  const repo = await createRepo(t);
  const result = await submit(repo, { ...memoryInput(), label: 'Fact', text: '  ', pointers: [{ path: '/etc/passwd', lines: null }] });
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(pointersOf(result.packet), ['/label', '/pointers/0/path', '/text']);
});

// ---- pointers resolve through the path service ------------------------------------------------------------------
test('a pointer must exist; windows must fit: every unresolved pointer is an M002 finding and nothing is written', async (t) => {
  const repo = await createRepo(t, { files: { 'bin/data.bin': Buffer.from([0, 1, 2]) } });
  const before = await everything(repo);
  const cases = [
    [{ path: 'SOT/99-missing.md', lines: [1, 2] }, 'missing', '/pointers/1/path'],
    [{ path: 'SOT/99-missing.md', lines: null }, 'missing', '/pointers/1/path'],
    [{ path: 'SOT', lines: [1, 2] }, 'not_file', '/pointers/1/path'],
    [{ path: 'SOT/09-use-cases.md', lines: [48, 51] }, 'out_of_range', '/pointers/1/lines'],
    [{ path: 'SOT/09-use-cases.md', lines: [51, 52] }, 'out_of_range', '/pointers/1/lines'],
    [{ path: 'bin/data.bin', lines: [1, 1] }, 'not_text', '/pointers/1/path'],
    [{ path: 'sot/09-use-cases.md', lines: [1, 2] }, 'case_mismatch', '/pointers/1/path'],
    [{ path: 'Sot', lines: null }, 'case_mismatch', '/pointers/1/path'],
  ];
  for (const [pointer, reason, at] of cases) {
    const result = await submit(repo, memoryInput({ pointers: [{ path: 'SOT/02-rules.md', lines: [1, 2] }, pointer] }));
    assert.equal(result.outcome, 'rejected', `${reason} ${JSON.stringify(pointer)}`);
    assert.equal(result.packet.status, 'error');
    assert.equal(result.packet.data.kind, 'findings');
    assert.deepEqual(codesOf(result.packet), ['AKRS-M002'], reason);
    assert.deepEqual(pointersOf(result.packet), [at], reason);
    const { detail } = result.packet.findings[0];
    assert.equal(detail.reason, reason);
    assert.equal(detail.path, pointer.path);
    assert.match(result.packet.findings[0].message, new RegExp(`\\(at ${at}\\)`));
    assertFindingsMatchCatalog(result.packet);
  }
  assert.equal(await everything(repo), before);
});

test('a whole-directory pointer and a whole-file pointer are fine; windows may end exactly on the last line', async (t) => {
  const repo = await createRepo(t);
  const result = await submit(repo, memoryInput({
    pointers: [{ path: 'SOT', lines: null }, { path: 'src/own.js', lines: null }, { path: 'SOT/09-use-cases.md', lines: [50, 50] }],
  }));
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(result.packet.findings, []);
});

test('a pointer that escapes the repository through a link is refused as unsafe', async (t) => {
  const repo = await createRepo(t);
  const outside = await createRepo(t);
  await outside.write('secret.txt', 'secret\n');
  try {
    await symlink(outside.root, repo.path('escape'), 'dir');
  } catch {
    t.skip('this file system cannot create directory links');
    return;
  }
  const before = await everything(repo);
  const result = await submit(repo, memoryInput({ pointers: [{ path: 'escape/secret.txt', lines: null }] }));
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(codesOf(result.packet), ['AKRS-M002']);
  assert.equal(result.packet.findings[0].detail.reason, 'unsafe');
  assert.equal(await everything(repo), before);
});

test('pointers are not required for an Unknown and may not be given for one; both fail before any file is read', async (t) => {
  const repo = await createRepo(t);
  assert.equal((await submit(repo, unknown())).outcome, 'committed');
  const bad = await submit(repo, unknown({ pointers: [{ path: 'SOT/99-missing.md', lines: null }] }));
  assert.equal(bad.outcome, 'rejected');
  assert.deepEqual(codesOf(bad.packet), ['AKRS-M001'], 'the schema stage rejects it, no path is resolved');
});

// ---- free Unicode and narrative text ---------------------------------------------------------------------------
const NARRATIVES = {
  arabic: 'تُشتق حالة الدفع من حدث التسوية، وليس من حقل الواجهة.',
  cjk: '支付状态由结算事件决定。決済の状態は決済イベントから導かれる。결제 상태는 정산 이벤트에서 결정된다.',
  emoji: 'Ship it \u{1F680} \u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466} \u{1F1EF}\u{1F1F4} ❤️',
  'rtl-marks': 'Total ‏123‎ units ‫مرحبا‬ and ⁧اختبار⁩ end‏',
  combining: 'é vs é, اً, नि, zero​width⁠joiner',
  'markdown-hostile': 'a | b \\ c \\\\ d <br> e <!-- akrs:record 01ARZ3NDEKTSV4RRFFQ69G5FA0 sha256:00 --> f \\| g `code` **bold** | last',
  'edge-spaces': '  leading and trailing spaces  ',
  multiline: 'line one\nline two\n\nline four after a blank line\n',
  'line-separators': 'before after end \u0085 \u000b \u000c',
  tabs: 'col1\tcol2\t\tcol4',
  long: `${'A long narrative sentence with عربي and 中文. '.repeat(400)}`,
};

for (const [name, text] of Object.entries(NARRATIVES)) {
  test(`free text round-trips byte for byte: ${name}`, async (t) => {
    const repo = await createRepo(t);
    const result = await submit(repo, memoryInput({ text }));
    assert.equal(result.outcome, 'committed');
    const file = await readMemoryFile({ ...repo.options, topic: 'payments' });
    assert.equal(file.records.length, 1);
    assert.equal(file.records[0].text, text, 'the stored text equals the submitted text');
    assert.equal(file.records[0].meta_state, 'declared');
    const bytes = await readFile(repo.path(MEMORY_FILE));
    assert.equal(bytes.toString('utf8').includes('\r'), false, 'LF only');
    assert.equal(Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes), true, 'valid UTF-8');
    assert.equal(bytes.toString('utf8').endsWith('\n'), true);
    const rows = bytes.toString('utf8').split('\n').filter((line) => line.startsWith('|'));
    assert.equal(rows.length, 3, 'one header row, one separator, one record row: the text never adds a table line');
  });
}

test('Unicode pointer paths (NFC) resolve; the stored pointer is exactly what was submitted', async (t) => {
  const path = 'SOT/حجز-预约.md';
  const repo = await createRepo(t, { files: { [path]: 'one\ntwo\nthree\n' } });
  const result = await submit(repo, memoryInput({ pointers: [{ path, lines: [2, 3] }] }));
  assert.equal(result.outcome, 'committed');
  const file = await readMemoryFile({ ...repo.options, topic: 'payments' });
  assert.deepEqual(file.records[0].pointers, [{ path, lines: [2, 3] }]);
});

test('CRLF and lone CR inside the narrative become LF (Q4/Q5); BOM and CRLF around the JSON are tolerated', async (t) => {
  const repo = await createRepo(t);
  const result = await submit(repo, memoryInput({ text: 'one\r\ntwo\rthree\nfour' }));
  assert.equal(result.outcome, 'committed');
  assert.equal((await readMemoryFile({ ...repo.options, topic: 'payments' })).records[0].text, 'one\ntwo\nthree\nfour');
  assert.equal((await repo.read(MEMORY_FILE)).includes('\r'), false);

  const plain = await createRepo(t);
  const messy = await createRepo(t);
  const body = JSON.stringify(memoryInput(), null, 2);
  await submit(plain, body, { providers: fakeProviders() });
  await submit(messy, `﻿${body.replaceAll('\n', '\r\n')}`, { providers: fakeProviders() });
  assert.equal(await messy.read(MEMORY_FILE), await plain.read(MEMORY_FILE));

  // the LF and CRLF spellings of the same text are one request: the second is a duplicate
  const same = await createRepo(t);
  assert.equal((await submit(same, memoryInput({ text: 'a\nb' }))).outcome, 'committed');
  assert.equal((await submit(same, memoryInput({ text: 'a\r\nb' }))).outcome, 'replayed');
});

test('text with a NUL, a lone surrogate or an embedded data URI is refused before anything is written', async (t) => {
  const repo = await createRepo(t);
  const before = await strict(repo);
  for (const text of ['bad\u0000text', `data:image/png;base64,${'A'.repeat(40)}`, `${'QUJD'.repeat(200)}`]) {
    const result = await submit(repo, memoryInput({ text }));
    assert.equal(result.outcome, 'rejected');
    assert.deepEqual(pointersOf(result.packet), ['/text']);
  }
  const lone = await submit(repo, '{"schema":"akrs.memory-input/v1","topic":"payments","label":"Unknown","decided_by":null,"owner_plan":"P6","text":"x\\ud800y","pointers":[]}');
  assert.equal(lone.outcome, 'rejected');
  assert.equal(await strict(repo), before);
});

// ---- the topic file ----------------------------------------------------------------------------------------------
test('an existing file of canonical records is appended to: earlier bytes (hand-edited or tampered ones too) are never rewritten', async (t) => {
  const repo = await createRepo(t);
  const old = memoryRow({ id: '01ARZ3NDEKTSV4RRFFQ69G5FA0', label: 'Decided', decided_by: 'P1', text: 'Original.', pointers: [{ path: 'src/own.js', lines: null }] });
  const tampered = memoryRow({ id: '01ARZ3NDEKTSV4RRFFQ69G5FA1', label: 'Unknown', owner_plan: 'P1', text: 'Still open.' }).replace('Still open.', 'Closed.');
  await seedMemory(repo, 'payments', [old, tampered]);
  const before = await repo.read(MEMORY_FILE);
  const result = await submit(repo, memoryInput());
  assert.equal(result.outcome, 'committed');
  const after = await repo.read(MEMORY_FILE);
  assert.equal(after.startsWith(before), true, 'a pure append');
  assert.equal(after.slice(before.length), expectedRow(memoryInput(), result.packet.data.record.id));
  assert.equal(result.packet.data.record.line, 7);
  const file = await readMemoryFile({ ...repo.options, topic: 'payments' });
  assert.deepEqual(file.records.map(({ meta_state: state }) => state), ['declared', 'unverified', 'declared']);
});

test('a file without a final newline gets one before the new row', async (t) => {
  const repo = await createRepo(t);
  const old = memoryRow({ id: '01ARZ3NDEKTSV4RRFFQ69G5FA0', label: 'Unknown', owner_plan: 'P1', text: 'Open.' });
  await repo.write(MEMORY_FILE, `# Memory: payments\n\n${MEMORY_HEADER}${old.trimEnd()}`);
  const result = await submit(repo, memoryInput());
  assert.equal(result.outcome, 'committed');
  assert.equal(await repo.read(MEMORY_FILE), `# Memory: payments\n\n${MEMORY_HEADER}${old}${expectedRow(memoryInput(), result.packet.data.record.id)}`);
});

test('an existing prose file keeps its prose byte for byte; the table is added after it and prose is never read as records', async (t) => {
  const repo = await createRepo(t);
  const prose = '# Payments memory\n\n- **Unknown** whether refunds reverse the paid state.\n- Assumption (High): the export runs nightly.\n';
  await repo.write(MEMORY_FILE, prose);
  const result = await submit(repo, memoryInput());
  assert.equal(result.outcome, 'committed');
  const text = await repo.read(MEMORY_FILE);
  assert.equal(text.startsWith(prose), true, 'the prose is preserved');
  assert.equal(text, `${prose}\n${MEMORY_HEADER}${expectedRow(memoryInput(), result.packet.data.record.id)}`);
  const file = await readMemoryFile({ ...repo.options, topic: 'payments' });
  assert.deepEqual(file.records.map(({ id }) => id), [result.packet.data.record.id], 'only the canonical record exists');
  assert.equal(result.packet.data.record.line, 8);
  assert.equal(file.records[0].line, 8);
  // and a prose file without a final newline, and an empty file
  const bare = await createRepo(t);
  await bare.write(MEMORY_FILE, 'No newline at the end');
  const done = await submit(bare, memoryInput());
  assert.equal(await bare.read(MEMORY_FILE), `No newline at the end\n\n${MEMORY_HEADER}${expectedRow(memoryInput(), done.packet.data.record.id)}`);
  const empty = await createRepo(t);
  await empty.write(MEMORY_FILE, '');
  const first = await submit(empty, memoryInput());
  assert.equal(first.outcome, 'committed');
  assert.equal(await empty.read(MEMORY_FILE), `${MEMORY_HEADER}${expectedRow(memoryInput(), first.packet.data.record.id)}`);
  assert.equal(first.packet.data.record.line, 3);
});

test('a table that is not the last thing in the file cannot take a row: M003 table_not_last, nothing written', async (t) => {
  const repo = await createRepo(t);
  const row = memoryRow({ id: '01ARZ3NDEKTSV4RRFFQ69G5FA0', label: 'Unknown', owner_plan: 'P1', text: 'Open.' });
  for (const tail of ['\nTrailing prose.\n', '\n', '\n\n']) {
    await repo.write(MEMORY_FILE, `# Memory: payments\n\n${MEMORY_HEADER}${row}${tail}`);
    const before = await everything(repo);
    const result = await submit(repo, memoryInput());
    assert.equal(result.outcome, 'rejected', JSON.stringify(tail));
    assert.equal(result.packet.data.kind, 'findings');
    assert.deepEqual(codesOf(result.packet), ['AKRS-M003']);
    assert.equal(result.packet.findings[0].detail.reason, 'table_not_last');
    assert.equal(result.packet.findings[0].detail.topic, 'payments');
    assert.equal(result.packet.findings[0].detail.path, MEMORY_FILE);
    assert.equal(result.packet.findings[0].file, MEMORY_FILE);
    assertFindingsMatchCatalog(result.packet);
    assert.equal(await everything(repo), before);
  }
});

test('a topic file that differs in case, is a directory or is binary is refused with M003', async (t) => {
  const cased = await createRepo(t);
  await cased.write('akrs/memory/Payments.md', 'prose\n');
  const clash = await submit(cased, memoryInput());
  assert.equal(clash.outcome, 'rejected');
  assert.deepEqual(codesOf(clash.packet), ['AKRS-M003']);
  assert.equal(clash.packet.findings[0].detail.reason, 'case_mismatch');
  assert.deepEqual(pointersOf(clash.packet), ['/topic']);

  const directory = await createRepo(t);
  await directory.write('akrs/memory/payments.md/inner.txt', 'x');
  const notFile = await submit(directory, memoryInput());
  assert.equal(notFile.outcome, 'rejected');
  assert.equal(notFile.packet.findings[0].detail.reason, 'not_file');

  const binary = await createRepo(t);
  await binary.write(MEMORY_FILE, Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  const before = await everything(binary);
  const notText = await submit(binary, memoryInput());
  assert.equal(notText.outcome, 'rejected');
  assert.equal(notText.packet.findings[0].detail.reason, 'not_text');
  assert.equal(await everything(binary), before);
  for (const packet of [clash.packet, notFile.packet, notText.packet]) assertFindingsMatchCatalog(packet);
});

test('M002 and M003 findings are all reported together, in one deterministic order', async (t) => {
  const repo = await createRepo(t);
  const row = memoryRow({ id: '01ARZ3NDEKTSV4RRFFQ69G5FA0', label: 'Unknown', owner_plan: 'P1', text: 'Open.' });
  await repo.write(MEMORY_FILE, `${MEMORY_HEADER}${row}\nprose after the table\n`);
  const input = memoryInput({ pointers: [{ path: 'SOT/99-missing.md', lines: null }] });
  const first = await submit(repo, input);
  assert.deepEqual(codesOf(first.packet), ['AKRS-M002', 'AKRS-M003']);
  const again = await submit(repo, input);
  assert.deepEqual(again.packet.findings, first.packet.findings);
});

// ---- idempotency, duplicates, --again ---------------------------------------------------------------------------
test('the same request again is a noop replay of the original packet and appends nothing', async (t) => {
  const repo = await createRepo(t);
  const providers = fakeProviders();
  const first = await submit(repo, memoryInput(), { providers });
  assert.equal(first.outcome, 'committed');
  const after = await everything(repo);
  const second = await submit(repo, memoryInput(), { providers });
  assert.equal(second.outcome, 'replayed');
  assert.equal(second.packet.status, 'noop');
  assert.equal(second.packet.request_id, first.packet.request_id);
  assert.deepEqual(second.packet.changed, []);
  assert.deepEqual(second.packet.data.record, first.packet.data.record);
  assert.equal(validateReadOnlyPacket(second.packet).ok, true);
  assert.equal(await everything(repo), after);
  assert.equal((await repo.read(MEMORY_FILE)).split('\n').filter((line) => line.includes('akrs:record')).length, 1);
});

test('a retry with the caller-supplied request ID of the committed operation is a noop; a different input under it conflicts', async (t) => {
  const repo = await createRepo(t);
  const providers = fakeProviders();
  const requestId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  assert.equal((await submit(repo, memoryInput(), { providers, requestId })).outcome, 'committed');
  const after = await everything(repo);
  const retry = await submit(repo, memoryInput(), { providers, requestId });
  assert.equal(retry.outcome, 'replayed');
  assert.equal(retry.packet.request_id, requestId);
  assert.equal(await everything(repo), after);
  const conflict = await submit(repo, memoryInput({ text: 'Something else entirely.' }), { providers, requestId });
  assert.equal(conflict.outcome, 'conflict');
  assert.deepEqual(codesOf(conflict.packet), ['AKRS-C010']);
  assert.equal(await everything(repo), after);
});

test('an invalid request ID is a usage error and consumes nothing', async (t) => {
  const repo = await createRepo(t);
  const before = await strict(repo);
  const result = await submit(repo, memoryInput(), { requestId: 'not-a-ulid' });
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.packet.data.reason, 'invalid_request_id');
  assert.equal(await strict(repo), before);
});

test('an exact duplicate is a noop that offers the same command with --again; --again appends a deliberate duplicate', async (t) => {
  const repo = await createRepo(t);
  const providers = fakeProviders();
  const first = await submit(repo, memoryInput(), { providers });
  await submit(repo, assumption('Med'), { providers }); // the projection moves on; an exact duplicate is still a duplicate
  const afterTwo = await everything(repo);
  const duplicate = await submit(repo, memoryInput(), { providers, rootArgs: ['--root', repo.root] });
  assert.equal(duplicate.outcome, 'replayed');
  assert.equal(duplicate.packet.status, 'noop');
  assert.equal(duplicate.packet.request_id, first.packet.request_id);
  assert.deepEqual(duplicate.packet.changed, []);
  assert.equal(await everything(repo), afterTwo);
  const offer = duplicate.packet.next_commands.find(({ command, args }) => command === 'memory-add' && args.includes('--again'));
  assert.deepEqual(offer, { command: 'memory-add', args: ['--json', '-', '--again', '--root', repo.root] });

  const again = await submit(repo, memoryInput(), { providers, again: true });
  assert.equal(again.outcome, 'committed');
  assert.equal(again.packet.status, 'ok');
  assert.notEqual(again.packet.request_id, first.packet.request_id);
  assert.notEqual(again.packet.data.record.id, first.packet.data.record.id);
  const file = await readMemoryFile({ ...repo.options, topic: 'payments' });
  assert.deepEqual(file.records.map(({ text }) => text), [memoryInput().text, assumption('Med').text, memoryInput().text]);
  // the deliberate duplicate does not hide or replace the original: a plain repeat is still a duplicate
  assert.equal((await submit(repo, memoryInput(), { providers })).outcome, 'replayed');
  assert.equal((await readMemoryFile({ ...repo.options, topic: 'payments' })).records.length, 3);
});

test('the --again offer for a file input names that file; a different text or topic is not a duplicate', async (t) => {
  const repo = await createRepo(t);
  assert.equal((await submit(repo, memoryInput())).outcome, 'committed');
  await draftDocument(repo, 'dup', memoryInput());
  const duplicate = await fromFile(repo, 'akrs/drafts/dup.json');
  assert.equal(duplicate.outcome, 'replayed');
  assert.deepEqual(duplicate.packet.next_commands.find(({ args }) => args.includes('--again')), {
    command: 'memory-add', args: ['--input', 'akrs/drafts/dup.json', '--again'],
  });
  assert.equal((await repo.read('akrs/drafts/dup.json')).includes('settlement'), true, 'a noop never consumes the draft');
  assert.equal((await submit(repo, memoryInput({ text: `${memoryInput().text} Also.` }))).outcome, 'committed');
  assert.equal((await submit(repo, memoryInput({ topic: 'billing' }))).outcome, 'committed');
  assert.equal((await submit(repo, memoryInput({ pointers: [{ path: 'SOT/09-use-cases.md', lines: [28, 42] }] }))).outcome, 'committed');
});

test('two legitimate different appends both land', async (t) => {
  const repo = await createRepo(t);
  const providers = fakeProviders();
  assert.equal((await submit(repo, memoryInput(), { providers })).outcome, 'committed');
  assert.equal((await submit(repo, memoryInput({ text: 'A second decision.' }), { providers })).outcome, 'committed');
  assert.equal((await readMemoryFile({ ...repo.options, topic: 'payments' })).records.length, 2);
});

// ---- dry run, snapshots -----------------------------------------------------------------------------------------
test('--dry-run reports the record that would be written and touches nothing, the journal included', async (t) => {
  const repo = await createRepo(t);
  const before = await strict(repo);
  const providers = fakeProviders();
  const result = await submit(repo, memoryInput(), { dryRun: true, providers });
  assert.equal(result.outcome, 'dry_run');
  const { packet } = result;
  assert.equal(packet.status, 'ok');
  assert.equal(packet.request_id, null);
  assert.deepEqual(packet.changed, []);
  assert.equal(packet.data.dry_run, true);
  assert.deepEqual(packet.data.would_change, ['memory/payments.md']);
  assert.deepEqual(packet.data.record, {
    id: null, topic: 'payments', label: 'Decided', path: MEMORY_FILE, line: 5, hash: null, meta_state: 'declared',
  });
  assert.deepEqual(packet.data.proposed, {
    label: 'Decided', decided_by: 'P6', owner_plan: null, text: memoryInput().text, pointers: memoryInput().pointers,
  });
  assert.equal(validateReadOnlyPacket(packet).ok, true);
  assert.equal(providers.calls.runId, 1, 'a dry run draws only the packet run ID: no request ID and no record ID');
  assert.equal(await strict(repo), before);
});

test('a dry run still reports every validation finding and writes nothing', async (t) => {
  const repo = await createRepo(t);
  const before = await strict(repo);
  const result = await submit(repo, memoryInput({ pointers: [{ path: 'SOT/99-missing.md', lines: null }] }), { dryRun: true });
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(codesOf(result.packet), ['AKRS-M002']);
  assert.equal(await strict(repo), before);
});

test('a stale expected snapshot writes nothing; a current one is accepted', async (t) => {
  const repo = await createRepo(t);
  await seedMemory(repo, 'ui', [memoryRow({ id: '01ARZ3NDEKTSV4RRFFQ69G5FA0', label: 'Unknown', owner_plan: 'P1', text: 'Open.' })]);
  const stale = (await commandSnapshot('memory-add', repo.options)).snapshot;
  await seedMemory(repo, 'billing', [memoryRow({ id: '01ARZ3NDEKTSV4RRFFQ69G5FA1', label: 'Unknown', owner_plan: 'P1', text: 'Also open.' })]);
  const before = await everything(repo);
  const blocked = await submit(repo, memoryInput(), { expectedSnapshot: stale });
  assert.equal(blocked.outcome, 'stale');
  assert.equal(blocked.packet.status, 'blocked');
  assert.deepEqual(codesOf(blocked.packet), ['AKRS-C013']);
  assert.equal(blocked.packet.next_commands.length > 0, true, 'a blocked packet offers a runnable next command');
  assert.equal(await everything(repo), before);
  const current = (await commandSnapshot('memory-add', repo.options)).snapshot;
  assert.equal((await submit(repo, memoryInput(), { expectedSnapshot: current })).outcome, 'committed');
});

// ---- drafts -----------------------------------------------------------------------------------------------------
test('success from a draft removes the draft in the same transaction and lists both paths in changed', async (t) => {
  const repo = await createRepo(t);
  await draftDocument(repo, 'mem-a', memoryInput());
  const result = await fromFile(repo, 'akrs/drafts/mem-a.json');
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(result.packet.changed, ['drafts/mem-a.json', 'memory/payments.md']);
  assert.equal(result.packet.data.draft, 'akrs/drafts/mem-a.json');
  await assert.rejects(() => readFile(repo.path('akrs/drafts/mem-a.json')), { code: 'ENOENT' });
  assert.equal(validateMutationChanges(result.packet, ['drafts/mem-a.json', 'memory/payments.md']).ok, true);
});

test('--input accepts backslashes, a leading ./, and an absolute path inside the repository; the draft is still consumed', async (t) => {
  for (const [name, spelling] of [
    ['a', () => 'akrs\\drafts\\mem-a.json'],
    ['b', () => './akrs/drafts/mem-a.json'],
    ['c', (repo) => repo.path('akrs/drafts/mem-a.json')],
  ]) {
    const repo = await createRepo(t);
    await draftDocument(repo, 'mem-a', memoryInput());
    const result = await fromFile(repo, spelling(repo));
    assert.equal(result.outcome, 'committed', name);
    assert.deepEqual(result.packet.changed, ['drafts/mem-a.json', 'memory/payments.md'], name);
    await assert.rejects(() => readFile(repo.path('akrs/drafts/mem-a.json')), { code: 'ENOENT' }, name);
  }
});

test('a file that is not under drafts/ is read but never deleted', async (t) => {
  const repo = await createRepo(t);
  await repo.write('docs/memory.json', `${JSON.stringify(memoryInput(), null, 2)}\n`);
  const result = await fromFile(repo, 'docs/memory.json');
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(result.packet.changed, ['memory/payments.md']);
  assert.equal(result.packet.data.draft, null);
  assert.equal((await repo.read('docs/memory.json')).includes('payments'), true);
});

test('on failure the draft stays byte for byte and the findings carry pointers and the retry command', async (t) => {
  const repo = await createRepo(t);
  await draftDocument(repo, 'mem-bad', { ...memoryInput(), label: 'Fact' });
  const bytes = await repo.read('akrs/drafts/mem-bad.json');
  const schemaFailure = await fromFile(repo, 'akrs/drafts/mem-bad.json');
  assert.equal(schemaFailure.outcome, 'rejected');
  assert.deepEqual(pointersOf(schemaFailure.packet), ['/label']);
  assert.equal(schemaFailure.packet.findings.every(({ file }) => file === 'akrs/drafts/mem-bad.json'), true);
  assert.equal(await repo.read('akrs/drafts/mem-bad.json'), bytes);

  await draftDocument(repo, 'mem-pointer', memoryInput({ pointers: [{ path: 'SOT/99-missing.md', lines: null }] }));
  const pointerBytes = await repo.read('akrs/drafts/mem-pointer.json');
  const pointerFailure = await fromFile(repo, 'akrs/drafts/mem-pointer.json');
  assert.equal(pointerFailure.outcome, 'rejected');
  assert.deepEqual(codesOf(pointerFailure.packet), ['AKRS-M002']);
  assert.equal(pointerFailure.packet.findings.every(({ file }) => file === 'akrs/drafts/mem-pointer.json'), true);
  assert.equal(await repo.read('akrs/drafts/mem-pointer.json'), pointerBytes);
  assert.equal(pointerFailure.packet.next_commands.some(({ command, args }) => command === 'memory-add'
    && args.join(' ') === '--input akrs/drafts/mem-pointer.json'), true, 'the retry command is runnable as is');
  await assert.rejects(() => readFile(repo.path(MEMORY_FILE)), { code: 'ENOENT' });
});

test('a write failure in the middle of the transaction restores everything, the draft included', async (t) => {
  const repo = await createRepo(t);
  await draftDocument(repo, 'mem-a', memoryInput());
  const before = await everything(repo);
  await assert.rejects(() => fromFile(repo, 'akrs/drafts/mem-a.json', {
    boundary: ({ point, index }) => { if (point === 'operation_applied' && index === 1) throw new Error('disk full'); },
  }), /disk full/);
  assert.equal(await treeDigest(repo), before, 'tree restored (everything but .ops)');
  await assert.rejects(() => readFile(repo.path(MEMORY_FILE)), { code: 'ENOENT' });
  assert.equal((await repo.read('akrs/drafts/mem-a.json')).includes('settlement'), true);
});

test('a failure while appending restores the old file byte for byte', async (t) => {
  const repo = await createRepo(t);
  await submit(repo, memoryInput());
  const old = await repo.read(MEMORY_FILE);
  await assert.rejects(() => submit(repo, assumption('Low'), {
    boundary: ({ point }) => { if (point === 'operation_applied') throw new Error('disk full'); },
  }), /disk full/);
  assert.equal(await repo.read(MEMORY_FILE), old);
});

test('a draft edited between validation and the commit writes nothing', async (t) => {
  const repo = await createRepo(t);
  await draftDocument(repo, 'mem-a', memoryInput());
  const result = await fromFile(repo, 'akrs/drafts/mem-a.json', {
    hooks: { afterInputRead: () => draftDocument(repo, 'mem-a', memoryInput({ text: 'edited in the meantime' })) },
  });
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.packet.data.reason, 'input_changed');
  await assert.rejects(() => readFile(repo.path(MEMORY_FILE)), { code: 'ENOENT' });
  assert.equal((await repo.read('akrs/drafts/mem-a.json')).includes('edited in the meantime'), true);
});

test('a deleted-draft retry is resolved through the journal before any usage error, even after the file moved on', async (t) => {
  const repo = await createRepo(t);
  const providers = fakeProviders();
  await draftDocument(repo, 'mem-a', memoryInput());
  const first = await fromFile(repo, 'akrs/drafts/mem-a.json', { providers });
  assert.equal(first.outcome, 'committed');
  await submit(repo, assumption('Low'), { providers }); // a later append: appends are snapshot-free duplicates
  const after = await everything(repo);
  const retry = await fromFile(repo, 'akrs/drafts/mem-a.json', { providers });
  assert.equal(retry.outcome, 'replayed');
  assert.equal(retry.packet.status, 'noop');
  assert.equal(retry.packet.request_id, first.packet.request_id);
  assert.equal(await everything(repo), after);
  const byId = await fromFile(repo, 'akrs/drafts/mem-a.json', { providers, requestId: first.packet.request_id });
  assert.equal(byId.outcome, 'replayed');
  assert.equal(await everything(repo), after);
});

test('a missing draft that never ran is a usage error that points at the template', async (t) => {
  const repo = await createRepo(t);
  const never = await fromFile(repo, 'akrs/drafts/mem-none.json');
  assert.equal(never.outcome, 'rejected');
  assert.match(never.packet.findings[0].detail.issue, /^not_found/);
  assert.equal(never.packet.next_commands.some(({ command, args }) => command === 'template' && args.join(' ') === 'memory'), true);
});

test('every channel failure is a C008 usage packet with a root pointer and writes nothing', async (t) => {
  const repo = await createRepo(t);
  await repo.write('docs/big.json', ' '.repeat(1024 * 1024 + 1));
  await repo.write('docs/dup.json', '{"schema":"akrs.memory-input/v1","schema":"akrs.memory-input/v1"}');
  await repo.write('docs/broken.json', '{ nope');
  await repo.write('docs/array.json', '[1,2]');
  const before = await strict(repo);
  for (const [path, issue] of [
    ['docs/missing.json', 'not_found'], ['docs/big.json', 'too_large'], ['docs/dup.json', 'duplicate_key'],
    ['docs/broken.json', 'invalid_json'], ['docs/array.json', 'invalid_type'], ['../outside.json', 'invalid_path'],
    ['/etc/passwd', 'invalid_path'], ['docs', 'not_file'],
  ]) {
    const result = await fromFile(repo, path);
    assert.equal(result.outcome, 'rejected', path);
    assert.equal(result.packet.data.kind, 'usage', path);
    assert.deepEqual(codesOf(result.packet), ['AKRS-C008'], path);
    assert.match(result.packet.findings[0].detail.issue, new RegExp(`^${issue}`), path);
    assertFindingsMatchCatalog(result.packet);
  }
  assert.equal((await submit(repo, '')).outcome, 'rejected');
  assert.equal(await strict(repo), before);
});

test('the Memory writer writes only memory/<topic>.md (and the consumed draft): no other file in the tree changes', async (t) => {
  const repo = await createRepo(t);
  const old = await listFiles(repo.root);
  await draftDocument(repo, 'mem-a', memoryInput({ topic: 'a.b-c' }));
  const result = await fromFile(repo, 'akrs/drafts/mem-a.json');
  assert.deepEqual(result.packet.changed, ['drafts/mem-a.json', 'memory/a.b-c.md']);
  const now = (await listFiles(repo.root)).filter((name) => !name.startsWith('akrs/.ops/'));
  assert.deepEqual(now, [...old, 'akrs/memory/a.b-c.md'].sort());
});

test('a record ID that is already used in the file is never reused: the writer draws again', async (t) => {
  const repo = await createRepo(t);
  const providers = fakeProviders();
  const first = await submit(repo, memoryInput(), { providers });
  const taken = first.packet.data.record.id;
  const draws = [taken, taken];
  const real = providers.runId;
  providers.runId = () => (draws.length > 0 && providers.calls.runId > 0 ? draws.shift() : real());
  const second = await submit(repo, assumption('Low'), { providers });
  assert.equal(second.outcome, 'committed');
  assert.notEqual(second.packet.data.record.id, taken);
  assert.equal((await readMemoryFile({ ...repo.options, topic: 'payments' })).records.length, 2);
});
