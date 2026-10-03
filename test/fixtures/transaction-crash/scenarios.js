// Deterministic transaction scenarios shared by the P1-W05 crash tests (parent) and the crash worker (child).
// Every scenario names a command row of COMMAND_SNAPSHOT_TABLE, a target and the ordered operations a command
// would render. Contents are fixed bytes, so "the complete new state" is the same tree in every process.
// This module is inert: it only exports data and a builder.
import { normalizeAbsolutePath } from '../../../lib/core/roots.js';

export const NO_TARGET = { road: null, plan: null };

const line = (value) => `${JSON.stringify(value)}\n`;
const roadJson = (extra) => `${JSON.stringify({ schema: 'akrs.road/v1', id: 'R2', status: 'DONE', ...extra }, null, 2)}\n`;

export const SCENARIOS = Object.freeze({
  create: {
    command: 'memory-add',
    target: NO_TARGET,
    operations: [{ type: 'create', path: 'memory/topics/new.md', content: '# New topic\n\nwritten by a transaction\n' }],
  },
  replace: {
    command: 'road-update',
    target: { road: 'R2', plan: null },
    operations: [{ type: 'replace', path: 'roads/R2.json', content: roadJson({ title: 'replaced' }) }],
  },
  append: {
    command: 'log-append',
    target: NO_TARGET,
    operations: [{ type: 'append', path: 'log/0001.jsonl', content: line({ id: '01J00000000000000000000007', kind: 'road', road: 'R2' }) }],
  },
  rotation: {
    command: 'log-append',
    target: NO_TARGET,
    operations: [
      { type: 'append', path: 'log/0001.jsonl', content: line({ id: '01J00000000000000000000008', kind: 'road', road: 'R2', last: true }) },
      { type: 'create', path: 'log/0002.jsonl', content: line({ id: '01J00000000000000000000009', kind: 'road', road: 'R9' }) },
    ],
  },
  move: {
    command: 'road-move',
    target: NO_TARGET,
    operations: [{ type: 'move', path: 'roads/R9.json', to: 'roads/archive/R9.json' }],
  },
  delete: {
    command: 'memory-add',
    target: NO_TARGET,
    operations: [{ type: 'delete', path: 'memory/decisions.md' }],
  },
  // done-like: handoff append + Road replace + closure log append + draft removal in ONE manifest.
  multi: {
    command: 'done',
    target: { road: 'R1', plan: null },
    operations: [
      { type: 'append', path: 'verifications/P1/handoff.jsonl', content: line({ id: '01J00000000000000000000010', road: 'R1', result: 'done', ready: true }) },
      { type: 'replace', path: 'roads/R1.json', content: roadJson({ id: 'R1', status: 'DONE', closed: true }) },
      { type: 'append', path: 'log/0001.jsonl', content: line({ id: '01J00000000000000000000011', kind: 'road', road: 'R1' }) },
      { type: 'delete', path: 'drafts/road-R3.json' },
    ],
  },
});

export const SCENARIO_NAMES = Object.freeze(Object.keys(SCENARIOS));

// 26-character Crockford ULID with a numeric tail.
export const ulid = (n) => `01ARZ3NDEKTSV4RRFFQ6${String(n).padStart(6, '0')}`;
export const SCENARIO_REQUEST_ID = ulid(700);
export const UNRELATED_REQUEST_ID = ulid(900);

export const UNRELATED = Object.freeze({
  command: 'memory-add',
  target: NO_TARGET,
  operations: [{ type: 'create', path: 'memory/unrelated.md', content: 'unrelated\n' }],
});

// Options for runTransactionalMutation that perform `scenario` (a SCENARIOS entry or UNRELATED).
export function scenarioOptions(paths, scenario, extra = {}) {
  const root = normalizeAbsolutePath(paths.repositoryRoot);
  return {
    repositoryRoot: paths.repositoryRoot,
    workflowRoot: paths.workflowRoot,
    root,
    command: scenario.command,
    target: scenario.target,
    input: { scenario: scenario.operations.map(({ type, path, to }) => ({ type, path, to: to ?? null })) },
    lockOptions: { timeoutMs: 20_000, retryMs: 5 },
    render() {
      return {
        operations: scenario.operations.map((operation) => ({ ...operation })),
        packet: { data: { kind: 'transaction-test', operations: scenario.operations.length } },
      };
    },
    ...extra,
  };
}
