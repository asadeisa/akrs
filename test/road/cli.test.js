// Real child-process runs of bin/akrs.js for `road new` and `template`: exit codes, exactly one packet on JSON
// stdout, nothing on stderr for machine output, and stdin as an input channel.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { validatePacket, validateReadOnlyPacket } from '../../lib/schemas/packet.js';
import { TEMPLATE_KINDS, buildTemplate } from '../../lib/schemas/templates.js';
import { runCli } from '../helpers/process.js';
import { codesOf, createRepo, draftDocument, pointersOf, roadInput, roadText, storedRoad, treeDigest } from './support.js';

const cli = (repo, args, options = {}) => runCli([...args, '--root', repo.root], { cwd: repo.root, ...options });
const onePacket = (result) => {
  assert.equal(result.stdout.endsWith('\n'), true);
  assert.equal(result.stdout.trimEnd().includes('\n{"schema_version"'), false, 'exactly one packet');
  const packet = JSON.parse(result.stdout);
  assert.equal(validatePacket(packet).ok, true);
  return packet;
};

test('road new --input <draft> --json: exit 0, one packet on stdout, empty stderr, draft consumed', async (t) => {
  const repo = await createRepo(t);
  await draftDocument(repo, 'road-a', roadInput());
  const result = await cli(repo, ['road', 'new', '--input', 'akrs/drafts/road-a.json', '--json']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, '');
  const packet = onePacket(result);
  assert.equal(packet.command, 'road-new');
  assert.deepEqual(packet.changed, ['drafts/road-a.json', 'roads/P6/R-P6-1.json']);
  assert.equal(await repo.read('akrs/roads/P6/R-P6-1.json'), roadText(storedRoad(roadInput())));
  await assert.rejects(() => readFile(repo.path('akrs/drafts/road-a.json')), { code: 'ENOENT' });
});

test('road new --json - reads stdin (UTF-8 with a BOM and CRLF), and the same request again is a noop with exit 0', async (t) => {
  const repo = await createRepo(t);
  const body = `﻿${JSON.stringify(roadInput({ acceptance: ['الجدول يعرض كل الحجوزات.'] }), null, 2).replaceAll('\n', '\r\n')}`;
  const first = await cli(repo, ['road', 'new', '--json', '-'], { stdin: body });
  assert.equal(first.exitCode, 0, first.stderr);
  assert.equal(onePacket(first).status, 'ok');
  const stored = await repo.read('akrs/roads/P6/R-P6-1.json');
  assert.equal(stored.includes('الجدول يعرض كل الحجوزات.'), true);
  const second = await cli(repo, ['road', 'new', '--json', '-'], { stdin: body });
  assert.equal(second.exitCode, 0, second.stderr);
  const packet = onePacket(second);
  assert.equal(packet.status, 'noop');
  assert.equal(packet.request_id, onePacket(first).request_id);
  assert.equal(await repo.read('akrs/roads/P6/R-P6-1.json'), stored);
});

test('a schema failure exits 2 with JSON pointers on stdout and writes nothing', async (t) => {
  const repo = await createRepo(t);
  await draftDocument(repo, 'bad', { ...roadInput(), approach: 'prose', checks: [{ name: 'unit', argv: 'npm test', timeout_ms: 5 }] });
  const before = await treeDigest(repo, { exclude: [] });
  const result = await cli(repo, ['road', 'new', '--input', 'akrs/drafts/bad.json', '--json']);
  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, '');
  const packet = onePacket(result);
  assert.deepEqual(pointersOf(packet), ['/approach', '/checks/0/argv']);
  assert.equal(await treeDigest(repo, { exclude: [] }), before);
});

test('a cross-Road finding exits 1; human output goes to stderr with code, pointer and a pasteable retry', async (t) => {
  const repo = await createRepo(t);
  await draftDocument(repo, 'ghost', roadInput({ deps: ['R-ghost'] }));
  const json = await cli(repo, ['road', 'new', '--input', 'akrs/drafts/ghost.json', '--json']);
  assert.equal(json.exitCode, 1);
  assert.deepEqual(codesOf(onePacket(json)), ['AKRS-R005']);
  const human = await cli(repo, ['road', 'new', '--input', 'akrs/drafts/ghost.json']);
  assert.equal(human.exitCode, 1);
  assert.equal(human.stdout, '');
  assert.match(human.stderr, /AKRS-R005/);
  assert.match(human.stderr, /\(at \/deps\/0\)/);
  assert.match(human.stderr, /akrs road new --input akrs\/drafts\/ghost\.json/);
});

test('--dry-run exits 0 and leaves the tree untouched', async (t) => {
  const repo = await createRepo(t);
  const before = await treeDigest(repo, { exclude: [] });
  const result = await cli(repo, ['road', 'new', '--json', '-', '--dry-run'], { stdin: JSON.stringify(roadInput()) });
  assert.equal(result.exitCode, 0, result.stderr);
  const packet = onePacket(result);
  assert.equal(packet.data.dry_run, true);
  assert.equal(await treeDigest(repo, { exclude: [] }), before);
});

test('usage errors exit 2 with a structured packet: no channel, unknown flag', async (t) => {
  const repo = await createRepo(t);
  for (const args of [['road', 'new', '--json'], ['road', 'new', '--json', '--bogus'], ['template', '--json']]) {
    const result = await cli(repo, args);
    assert.equal(result.exitCode, 2, args.join(' '));
    assert.equal(result.stderr, '');
    assert.equal(onePacket(result).findings[0].code.startsWith('AKRS-C'), true);
  }
});

test('template <kind> --json for all seven kinds: exit 0, a pure query packet', async (t) => {
  const repo = await createRepo(t);
  const before = await treeDigest(repo, { exclude: [] });
  for (const kind of TEMPLATE_KINDS) {
    const result = await cli(repo, ['template', kind, '--json']);
    assert.equal(result.exitCode, 0, kind);
    assert.equal(result.stderr, '');
    const packet = onePacket(result);
    assert.equal(validateReadOnlyPacket(packet).ok, true, kind);
    assert.deepEqual(packet.data.template, buildTemplate(kind), kind);
  }
  assert.equal(await treeDigest(repo, { exclude: [] }), before);
});

test('template road --class weak --to-draft writes only that draft; the human form prints the skeleton path', async (t) => {
  const repo = await createRepo(t);
  const result = await cli(repo, ['template', 'road', '--class', 'weak', '--to-draft', 'mine', '--json']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(onePacket(result).changed, ['drafts/mine.json']);
  assert.deepEqual(await readdir(repo.path('akrs/drafts')), ['mine.json']);
  assert.equal(JSON.parse(await repo.read('akrs/drafts/mine.json')).executor_class, 'weak');
  const again = await cli(repo, ['template', 'road', '--to-draft', 'mine']);
  assert.equal(again.exitCode, 1);
  assert.match(again.stderr, /AKRS-C016/);
  const human = await cli(repo, ['template', 'road', '--class', 'weak']);
  assert.equal(human.exitCode, 0);
  assert.match(human.stdout, /executor_class/);
});

test('help lists the three commands', async (t) => {
  const repo = await createRepo(t);
  const result = await runCli(['--help'], { cwd: repo.root });
  assert.equal(result.exitCode, 0);
  for (const line of ['akrs road new', 'akrs task new', 'akrs template <kind>']) assert.equal(result.stdout.includes(line), true, line);
});
