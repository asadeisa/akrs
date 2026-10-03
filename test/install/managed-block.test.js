import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  MANAGED_BLOCK_CONFLICTS,
  MANAGED_BLOCK_OUTCOMES,
  MANAGED_BLOCK_STYLES,
  applyManagedBlock,
  applyManagedBlockToFile,
  hashManagedContent,
} from '../../lib/store/managed-block.js';
import { PathSafetyError, createPathService } from '../../lib/store/path-service.js';
import { byteTreeHash } from '../helpers/byte-tree.js';
import { createTempRepository } from '../helpers/temp-repository.js';
import { linkDirectory } from './support.js';

const hex = (value) => createHash('sha256').update(value).digest('hex');
const BODY = 'one\ntwo\n';
const BODY_HASH = hex(BODY);

function begin(style, id, hash = BODY_HASH) {
  return style === 'html'
    ? `<!-- akrs:begin ${id} sha256=${hash} -->`
    : `# akrs:begin ${id} sha256=${hash}`;
}

function end(style, id) {
  return style === 'html' ? `<!-- akrs:end ${id} -->` : `# akrs:end ${id}`;
}

function block(style, id, body = BODY, eol = '\n') {
  const lines = body === '' ? [] : body.replace(/\n$/, '').split('\n');
  return [begin(style, id, hex(body)), ...lines, end(style, id)].join(eol);
}

test('F20 freezes the managed-block vocabulary and the closed marker grammar', () => {
  assert.deepEqual(MANAGED_BLOCK_STYLES, ['html', 'hash']);
  assert.deepEqual(MANAGED_BLOCK_OUTCOMES, ['created', 'updated', 'unchanged', 'conflict']);
  assert.deepEqual(MANAGED_BLOCK_CONFLICTS, [
    'content_edited',
    'duplicate_block',
    'invalid_encoding',
    'invalid_marker',
    'mismatched_markers',
    'nested_markers',
    'target_created_concurrently',
    'unbalanced_markers',
  ]);
  for (const list of [MANAGED_BLOCK_STYLES, MANAGED_BLOCK_OUTCOMES, MANAGED_BLOCK_CONFLICTS]) {
    assert.equal(Object.isFrozen(list), true);
  }
  assert.equal(hashManagedContent('one\r\ntwo'), BODY_HASH);
  assert.equal(hashManagedContent(BODY), BODY_HASH);
});

for (const style of MANAGED_BLOCK_STYLES) {
  test(`created block uses the exact ${style} marker form and a content hash`, () => {
    const result = applyManagedBlock('', { id: 'ignore', style, content: 'one\ntwo' });
    assert.equal(result.outcome, 'created');
    assert.equal(result.text, `${block(style, 'ignore')}\n`);
    assert.equal(result.reason, null);
    assert.equal(Object.isFrozen(result), true);
  });
}

const preservation = [];
for (const style of MANAGED_BLOCK_STYLES) {
  for (const eol of ['\n', '\r\n']) {
    for (const bom of ['', '﻿']) {
      for (const trailing of [true, false]) {
        preservation.push({ style, eol, bom, trailing });
      }
    }
  }
}

for (const { style, eol, bom, trailing } of preservation) {
  const label = `${style} eol=${JSON.stringify(eol)} bom=${bom !== ''} trailing=${trailing}`;
  test(`outside bytes are preserved exactly through created, unchanged, updated (${label})`, () => {
    const prefix = `${bom}head${eol}  keep   spaces ${eol}`;
    const suffix = `${eol}tail line${trailing ? eol : ''}`;
    const original = `${prefix}${suffix}`;

    const created = applyManagedBlock(original, { id: 'blk', style, content: BODY });
    assert.equal(created.outcome, 'created');
    assert.equal(created.text.startsWith(original.replace(/(\r?\n)$/, '')), true);
    assert.equal(created.text.includes(begin(style, 'blk')), true);
    assert.equal(created.text.endsWith(eol), trailing);
    assert.equal(/\r?\n$/.test(created.text), trailing);
    assert.equal(created.text.split(eol).join('').includes(eol === '\r\n' ? '\n' : '\r'), false);

    const again = applyManagedBlock(created.text, { id: 'blk', style, content: BODY });
    assert.equal(again.outcome, 'unchanged');
    assert.equal(again.text, created.text);

    const updated = applyManagedBlock(created.text, { id: 'blk', style, content: 'new body\n' });
    assert.equal(updated.outcome, 'updated');
    const marker = created.text.indexOf(begin(style, 'blk'));
    const markerEnd = created.text.indexOf(end(style, 'blk')) + end(style, 'blk').length;
    assert.equal(updated.text.slice(0, marker), created.text.slice(0, marker));
    assert.equal(updated.text.slice(updated.text.length - (created.text.length - markerEnd)),
      created.text.slice(markerEnd));
    assert.equal(updated.text.includes('new body'), true);
    assert.equal(updated.text.includes('one'), false);
    assert.equal(updated.text.includes(hex('new body\n')), true);
    assert.equal(applyManagedBlock(updated.text, { id: 'blk', style, content: 'new body\n' }).outcome,
      'unchanged');
  });
}

