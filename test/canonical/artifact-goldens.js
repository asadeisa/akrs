// Golden builders for every registry schema (F4): the same code produces the committed goldens
// (via scratchpad make-artifact-goldens.mjs) and the bytes the integration test compares against them.
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SCHEMA_REGISTRY } from '../../lib/schemas/index.js';
import {
  canonicalizeJson,
  encodeJsonlRecord,
  renderMarkdownHeader,
  renderMarkdownRecord,
  storedSpec,
  withMeta,
} from '../../lib/store/canonical/index.js';

export const GENERATOR = 'akrs/2.0.0-alpha.0';
export const EXTENSIONS = { json: 'json', jsonl: 'jsonl', markdown: 'md' };

const fixtureRoot = fileURLToPath(new URL('../fixtures/schemas/', import.meta.url));

export async function loadValidFixtures(kind) {
  const directory = `${fixtureRoot}${kind}/valid`;
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(names.map(async (name) => ({
    name,
    value: JSON.parse(await readFile(`${directory}/${name}`, 'utf8')),
  })));
}

// Entries the codec can write: everything with a spec (the task scaffold has none).
export function codecEntries() {
  return Object.values(SCHEMA_REGISTRY).filter((entry) => entry.spec !== null);
}

export function goldenName(entry) {
  return `${entry.kind}.${EXTENSIONS[entry.format]}`;
}

export async function buildArtifactGolden(entry) {
  const fixtures = await loadValidFixtures(entry.kind);
  if (entry.format === 'json') {
    const value = structuredClone(fixtures[0].value);
    if (!entry.storedKeys.includes('meta')) return canonicalizeJson(value, entry.spec);
    delete value.meta;
    return canonicalizeJson(
      withMeta(value, { schema: entry.schema, generator: GENERATOR, spec: entry.spec }),
      storedSpec(entry.spec),
    );
  }
  if (entry.format === 'jsonl') {
    // fixtures carry a placeholder `hash` (the codec computes the real one) and may reuse ids across files
    const seen = new Set();
    return fixtures.map(({ value }) => {
      const { hash: _placeholder, ...record } = structuredClone(value);
      if (seen.has(record.id)) return '';
      seen.add(record.id);
      return encodeJsonlRecord(record, entry.spec);
    }).join('');
  }
  return renderMarkdownHeader(entry.spec)
    + fixtures.map(({ value }) => renderMarkdownRecord(structuredClone(value), entry.spec)).join('');
}
