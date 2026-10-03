// Real child-process runs of bin/akrs.js for `memory add`: exit codes, exactly one packet on JSON stdout, nothing on
// stderr for machine output, stdin as an input channel, duplicates and --again.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validatePacket, validateReadOnlyPacket } from '../../lib/schemas/packet.js';
import { buildTemplate } from '../../lib/schemas/templates.js';
import { readMemoryFile } from '../../lib/store/memory/index.js';
import { runCli } from '../helpers/process.js';
import {
  codesOf, createRepo, draftDocument, memoryInput, pointersOf, runCommand, stripRoots, strict, unknown,
} from './support.js';

const cli = (repo, args, options = {}) => runCli([...args, '--root', repo.root], { cwd: repo.root, ...options });
const onePacket = (result) => {
  assert.equal(result.stdout.endsWith('\n'), true);
  assert.equal(result.stdout.trimEnd().includes('\n{"schema_version"'), false, 'exactly one packet');
  const packet = JSON.parse(result.stdout);
  assert.equal(validatePacket(packet).ok, true);
  return packet;
};

test('memory add --input <draft> --json: exit 0, one packet on stdout, empty stderr, draft consumed', async (t) => {
  const repo = await createRepo(t);
  await draftDocument(repo, 'mem-a', memoryInput());
  const result = await cli(repo, ['memory', 'add', '--input', 'akrs/drafts/mem-a.json', '--json']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, '');
  const packet = onePacket(result);
  assert.equal(packet.command, 'memory-add');
  assert.equal(packet.status, 'ok');
  assert.deepEqual(packet.changed, ['drafts/mem-a.json', 'memory/payments.md']);
  assert.equal(packet.data.record.path, 'akrs/memory/payments.md');
  assert.equal(packet.data.record.meta_state, 'declared');
  await assert.rejects(() => readFile(repo.path('akrs/drafts/mem-a.json')), { code: 'ENOENT' });
  const file = await readMemoryFile({ ...repo.options, topic: 'payments' });
  assert.deepEqual(file.records.map(({ id }) => id), [packet.data.record.id]);
});

test('memory add --json - reads stdin (UTF-8, BOM, CRLF, Arabic/CJK/emoji text); the same request again is a noop with exit 0 and an --again offer', async (t) => {
  const repo = await createRepo(t);
  const text = 'تُشتق حالة الدفع من حدث التسوية ‏— 支付状态 — \u{1F680}';
  const body = `﻿${JSON.stringify(memoryInput({ text }), null, 2).replaceAll('\n', '\r\n')}`;
  const first = await cli(repo, ['memory', 'add', '--json', '-'], { stdin: body });
  assert.equal(first.exitCode, 0, first.stderr);
  const created = onePacket(first);
  assert.equal(created.status, 'ok');
  const stored = await repo.read('akrs/memory/payments.md');
  assert.equal(stored.includes(text), true);
  assert.equal((await readMemoryFile({ ...repo.options, topic: 'payments' })).records[0].text, text);

  const second = await cli(repo, ['memory', 'add', '--json', '-'], { stdin: body });
  assert.equal(second.exitCode, 0, second.stderr);
  const duplicate = onePacket(second);
  assert.equal(duplicate.status, 'noop');
  assert.equal(duplicate.request_id, created.request_id);
  assert.deepEqual(duplicate.changed, []);
  assert.equal(await repo.read('akrs/memory/payments.md'), stored);
  const offer = duplicate.next_commands.find(({ args }) => args.includes('--again'));
  assert.equal(offer.command, 'memory-add');
  assert.deepEqual(stripRoots(offer.args), ['--json', '-', '--again']);

  // running the offered command appends the deliberate duplicate
  const third = await cli(repo, ['memory', 'add', ...stripRoots(offer.args)], { stdin: body });
  assert.equal(third.exitCode, 0, third.stderr);
  const deliberate = onePacket(third);
  assert.equal(deliberate.status, 'ok');
  assert.notEqual(deliberate.data.record.id, created.data.record.id);
  assert.equal((await readMemoryFile({ ...repo.options, topic: 'payments' })).records.length, 2);
});

