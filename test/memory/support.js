// Shared helpers for the P1-W08 Memory writer tests. They build on the P1-W06 road helpers (temp repository with
// product files, in-process CLI, finding-detail-vs-catalog check, byte-tree digests) and add canonical Memory seeding
// that goes through the P1-W01 codec directly, never through the writer under test.
import { readFile, readdir } from 'node:fs/promises';
import { MEMORY_RECORD_SPEC } from '../../lib/schemas/memory.js';
import { renderMarkdownHeader, renderMarkdownRecord } from '../../lib/store/canonical/index.js';
import { addMemory } from '../../lib/store/memory/index.js';
import {
  assertFindingsMatchCatalog, authoringOptions, codesOf, createRepo, draftDocument, fakeProviders, pointersOf, runCommand,
  stripRoots, treeDigest, ulid,
} from '../road/support.js';

export {
  assertFindingsMatchCatalog, authoringOptions, codesOf, createRepo, draftDocument, fakeProviders, pointersOf, runCommand,
  stripRoots, treeDigest, ulid,
};

export const MEMORY_HEADER = renderMarkdownHeader(MEMORY_RECORD_SPEC);
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

// A complete, valid Memory INPUT document (a Decided record that points into a 50-line SOT file).
export function memoryInput(overrides = {}) {
  return {
    schema: 'akrs.memory-input/v1',
    topic: 'payments',
    label: 'Decided',
    decided_by: 'P6',
    owner_plan: null,
    text: 'Paid state is derived from the settlement event.',
    pointers: [{ path: 'SOT/09-use-cases.md', lines: [28, 41] }],
    ...overrides,
  };
}

export const assumption = (level = 'High', overrides = {}) => memoryInput({
  label: `Assumption ${level}`, decided_by: null, text: `The export runs nightly (${level}).`, ...overrides,
});

export const unknown = (overrides = {}) => memoryInput({
  label: 'Unknown', decided_by: null, owner_plan: 'P6', pointers: [], text: 'Whether refunds reverse the paid state.', ...overrides,
});

// One canonical record row, built with the codec (the single Memory syntax).
export function memoryRow({ id, label = 'Decided', decided_by: decidedBy = null, owner_plan: ownerPlan = null, text, pointers = [] }) {
  return renderMarkdownRecord({ id, label, decided_by: decidedBy, owner_plan: ownerPlan, text, pointers }, MEMORY_RECORD_SPEC);
}

// Writes a canonical Memory file without going through the writer under test; returns the repository path.
export async function seedMemory(repo, topic, rows, { prefix = `# Memory: ${topic}\n\n` } = {}) {
  const path = `akrs/memory/${topic}.md`;
  await repo.write(path, `${prefix}${MEMORY_HEADER}${rows.join('')}`);
  return path;
}

// One deterministic provider pair per repository: every call of a test shares it, so request IDs and record IDs never
// repeat (a fresh pair per call would hand out the same IDs again).
const providerPairs = new WeakMap();
export function sharedProviders(repo) {
  if (!providerPairs.has(repo)) providerPairs.set(repo, fakeProviders());
  return providerPairs.get(repo);
}

const stdin = (document) => ({ stdin: Buffer.from(typeof document === 'string' ? document : JSON.stringify(document)) });
export const submit = (repo, document, extra = {}) => addMemory({
  ...authoringOptions(repo, { providers: sharedProviders(repo), ...extra }), channel: stdin(document),
});
export const fromFile = (repo, inputPath, extra = {}) => addMemory({
  ...authoringOptions(repo, { providers: sharedProviders(repo), ...extra }), channel: { inputPath },
});

// `.ops` is CLI housekeeping that no snapshot reads; `strict` also covers it (nothing at all was touched).
export const everything = (repo) => treeDigest(repo);
export const strict = (repo) => treeDigest(repo, { exclude: [] });

export const fixtureUrl = (path) => new URL(`../fixtures/memory-unknown/${path}`, import.meta.url);
export const fixtureJson = async (path) => JSON.parse(await readFile(fixtureUrl(path), 'utf8'));
export const fixtureNames = async (directory) => (await readdir(fixtureUrl(`${directory}/`)))
  .filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)).sort();

export async function listFiles(root, base = root) {
  const names = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) names.push(...await listFiles(path, base));
    else names.push(path.slice(base.length + 1));
  }
  return names.sort();
}