test('created block follows the file newline style and the empty file gets a trailing newline', () => {
  const crlf = applyManagedBlock('a\r\nb\r\n', { id: 'blk', style: 'hash', content: 'x\ny\n' });
  assert.equal(crlf.text, `a\r\nb\r\n${block('hash', 'blk', 'x\ny\n', '\r\n')}\r\n`);
  const lf = applyManagedBlock('a\nb', { id: 'blk', style: 'hash', content: 'x\n' });
  assert.equal(lf.text, `a\nb\n${block('hash', 'blk', 'x\n')}`);
  assert.equal(applyManagedBlock('', { id: 'blk', style: 'hash', content: '' }).text,
    `${block('hash', 'blk', '')}\n`);
});

test('position start inserts after the BOM and before the original content', () => {
  const result = applyManagedBlock('﻿first\nsecond\n', {
    id: 'blk', style: 'hash', content: BODY, position: 'start',
  });
  assert.equal(result.outcome, 'created');
  assert.equal(result.text, `﻿${block('hash', 'blk')}\nfirst\nsecond\n`);
  assert.equal(applyManagedBlock(result.text, {
    id: 'blk', style: 'hash', content: BODY, position: 'start',
  }).outcome, 'unchanged');
});

test('hash style markers on the first line are recognized behind a BOM', () => {
  const text = `﻿${block('hash', 'blk')}\nrest\n`;
  assert.equal(applyManagedBlock(text, { id: 'blk', style: 'hash', content: BODY }).outcome, 'unchanged');
});

test('blocks with different ids coexist and updating one preserves the other', () => {
  const first = applyManagedBlock('top\n', { id: 'alpha', style: 'hash', content: 'a\n' });
  const second = applyManagedBlock(first.text, { id: 'beta', style: 'hash', content: 'b\n' });
  assert.equal(second.outcome, 'created');
  const updated = applyManagedBlock(second.text, { id: 'alpha', style: 'hash', content: 'a2\n' });
  assert.equal(updated.outcome, 'updated');
  assert.equal(updated.text.includes(block('hash', 'beta', 'b\n')), true);
  assert.equal(updated.text.startsWith('top\n'), true);
});

test('markers of the other comment style are ordinary content', () => {
  const text = `${block('html', 'blk')}\nplain\n`;
  const result = applyManagedBlock(text, { id: 'blk', style: 'hash', content: BODY });
  assert.equal(result.outcome, 'created');
  assert.equal(result.text.startsWith(text), true);
});

test('text that merely mentions a marker mid-line is not a marker', () => {
  const text = 'use `# akrs:begin x` in docs and <!-- akrs:end y --> too\n';
  assert.equal(applyManagedBlock(text, { id: 'blk', style: 'hash', content: BODY }).outcome, 'created');
  assert.equal(applyManagedBlock(text, { id: 'blk', style: 'html', content: BODY }).outcome, 'created');
});