test('the human form of a duplicate prints the pasteable --again command on stdout (noop is a success)', async (t) => {
  const repo = await createRepo(t);
  await draftDocument(repo, 'first', memoryInput());
  assert.equal((await cli(repo, ['memory', 'add', '--input', 'akrs/drafts/first.json'])).exitCode, 0);
  await draftDocument(repo, 'second', memoryInput());
  const human = await cli(repo, ['memory', 'add', '--input', 'akrs/drafts/second.json']);
  assert.equal(human.exitCode, 0, human.stderr);
  assert.equal(human.stderr, '');
  assert.match(human.stdout, /noop/);
  assert.match(human.stdout, /akrs memory add --input akrs\/drafts\/second\.json --again/);
  const again = await cli(repo, ['memory', 'add', '--input', 'akrs/drafts/second.json', '--again', '--json']);
  assert.equal(again.exitCode, 0, again.stderr);
  assert.deepEqual(onePacket(again).changed, ['drafts/second.json', 'memory/payments.md']);
  assert.equal((await readMemoryFile({ ...repo.options, topic: 'payments' })).records.length, 2);
});

test('a schema failure exits 2 with JSON pointers on stdout and writes nothing', async (t) => {
  const repo = await createRepo(t);
  await draftDocument(repo, 'bad', { ...memoryInput(), label: 'Assumption', pointers: [] });
  const before = await strict(repo);
  const result = await cli(repo, ['memory', 'add', '--input', 'akrs/drafts/bad.json', '--json']);
  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, '');
  const packet = onePacket(result);
  assert.deepEqual(codesOf(packet), ['AKRS-M001']);
  assert.deepEqual(pointersOf(packet), ['/label']);
  assert.equal(await strict(repo), before);
});

test('a pointer finding exits 1; human output goes to stderr with code, pointer and a pasteable retry', async (t) => {
  const repo = await createRepo(t);
  await draftDocument(repo, 'ghost', memoryInput({ pointers: [{ path: 'SOT/99-missing.md', lines: null }] }));
  const json = await cli(repo, ['memory', 'add', '--input', 'akrs/drafts/ghost.json', '--json']);
  assert.equal(json.exitCode, 1);
  assert.deepEqual(codesOf(onePacket(json)), ['AKRS-M002']);
  const human = await cli(repo, ['memory', 'add', '--input', 'akrs/drafts/ghost.json']);
  assert.equal(human.exitCode, 1);
  assert.equal(human.stdout, '');
  assert.match(human.stderr, /AKRS-M002/);
  assert.match(human.stderr, /\(at \/pointers\/0\/path\)/);
  assert.match(human.stderr, /akrs memory add --input akrs\/drafts\/ghost\.json/);
});

test('--dry-run exits 0, reports the proposed record and leaves the tree untouched', async (t) => {
  const repo = await createRepo(t);
  const before = await strict(repo);
  const result = await cli(repo, ['memory', 'add', '--json', '-', '--dry-run'], { stdin: JSON.stringify(unknown()) });
  assert.equal(result.exitCode, 0, result.stderr);
  const packet = onePacket(result);
  assert.equal(packet.data.dry_run, true);
  assert.equal(packet.data.record.id, null);
  assert.equal(validateReadOnlyPacket(packet).ok, true);
  assert.equal(await strict(repo), before);
});

test('--request-id and --if-snapshot are honoured: a bad ID exits 2, a stale snapshot exits 1 and writes nothing', async (t) => {
  const repo = await createRepo(t);
  const bad = await cli(repo, ['memory', 'add', '--json', '-', '--request-id', 'nope'], { stdin: JSON.stringify(memoryInput()) });
  assert.equal(bad.exitCode, 2);
  assert.equal(onePacket(bad).data.reason, 'invalid_request_id');
  const malformed = await cli(repo, ['memory', 'add', '--json', '-', '--if-snapshot', 'nope'], { stdin: JSON.stringify(memoryInput()) });
  assert.equal(malformed.exitCode, 2);
  const stale = await cli(repo, ['memory', 'add', '--json', '-', '--if-snapshot', `sha256:${'0'.repeat(64)}`], { stdin: JSON.stringify(memoryInput()) });
  assert.equal(stale.exitCode, 1);
  assert.deepEqual(codesOf(onePacket(stale)), ['AKRS-C013']);
  const ok = await cli(repo, ['memory', 'add', '--json', '-', '--request-id', '01ARZ3NDEKTSV4RRFFQ69G5FAV'], { stdin: JSON.stringify(memoryInput()) });
  assert.equal(ok.exitCode, 0, ok.stderr);
  assert.equal(onePacket(ok).request_id, '01ARZ3NDEKTSV4RRFFQ69G5FAV');
});

