import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { SCHEMA_REGISTRY, validateArtifact } from '../../lib/schemas/index.js';
import {
  decodeJsonl,
  normalizeInput,
  parseMarkdownRecords,
  parseStrictJson,
  verifyMeta,
} from '../../lib/store/canonical/index.js';
import { buildArtifactGolden, codecEntries, goldenName } from './artifact-goldens.js';

const goldenUrl = (name) => new URL(`../fixtures/canonical/golden/artifacts/${name}`, import.meta.url);
const table = JSON.parse(await readFile(goldenUrl('artifacts.sha256.json'), 'utf8')).files;
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const entries = codecEntries();

function crlfWithBom(text) {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text.replaceAll('\n', '\r\n'), 'utf8')]);
}

test('F4 every registry schema with a codec spec has exactly one committed golden and one table entry', () => {
  assert.equal(entries.length >= 13, true, 'the registry exposes the 13 codec-backed schemas');
  assert.deepEqual(Object.keys(table).sort(), entries.map(goldenName).sort());
  for (const value of Object.values(table)) assert.match(value, /^sha256:[0-9a-f]{64}$/);
  for (const entry of Object.values(SCHEMA_REGISTRY)) {
    if (entry.spec === null) assert.equal(entry.format, 'markdown', `${entry.kind}: only the task scaffold has no codec`);
  }
});

for (const entry of entries) {
  const name = goldenName(entry);

  test(`F4 golden bytes for ${entry.schema} (${entry.format}) are produced exactly and match the committed hash`, async () => {
    const committed = await readFile(goldenUrl(name));
    assert.equal(sha256(committed), table[name], 'committed bytes match the hash table');
    assert.equal(Buffer.from(await buildArtifactGolden(entry), 'utf8').equals(committed), true, 'codec output equals committed bytes');
    assert.equal(committed.includes(0x0d), false, 'LF only');
    assert.equal(committed[0] === 0xef && committed[1] === 0xbb && committed[2] === 0xbf, false, 'no BOM');
    assert.equal(committed.at(-1), 0x0a, 'final newline');
    assert.equal(committed.at(-2) === 0x0a && entry.format !== 'markdown', false, 'exactly one final newline');
  });

  test(`F4/F16 the ${entry.kind} golden reads back as valid, verified, and stable after CRLF plus BOM`, async () => {
    const text = await readFile(goldenUrl(name), 'utf8');
    const normalized = normalizeInput(crlfWithBom(text));
    assert.equal(normalized.ok, true);
    assert.equal(normalized.text, text, 'CRLF and BOM variants normalize to the committed bytes');

    if (entry.format === 'json') {
      const parsed = parseStrictJson(normalized.text);
      assert.equal(parsed.ok, true);
      const stored = entry.storedKeys.includes('meta');
      const result = validateArtifact(entry.schema, structuredClone(parsed.value), { form: stored ? 'stored' : 'input' });
      assert.equal(result.ok, true, JSON.stringify(result.issues));
      if (stored) assert.equal(verifyMeta(parsed.value, { spec: entry.spec }), 'declared');
    } else if (entry.format === 'jsonl') {
      const decoded = decodeJsonl(normalized.text, () => entry.spec);
      assert.equal(decoded.ok, true, JSON.stringify(decoded.issues));
      assert.equal(decoded.records.length > 0, true);
      for (const record of decoded.records) {
        assert.equal(record.state, 'declared');
        assert.equal(validateArtifact(entry.schema, structuredClone(record.value)).ok, true);
      }
    } else {
      const parsed = parseMarkdownRecords(normalized.text, entry.spec);
      assert.equal(parsed.ok, true, JSON.stringify(parsed.issues));
      assert.equal(parsed.records.length > 0, true);
      for (const record of parsed.records) {
        assert.equal(record.state, 'declared');
        assert.equal(validateArtifact(entry.schema, structuredClone(record.value)).ok, true);
      }
    }
  });
}