const goodHtml = (id, hash = BODY_HASH) => `<!-- akrs:begin ${id} sha256=${hash} -->`;
const conflicts = [
  ['locally edited content', 'content_edited', 'hash', `${begin('hash', 'blk')}\none\nEDITED\n${end('hash', 'blk')}\n`],
  ['deleted line inside the block', 'content_edited', 'hash', `${begin('hash', 'blk')}\none\n${end('hash', 'blk')}\n`],
  ['uppercase id', 'invalid_marker', 'hash', `# akrs:begin Bad sha256=${BODY_HASH}\none\ntwo\n# akrs:end Bad\n`],
  ['underscore id', 'invalid_marker', 'hash', `# akrs:begin bad_id sha256=${BODY_HASH}\n# akrs:end bad_id\n`],
  ['unknown attribute', 'invalid_marker', 'hash', `# akrs:begin blk sha256=${BODY_HASH} extra=1\none\ntwo\n# akrs:end blk\n`],
  ['missing hash', 'invalid_marker', 'hash', '# akrs:begin blk\none\ntwo\n# akrs:end blk\n'],
  ['short hash', 'invalid_marker', 'hash', '# akrs:begin blk sha256=abc\none\ntwo\n# akrs:end blk\n'],
  ['uppercase hash', 'invalid_marker', 'hash', `# akrs:begin blk sha256=${BODY_HASH.toUpperCase()}\none\ntwo\n# akrs:end blk\n`],
  ['unknown marker verb', 'invalid_marker', 'hash', '# akrs:replace blk\n'],
  ['indented begin', 'invalid_marker', 'hash', ` ${begin('hash', 'blk')}\none\ntwo\n${end('hash', 'blk')}\n`],
  ['trailing text after end', 'invalid_marker', 'hash', `${begin('hash', 'blk')}\none\ntwo\n${end('hash', 'blk')} trailing\n`],
  ['end carrying a hash', 'invalid_marker', 'hash', `${begin('hash', 'blk')}\none\ntwo\n# akrs:end blk sha256=${BODY_HASH}\n`],
  ['html comment without close', 'invalid_marker', 'html', `<!-- akrs:begin blk sha256=${BODY_HASH}\none\ntwo\n<!-- akrs:end blk -->\n`],
  ['html double space', 'invalid_marker', 'html', `<!--  akrs:begin blk sha256=${BODY_HASH} -->\n`],
  ['begin without end', 'unbalanced_markers', 'hash', `${begin('hash', 'blk')}\none\ntwo\n`],
  ['end without begin', 'unbalanced_markers', 'hash', `text\n${end('hash', 'blk')}\n`],
  ['end before begin', 'unbalanced_markers', 'hash', `${end('hash', 'blk')}\n${begin('hash', 'blk')}\none\ntwo\n${end('hash', 'blk')}\n`],
  ['mismatched ids', 'mismatched_markers', 'hash', `${begin('hash', 'blk')}\none\ntwo\n${end('hash', 'other')}\n`],
  ['nested other block', 'nested_markers', 'hash', `${begin('hash', 'blk')}\n${begin('hash', 'inner')}\n${end('hash', 'inner')}\n${end('hash', 'blk')}\n`],
  ['nested same id', 'nested_markers', 'hash', `${begin('hash', 'blk')}\n${begin('hash', 'blk')}\n${end('hash', 'blk')}\n${end('hash', 'blk')}\n`],
  ['duplicate block', 'duplicate_block', 'hash', `${block('hash', 'blk')}\n${block('hash', 'blk')}\n`],
  ['html duplicate', 'duplicate_block', 'html', `${block('html', 'blk')}\n${block('html', 'blk')}\n`],
  ['html edited', 'content_edited', 'html', `${goodHtml('blk')}\nONE\ntwo\n<!-- akrs:end blk -->\n`],
];

for (const [name, reason, style, text] of conflicts) {
  test(`conflict (${name}) is reported as ${reason} and never overwritten`, () => {
    const result = applyManagedBlock(text, { id: 'blk', style, content: 'replacement\n' });
    assert.equal(result.outcome, 'conflict');
    assert.equal(result.reason, reason);
    assert.equal(result.text, text);
    assert.equal(Number.isInteger(result.line) && result.line >= 1, true);
    assert.deepEqual(applyManagedBlock(text, { id: 'blk', style, content: 'replacement\n' }), result);
  });
}

test('structural errors in an unrelated block of the same style also block the write', () => {
  const text = `${begin('hash', 'broken')}\nstuff\n${block('hash', 'blk')}\n`;
  const result = applyManagedBlock(text, { id: 'blk', style: 'hash', content: BODY });
  assert.equal(result.outcome, 'conflict');
  assert.equal(result.text, text);
});

test('bad arguments fail before any text is produced', () => {
  const ok = { id: 'blk', style: 'hash', content: BODY };
  assert.throws(() => applyManagedBlock('', { ...ok, style: 'xml' }), TypeError);
  assert.throws(() => applyManagedBlock('', { ...ok, id: 'Bad Id' }), TypeError);
  assert.throws(() => applyManagedBlock('', { ...ok, id: '' }), TypeError);
  assert.throws(() => applyManagedBlock('', { ...ok, content: 7 }), TypeError);
  assert.throws(() => applyManagedBlock('', { ...ok, position: 'middle' }), TypeError);
  assert.throws(() => applyManagedBlock(7, ok), TypeError);
  assert.throws(() => applyManagedBlock('', { ...ok, content: `x\n${end('hash', 'blk')}\n` }), TypeError);
  assert.throws(() => applyManagedBlock('', { ...ok, content: `${begin('hash', 'z')}\n` }), TypeError);
  assert.throws(() => applyManagedBlock('', { ...ok, content: '# akrs:wat\n' }), TypeError);
});