test('usage errors exit 2 with a structured packet: no channel, both channels, unknown flag', async (t) => {
  const repo = await createRepo(t);
  await draftDocument(repo, 'mem-a', memoryInput());
  for (const [args, options] of [
    [['memory', 'add', '--json'], {}],
    [['memory', 'add', '--json', '--bogus'], {}],
    [['memory', 'add', '--input', 'akrs/drafts/mem-a.json', '--json', '-'], { stdin: '{}' }],
    [['memory', '--json'], {}],
  ]) {
    const result = await cli(repo, args, options);
    assert.equal(result.exitCode, 2, args.join(' '));
    assert.equal(result.stderr, '');
    assert.equal(onePacket(result).findings[0].code.startsWith('AKRS-C'), true);
  }
  assert.equal((await repo.read('akrs/drafts/mem-a.json')).includes('payments'), true);
});

test('a missing workflow root exits 3', async (t) => {
  const repo = await createRepo(t);
  const result = await runCli(['memory', 'add', '--json', '-', '--root', repo.root, '--workflow-root', repo.path('nowhere')], {
    cwd: repo.root, stdin: JSON.stringify(memoryInput()),
  });
  assert.equal(result.exitCode, 3);
});

test('template memory --to-draft offers the exact memory add command for that draft, and the filled draft is accepted', async (t) => {
  const repo = await createRepo(t);
  const drafted = await cli(repo, ['template', 'memory', '--to-draft', 'mem-t', '--json']);
  assert.equal(drafted.exitCode, 0, drafted.stderr);
  const packet = onePacket(drafted);
  assert.deepEqual(packet.changed, ['drafts/mem-t.json']);
  assert.deepEqual(packet.next_commands.map(({ command, args }) => [command, stripRoots(args).join(' ')]), [['memory-add', '--input akrs/drafts/mem-t.json']]);
  assert.deepEqual(JSON.parse(await repo.read('akrs/drafts/mem-t.json')), buildTemplate('memory').skeleton);
  const unfilled = await cli(repo, ['memory', 'add', '--input', 'akrs/drafts/mem-t.json', '--json']);
  assert.equal(unfilled.exitCode, 2);
  assert.equal(onePacket(unfilled).data.missing_inputs.length > 0, true);
  await draftDocument(repo, 'mem-t', memoryInput());
  const filled = await cli(repo, ['memory', 'add', '--input', 'akrs/drafts/mem-t.json', '--json']);
  assert.equal(filled.exitCode, 0, filled.stderr);
});

test('help lists memory add with its flags and stdin form', async (t) => {
  const repo = await createRepo(t);
  const result = await runCli(['--help', '--json'], { cwd: repo.root });
  assert.equal(result.exitCode, 0);
  const entry = JSON.parse(result.stdout).data.commands.find(({ id }) => id === 'memory-add');
  assert.equal(entry.invocation, 'akrs memory add');
  assert.equal(entry.stdin, true);
  assert.deepEqual(entry.options.map(({ name }) => name).sort(), ['--again', '--dry-run', '--if-snapshot', '--input', '--request-id']);
  const human = await runCli(['--help'], { cwd: repo.root });
  assert.equal(human.stdout.includes('akrs memory add'), true);
});

test('the in-process CLI and the real process agree on the written bytes', async (t) => {
  const inProcess = await createRepo(t);
  const spawned = await createRepo(t);
  const a = await runCommand(inProcess, ['memory', 'add', '--json', '-'], { stdin: JSON.stringify(unknown()) });
  assert.equal(a.exitCode, 0, a.stderr);
  const b = await cli(spawned, ['memory', 'add', '--json', '-'], { stdin: JSON.stringify(unknown()) });
  assert.equal(b.exitCode, 0, b.stderr);
  const strip = (text) => text.replace(/<!-- akrs:record \S+ \S+ -->/, '<!-- marker -->');
  assert.equal(strip(await inProcess.read('akrs/memory/payments.md')), strip(await spawned.read('akrs/memory/payments.md')));
});
