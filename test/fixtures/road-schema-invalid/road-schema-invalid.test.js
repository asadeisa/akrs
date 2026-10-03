// Self-check of the P1-W06 invalid-Road fixtures: provenance lists exactly the files present, and every document
// fails the closed Road input schema at exactly the declared RFC 6901 pointers (and nowhere else).
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { validateRoad } from '../../../lib/schemas/road.js';
import { toJsonPointer } from '../../../lib/schemas/primitives.js';

const directory = new URL('./', import.meta.url);
const provenance = JSON.parse(await readFile(new URL('provenance.json', directory), 'utf8'));
const names = (await readdir(directory)).filter((name) => name.endsWith('.json') && name !== 'provenance.json' && name !== 'package.json').sort();

test('provenance describes the fixture and lists every runtime file', () => {
  assert.equal(provenance.fixture, 'road-schema-invalid');
  assert.equal(provenance.kind, 'synthetic-regression');
  assert.deepEqual(provenance.runtimeFiles, names);
  assert.equal(names.length >= 20, true);
});

for (const name of names) {
  test(`${name}: fails the input schema at exactly the declared pointers`, async () => {
    const fixture = JSON.parse(await readFile(new URL(name, directory), 'utf8'));
    assert.deepEqual(Object.keys(fixture).sort(), ['document', 'expect']);
    assert.equal(fixture.expect.length > 0, true);
    const result = validateRoad(fixture.document, { form: 'input' });
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.issues.map(({ path, code }) => ({ pointer: toJsonPointer(path), code })),
      fixture.expect,
    );
  });
}
