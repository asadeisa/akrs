// Self-check of the P1-W06 SOT-routing fixture: the files provenance lists exist, the valid Road passes the input
// schema and routes in-range windows (sentinels sit inside them), and each invalid Road is schema-valid but
// names a window the repository cannot satisfy, for the reason expected.json declares.
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateRoad } from '../../../lib/schemas/road.js';

const directory = fileURLToPath(new URL('./', import.meta.url));
const read = async (path) => readFile(join(directory, path), 'utf8');
const json = async (path) => JSON.parse(await read(path));
const provenance = await json('provenance.json');
const expected = await json('expected.json');
const lineCount = (text) => text.replaceAll('\r\n', '\n').split('\n').filter((_, index, all) => index < all.length - 1 || all[index] !== '').length;

async function walk(relative) {
  const names = [];
  for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) names.push(...await walk(child));
    else names.push(child);
  }
  return names;
}

test('provenance lists every runtime file', async () => {
  assert.equal(provenance.fixture, 'sot-routing');
  const present = (await walk('')).filter((name) => !['provenance.json', 'package.json', 'sot-routing.test.js'].includes(name)).sort();
  assert.deepEqual(provenance.runtimeFiles, present);
});

test('the valid Road passes the input schema and routes in-range windows in a deliberate non-sorted order', async () => {
  const document = await json(`roads/${expected.valid.file}`);
  assert.equal(validateRoad(document, { form: 'input' }).ok, true);
  const windows = document.reads.filter(({ lines }) => lines !== null);
  assert.equal(windows.length >= 3, true);
  const keys = windows.map(({ path, lines }) => `${path}:${lines[0]}`);
  assert.notDeepEqual(keys, [...keys].sort(), 'authored order is not sorted order');
  for (const { path, lines } of windows) {
    const count = lineCount(await read(`repo/${path}`));
    assert.equal(count, expected.valid.line_counts[path], path);
    assert.equal(lines[1] <= count, true, `${path} window is in range`);
  }
});

test('the key facts sit inside declared windows, so a copied body would be detectable', async () => {
  const document = await json(`roads/${expected.valid.file}`);
  const routed = ['FACT-SENTINEL-PAID-STATE', 'FACT-SENTINEL-REFUND-REVERSES'];
  const paths = [...new Set(document.reads.map(({ path }) => path))];
  for (const sentinel of expected.valid.sentinels) {
    const hits = [];
    for (const path of paths) {
      const text = await read(`repo/${path}`).catch(() => '');
      text.split('\n').forEach((line, index) => {
        if (line.includes(sentinel)) hits.push({ path, line: index + 1 });
      });
    }
    if (!routed.includes(sentinel)) continue;
    assert.equal(hits.length, 1, `${sentinel} exists exactly once in a read file`);
    const [{ path, line }] = hits;
    const inside = document.reads.some((entry) => entry.path === path && entry.lines !== null
      && entry.lines[0] <= line && line <= entry.lines[1]);
    assert.equal(inside, true, `${sentinel} is routed by a declared window`);
  }
});

test('each invalid Road is schema-valid but names a window the repository cannot satisfy', async () => {
  for (const { file, pointer, reason } of expected.invalid) {
    const document = await json(`roads/${file}`);
    assert.equal(validateRoad(document, { form: 'input' }).ok, true, file);
    const index = Number(pointer.split('/')[2]);
    const { path, lines } = document.reads[index];
    let actual;
    try {
      const metadata = await stat(join(directory, 'repo', path));
      if (metadata.isDirectory()) actual = 'not_file';
      else actual = lines[1] > lineCount(await read(`repo/${path}`)) ? 'out_of_range' : 'ok';
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      actual = 'missing';
    }
    if (reason === 'case_mismatch') {
      const names = await readdir(join(directory, 'repo'));
      assert.equal(names.includes(path.split('/')[0]), false, `${file}: the spelling really differs`);
      assert.equal(names.some((name) => name.toLowerCase() === path.split('/')[0].toLowerCase()), true, `${file}: only in case`);
    } else {
      assert.equal(actual, reason, file);
    }
  }
});
