import {
  canonicalizeJson,
  encodeJsonlRecord,
  renderMarkdownHeader,
  renderMarkdownRecord,
  storedSpec,
  withMeta,
} from '../../lib/store/canonical/index.js';
import { SAMPLE_SPEC } from './support.js';

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

export const CLOSURE_SPEC = {
  keys: ['id', 'hash', 'ts', 'road', 'outcome', 'deviations'],
  arrays: { deviations: { kind: 'ordered' } },
  objects: {},
};

export const MEMORY_SPEC = {
  columns: [
    { key: 'label', header: 'Label', kind: 'text' },
    { key: 'text', header: 'Memory', kind: 'text' },
    { key: 'decided_by', header: 'Decided by', kind: 'json' },
    { key: 'pointers', header: 'Pointers', kind: 'json' },
  ],
};

function artifact(note) {
  return {
    schema: 'akrs.sample/v1',
    id: 'R-GOLDEN',
    deps: ['R-3', 'R-1', 'R-2'],
    reads: [
      { path: 'docs/b.md', lines: [3, 9], why: 'second' },
      { path: 'docs/a.md', lines: null, why: null },
    ],
    writes: [
      { path: 'src/z.js', class: 'file', action: 'create' },
      { path: 'src/a.js', class: 'file', action: 'modify' },
    ],
    checks: ['second', 'first'],
    nested: { a: 7, b: true },
    note,
  };
}

export const GOLDEN = {
  'sample-artifact.json': () => canonicalizeJson(
    withMeta(artifact('golden note'), { schema: 'akrs.sample/v1', generator: 'akrs/2.0.0-alpha.0', spec: SAMPLE_SPEC }),
    storedSpec(SAMPLE_SPEC),
  ),
  'unicode-artifact.json': () => canonicalizeJson(
    artifact(`mixed: café 日本語 \u{1F600} ${LINE_SEPARATOR}|${PARAGRAPH_SEPARATOR} "quoted" back\\slash\ttab\nnewline`),
    SAMPLE_SPEC,
  ),
  'closure.jsonl': () => [
    ['01ARZ3NDEKTSV4RRFFQ69G5FAV', 'R-1', 'BLOCKED', ['waiting on R-0']],
    ['01ARZ3NDEKTSV4RRFFQ69G5FAW', 'R-1', 'DONE', []],
    ['01ARZ3NDEKTSV4RRFFQ69G5FAX', 'R-2', 'DONE', ['scope grew', `unicode ${LINE_SEPARATOR} \u{1F600}`]],
  ].map(([id, road, outcome, deviations]) => encodeJsonlRecord({
    id, ts: '2026-10-03T10:00:00.000Z', road, outcome, deviations,
  }, CLOSURE_SPEC)).join(''),
  'memory.md': () => `# Memory: golden\n\n${renderMarkdownHeader(MEMORY_SPEC)}${[
    ['01ARZ3NDEKTSV4RRFFQ69G5FAV', 'Decided', 'Use SQLite | WAL.', 'P1', [{ path: 'docs/a.md', lines: [1, 2] }]],
    ['01ARZ3NDEKTSV4RRFFQ69G5FAW', 'Unknown', 'Open: which\nbrowser?\nمرحبا 日本語 \u{1F600}', null, []],
  ].map(([id, label, text, decidedBy, pointers]) => renderMarkdownRecord({
    id, label, text, decided_by: decidedBy, pointers,
  }, MEMORY_SPEC)).join('')}`,
};