async function fileService(t) {
  const repository = await createTempRepository(t, { prefix: 'akrs-block-file-' });
  const paths = await createPathService({
    repositoryRoot: repository.root,
    workflowRoot: repository.root,
  });
  return { repository, paths };
}

test('file wrapper dry-runs by default and changes no byte', async (t) => {
  const { repository, paths } = await fileService(t);
  await repository.write('.gitignore', 'node_modules\n');
  const before = await byteTreeHash(repository.root);
  const result = await applyManagedBlockToFile(paths, '.gitignore', {
    id: 'akrs', style: 'hash', content: 'akrs/.tmp\n',
  });
  assert.equal(result.outcome, 'created');
  assert.equal(result.applied, false);
  assert.equal(result.changed, true);
  assert.equal(result.path, '.gitignore');
  assert.equal(await byteTreeHash(repository.root), before);
});

test('file wrapper creates, no-ops, preserves edits as conflicts, then updates', async (t) => {
  const { repository, paths } = await fileService(t);
  const options = { id: 'akrs', style: 'hash', content: 'akrs/.tmp\n', dryRun: false };
  const missing = await applyManagedBlockToFile(paths, 'nested/.gitignore', options);
  assert.equal(missing.outcome, 'created');
  assert.equal(missing.applied, true);
  const target = repository.path('nested/.gitignore');
  const written = await readFile(target, 'utf8');
  assert.equal(written, `${block('hash', 'akrs', 'akrs/.tmp\n')}\n`);

  const noop = await applyManagedBlockToFile(paths, 'nested/.gitignore', options);
  assert.equal(noop.outcome, 'unchanged');
  assert.equal(noop.applied, false);
  assert.equal(noop.changed, false);
  assert.equal(noop.before_snapshot, noop.after_snapshot);

  await writeFile(target, written.replace('akrs/.tmp', 'akrs/.tmp\nuser-edit'));
  const before = await byteTreeHash(repository.root);
  const conflict = await applyManagedBlockToFile(paths, 'nested/.gitignore', options);
  assert.equal(conflict.outcome, 'conflict');
  assert.equal(conflict.reason, 'content_edited');
  assert.equal(conflict.applied, false);
  assert.equal(await byteTreeHash(repository.root), before);

  await writeFile(target, `# mine\r\n${block('hash', 'akrs', 'akrs/.tmp\n', '\r\n')}\r\n`);
  const updated = await applyManagedBlockToFile(paths, 'nested/.gitignore', {
    ...options, content: 'akrs/.tmp\nakrs/.cache\n',
  });
  assert.equal(updated.outcome, 'updated');
  assert.equal(updated.applied, true);
  assert.equal(await readFile(target, 'utf8'),
    `# mine\r\n${block('hash', 'akrs', 'akrs/.tmp\nakrs/.cache\n', '\r\n')}\r\n`);
});

test('file wrapper reports non-UTF-8 files as conflicts without touching them', async (t) => {
  const { repository, paths } = await fileService(t);
  await repository.write('binary.md', Buffer.from([0xff, 0xfe, 0x00, 0x41]));
  const before = await byteTreeHash(repository.root);
  const result = await applyManagedBlockToFile(paths, 'binary.md', {
    id: 'akrs', style: 'html', content: BODY, dryRun: false,
  });
  assert.equal(result.outcome, 'conflict');
  assert.equal(result.reason, 'invalid_encoding');
  assert.equal(await byteTreeHash(repository.root), before);
});

test('file wrapper rejects unsafe paths and symlink escapes through the path service', async (t) => {
  const { repository, paths } = await fileService(t);
  const outside = await createTempRepository(t, { prefix: 'akrs-block-outside-' });
  await outside.write('victim.md', 'outside\n');
  await mkdir(repository.path('docs'), { recursive: true });
  await linkDirectory(outside.root, repository.path('docs/link'));
  const before = await byteTreeHash(outside.root);
  const options = { id: 'akrs', style: 'html', content: BODY, dryRun: false };

  for (const bad of ['../outside.md', '/abs.md', 'a\\b.md', 'docs/../x.md', 'docs/link/victim.md']) {
    await assert.rejects(() => applyManagedBlockToFile(paths, bad, options), PathSafetyError, bad);
  }
  await assert.rejects(() => applyManagedBlockToFile(paths, 'LOG-001.md', options), /archived ledger/);
  assert.equal(await byteTreeHash(outside.root), before);
});
