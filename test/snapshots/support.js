// Shared workflow fixture for the snapshot engine tests (P1-W02, F5). The tree is written in a caller-chosen
// order so creation-order independence can be checked. Road/plan JSON here is snapshot input only: the engine
// reads the fields it projects (deps, reads, writes, task, plan, status) and never judges schema validity.
import { createTempRepository } from '../helpers/temp-repository.js';

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const line = (value) => `${JSON.stringify(value)}\n`;

export const ROAD_R1 = {
  schema: 'akrs.road/v1',
  id: 'R1',
  plan: 'P1',
  task: 'T1',
  status: 'ACTIVE',
  deps: ['R0'],
  reads: [
    { path: 'SOT/rules.md', lines: [2, 3], why: 'paid-state rule' },
    { path: 'src/shared.js', lines: null, why: null },
    { path: 'src/own.js', lines: null, why: 'own write, read first' },
    { path: 'docs/guide', lines: null, why: null },
  ],
  writes: [
    { path: 'src/gen', class: 'dir', action: 'create' },
    { path: 'src/own.js', class: 'file', action: 'modify' },
    { path: 'tmp/handoff.md', class: 'ephemeral', action: 'create' },
  ],
  forbidden: [],
  checks: [],
  acceptance: ['works'],
  boundaries: [],
  on_landing: null,
  complexity: null,
  executor_class: 'weak',
  steps: [],
  scope_policy: null,
  oversize_reason: null,
};

export const ROAD_R0 = { ...ROAD_R1, id: 'R0', plan: null, task: null, status: 'DONE', deps: [], reads: [], writes: [] };
export const ROAD_R2 = {
  ...ROAD_R1,
  id: 'R2',
  task: null,
  status: 'QUEUED',
  deps: [],
  reads: [],
  writes: [{ path: 'lib/*.js', class: 'glob', action: 'modify' }],
};
export const ROAD_R9 = { ...ROAD_R1, id: 'R9', plan: null, task: null, deps: [], reads: [], writes: [{ path: 'other/z.js', class: 'file', action: 'modify' }] };

export const CONTRACT_P1 = {
  schema: 'akrs.verification/v1',
  plan: 'P1',
  roads: ['R1', 'R2'],
  policy: 'checks',
  reads: [{ path: 'SOT/flows.md', lines: null, why: null }],
};

export const RESOLUTION_LINE = line({ id: '01J00000000000000000000001', type: 'resolution', request: '01J00000000000000000000000', outcome: 'approved' });
export const REQUEST_LINE = line({ id: '01J00000000000000000000002', type: 'request', road: 'R1', reason: 'need more' });
export const HANDOFF_LINE = line({ id: '01J00000000000000000000003', road: 'R1', result: 'done', ready: true });
export const OTHER_HANDOFF_LINE = line({ id: '01J00000000000000000000004', road: 'R2', result: 'done', ready: true });
export const RESULT_LINE = line({ id: '01J00000000000000000000005', plan: 'P1', verdict: 'pass' });

export const SECRET = 'SNAPSHOT-CONTENT-SENTINEL-7f3a';

// Repository-relative path -> file content.
export function workflowFiles({ eol = '\n' } = {}) {
  const text = (lines) => lines.join(eol) + eol;
  return {
    'SOT/rules.md': text(['# Rules', 'paid means settled', 'refunds reverse paid', 'unrelated tail', 'more tail']),
    'SOT/flows.md': text(['# Flows', 'checkout flow']),
    'src/own.js': text(['export const own = 1;']),
    'src/shared.js': text([`export const shared = '${SECRET}';`]),
    'src/gen/a.js': text(['export const a = 1;']),
    'docs/guide/intro.md': text(['# Intro']),
    'docs/guide/deep/more.md': text(['# More']),
    'lib/x.js': text(['export const x = 1;']),
    'lib/nested/y.js': text(['export const y = 1;']),
    'README.md': text(['# Product']),
    'tmp/handoff.md': text(['baton']),
    'akrs/roads/R1.json': json(ROAD_R1),
    'akrs/roads/nested/R0.json': json(ROAD_R0),
    'akrs/roads/R2.json': json(ROAD_R2),
    'akrs/roads/R9.json': json(ROAD_R9),
    'akrs/tasks/T1.md': text(['# T1', 'narrative']),
    'akrs/plans/P1.json': json({ schema: 'akrs.plan/v1', id: 'P1', title: 'Plan one', questions: [], seams: [] }),
    'akrs/verifications/P1/contract.json': json(CONTRACT_P1),
    'akrs/verifications/P1/handoff.jsonl': HANDOFF_LINE,
    'akrs/verifications/P1/results.jsonl': RESULT_LINE,
    'akrs/verifications/P1/evidence/run-1/shot.png': 'PNG-BYTES',
    'akrs/verifications/P1/evidence/run-1/run.json': json({ schema: 'akrs.run/v1' }),
    'akrs/scope/R1.jsonl': RESOLUTION_LINE,
    'akrs/state.json': json({ schema: 'akrs.state/v1', mode: 'work' }),
    'akrs/STATE.md': text(['# State']),
    'akrs/executors.json': json({ schema: 'akrs.executors/v1', executors: [], class_overrides: {} }),
    'akrs/log/0001.jsonl': line({ id: '01J00000000000000000000006', kind: 'road', road: 'R0' }),
    'akrs/memory/decisions.md': text(['# Decisions']),
    'akrs/drafts/road-R3.json': json({ id: 'R3' }),
    'akrs/.cache/view/index.html': '<html></html>',
    'akrs/.ops/lock': 'pid 1',
    'akrs/.ops/journal/0001.jsonl': line({ op: 1 }),
  };
}

export async function createWorkflow(testContext, { order = 'forward', eol = '\n', omit = [], extra = {} } = {}) {
  const repository = await createTempRepository(testContext, { prefix: 'akrs-snap-' });
  const files = { ...workflowFiles({ eol }), ...extra };
  for (const path of omit) delete files[path];
  const paths = Object.keys(files);
  if (order === 'reverse') paths.reverse();
  for (const path of paths) await repository.write(path, files[path]);
  return {
    ...repository,
    files,
    options: { repositoryRoot: repository.root, workflowRoot: repository.path('akrs') },
  };
}

export const jsonText = json;
export const jsonLine = line;
