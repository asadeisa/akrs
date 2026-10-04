// Shared helpers for the P1-W09 closure ledger tests: canonical seeding through the P1-W01 codec (never through the
// writer under test), the in-process writer and real child-process CLI runs.
import { readFile, readdir } from 'node:fs/promises';
import { CLOSURE_SPEC } from '../../lib/schemas/closure.js';
import { encodeJsonlRecord } from '../../lib/store/canonical/index.js';
import { appendClosure } from '../../lib/store/log/index.js';
import { runCli } from '../helpers/process.js';
import {
  assertFindingsMatchCatalog, authoringOptions, codesOf, createRepo, fakeProviders, runCommand, treeDigest, ulid,
} from '../road/support.js';

export { assertFindingsMatchCatalog, codesOf, createRepo, runCommand, treeDigest, ulid };

export const LOG_DIR = 'akrs/log';

export function closureLine(index, overrides = {}) {
  return encodeJsonlRecord({
    id: ulid(5000 + index),
    ts: `2026-10-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
    kind: 'road',
    subject: `R-seed-${index}`,
    outcome: 'DONE',
    deviations: null,
    operation: null,
    ...overrides,
  }, CLOSURE_SPEC);
}

export const seedSegment = (repo, number, count, first = 0) => {
  const lines = Array.from({ length: count }, (_, index) => closureLine(first + index)).join('');
  return repo.write(`${LOG_DIR}/${String(number).padStart(4, '0')}.jsonl`, lines);
};

const providerPairs = new WeakMap();
const providersOf = (repo) => {
  if (!providerPairs.has(repo)) providerPairs.set(repo, fakeProviders());
  return providerPairs.get(repo);
};

export const closure = (repo, document, extra = {}) => appendClosure({
  ...authoringOptions(repo, { providers: providersOf(repo), ...extra }),
  document: { kind: 'road', subject: 'R-P6-1', outcome: 'DONE', deviations: null, ...document },
});

export const readLines = async (repo, name) => (await repo.read(`${LOG_DIR}/${name}`)).split('\n').filter(Boolean);
export const listLog = async (repo) => (await readdir(repo.path(LOG_DIR)).catch(() => [])).sort();
export const logBytes = async (repo, name) => readFile(repo.path(`${LOG_DIR}/${name}`));
export const cli = (repo, args, options = {}) => runCli([...args, '--root', repo.root], { cwd: repo.root, timeoutMs: 60_000, ...options });
