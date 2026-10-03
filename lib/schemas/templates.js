// Agent-facing skeletons (F15, F16, Q27; A1 §4): seven template kinds. A skeleton is the exact INPUT form of
// its schema with empty placeholders; it does not validate until filled, and `findMissingInputs` names the
// exact missing input as an RFC 6901 pointer instead of a generic schema error.
import { EXECUTOR_CLASSES } from './executors.js';
import { HANDOFF_INPUT_KEYS, HANDOFF_SCHEMA, RESULT_INPUT_KEYS, RESULT_SCHEMA } from './handoff-result.js';
import { MEMORY_INPUT_KEYS, MEMORY_INPUT_SCHEMA } from './memory.js';
import { ROAD_INPUT_KEYS, ROAD_SCHEMA, TASK_INPUT_KEYS, TASK_SCHEMA } from './road.js';
import { SCOPE_REQUEST_INPUT_KEYS, SCOPE_REQUEST_SCHEMA } from './scope.js';
import { VERIFICATION_INPUT_KEYS, VERIFICATION_SCHEMA } from './verification.js';

export const TEMPLATE_KINDS = Object.freeze(['road', 'task', 'verification', 'memory', 'scope', 'handoff', 'result']);
export const TEMPLATE_SCHEMAS = Object.freeze({
  road: ROAD_SCHEMA,
  task: TASK_SCHEMA,
  verification: VERIFICATION_SCHEMA,
  memory: MEMORY_INPUT_SCHEMA,
  scope: SCOPE_REQUEST_SCHEMA,
  handoff: HANDOFF_SCHEMA,
  result: RESULT_SCHEMA,
});
const INPUT_KEYS = {
  road: ROAD_INPUT_KEYS,
  task: TASK_INPUT_KEYS,
  verification: VERIFICATION_INPUT_KEYS,
  memory: MEMORY_INPUT_KEYS,
  scope: SCOPE_REQUEST_INPUT_KEYS,
  handoff: HANDOFF_INPUT_KEYS,
  result: RESULT_INPUT_KEYS,
};

// Placeholder values, one fresh object per call. `null` = a required scalar the author must supply,
// `[]` = a list the author fills (or leaves empty when the schema allows it).
const DEFAULTS = {
  road: ({ executorClass }) => ({
    id: null, plan: null, task: null, deps: [], reads: [], writes: [], forbidden: [], checks: [], acceptance: [],
    boundaries: [], on_landing: null, complexity: null, executor_class: executorClass, steps: [],
    scope_policy: { auto_reads: [], auto_writes: [] }, oversize_reason: null,
  }),
  task: () => ({ id: null, plan: null, road: null, objective: null, constraints: null, approach: null, notes: null }),
  verification: () => ({
    plan: null, roads: [], policy: null, reads: [], launch: null, setup: [], teardown: [], acceptance: [],
    measurements: [], evidence_types: [], reachability: [], boundaries: [], timeout_ms: 600000, allowed_hosts: [],
    scenario: [],
  }),
  memory: () => ({ topic: null, label: null, decided_by: null, owner_plan: null, text: null, pointers: [] }),
  scope: () => ({ road: null, add_reads: [], add_writes: [], reason: null, blocking: null }),
  handoff: () => ({ road: null, result: null, reach: [], expect: null }),
  result: () => ({
    verdict: null, checks: [], measurements: [], evidence: [], findings: [], user_acceptance: { answer: null, because: null },
  }),
};

const GUIDE = {
  road: {
    '/schema': 'Fixed schema ID; leave as is.',
    '/id': 'Road ID: letters and digits joined by - or . (at most 64); the Road file name must match it.',
    '/plan': 'Owning Plan ID, or null in the no-Plan tier.',
    '/task': 'Task ID this Road implements, or null.',
    '/deps': 'Road IDs that must be DONE first (a set).',
    '/reads': 'Files the Worker may read: {path, lines: null | [start, end], why: string | null}; order is kept.',
    '/writes': 'Everything the Worker may write: {path, class: file|dir|glob|ephemeral, action: create|modify|delete}.',
    '/writes/0/path': 'Repository-relative path matching its class (a glob needs * or ?).',
    '/forbidden': 'Paths and globs the Worker must never touch (a set).',
    '/checks': 'Commands that prove the Road: {name, argv: [program, ...args], timeout_ms}; never a shell string.',
    '/acceptance': 'Observable statements that make the Road DONE; at least one.',
    '/acceptance/0': 'The first observable acceptance statement.',
    '/boundaries': 'What the Worker must not do.',
    '/on_landing': 'Skill file to follow after landing, or null.',
    '/complexity': 'Advisory blast radius 0-10, or null.',
    '/executor_class': 'weak | medium | frontier: the class this Road is written for, or null.',
    '/steps': 'Ordered small steps. Class fit (a later packet) will ask for them on weak-class Roads; the schema does not require them.',
    '/steps/0': 'The first step (class fit, not the schema, asks for it on weak-class Roads).',
    '/scope_policy': 'Envelope the Worker may extend by itself: {auto_reads, auto_writes}; never the workflow root (akrs/** by default) or SOT/**.',
    '/oversize_reason': 'Why this Road is deliberately larger than its class limits, or null.',
  },
  task: {
    '/schema': 'Fixed schema ID; leave as is.',
    '/id': 'Task ID.',
    '/plan': 'Owning Plan ID, or null.',
    '/road': 'The Road this Task scaffolds.',
    '/objective': 'One paragraph: what the Task achieves.',
    '/constraints': 'Prose constraints, or null. Never executable.',
    '/approach': 'Prose approach, or null. Never executable.',
    '/notes': 'Free notes, or null.',
  },
  verification: {
    '/schema': 'Fixed schema ID; leave as is.',
    '/plan': 'Plan ID the contract belongs to (the Road ID in the no-Plan tier).',
    '/roads': 'Road IDs verified together (a set); at least one.',
    '/roads/0': 'The first Road ID under verification.',
    '/policy': 'none | checks | live | measured.',
    '/reads': 'Files the Tester may read, same entry shape as a Road read.',
    '/launch': 'null, or {argv, url, ready: {url, status, timeout_ms} | null} for live and measured policies.',
    '/setup': 'Commands run before the scenario: {name, argv}.',
    '/teardown': 'Commands run after the scenario: {name, argv}.',
    '/acceptance': 'Observable statements to confirm.',
    '/measurements': 'Budgets: {name, unit, budget, direction: max|min}.',
    '/evidence_types': 'Evidence kinds to collect (a set).',
    '/reachability': 'Statements that must be reachable at runtime.',
    '/boundaries': 'What the Tester must not do.',
    '/timeout_ms': 'Overall time limit in ms, 1 to 3600000.',
    '/allowed_hosts': 'Extra host names scenario http steps may call (loopback is always allowed).',
    '/scenario': 'Closed steps: goto, click, fill, press, wait_for, expect_text, expect_no_console_errors, http, screenshot, measure, viewport.',
  },
  memory: {
    '/schema': 'Fixed schema ID; leave as is.',
    '/topic': 'Topic ID the record is filed under.',
    '/label': 'Decided | Assumption High | Assumption Med | Assumption Low | Unknown.',
    '/decided_by': 'Plan or Road ID that decided it (Decided only), otherwise null.',
    '/owner_plan': 'Plan that owns the open question (Unknown only), otherwise null.',
    '/text': 'The record text.',
    '/pointers': 'Evidence pointers {path, lines}; required for Decided and Assumption, empty for Unknown.',
    '/pointers/0': 'The first evidence pointer.',
  },
  scope: {
    '/schema': 'Fixed schema ID; leave as is.',
    '/road': 'The Road asking for more scope.',
    '/add_reads': 'Extra reads, same entry shape as a Road read; at least one of add_reads/add_writes is needed.',
    '/add_reads/0': 'The first extra read (or fill add_writes instead).',
    '/add_writes': 'Extra writes, same entry shape as a Road write.',
    '/reason': 'Why the declared scope is not enough.',
    '/blocking': 'true when the Worker cannot continue without the answer.',
  },
  handoff: {
    '/schema': 'Fixed schema ID; leave as is.',
    '/road': 'The Road being handed off.',
    '/result': 'What is ready now, in plain words.',
    '/reach': 'Ordered steps to reach it; at least one.',
    '/reach/0': 'The first step to reach the result.',
    '/expect': 'What the Tester should see.',
  },
  result: {
    '/schema': 'Fixed schema ID; leave as is.',
    '/verdict': 'pass | fail | blocked.',
    '/checks': 'Executed checks: {name, passed, exit_code}.',
    '/measurements': 'Measured values: {name, value (integer), unit, within_budget}.',
    '/evidence': 'Evidence files {path, type} under the Plan evidence directory; the CLI fills bytes and sha256.',
    '/findings': 'Findings: {id, text, status: open|resolved}.',
    '/user_acceptance': 'The user answer: {answer: yes|no, because}.',
    '/user_acceptance/answer': 'yes or no, in the user words.',
    '/user_acceptance/because': 'Why, in the user words.',
  },
};

export function buildTemplate(kind, options = {}) {
  if (typeof kind !== 'string' || !TEMPLATE_KINDS.includes(kind)) throw new TypeError(`unknown template kind: ${String(kind)}`);
  const executorClass = options.class ?? null;
  if (executorClass !== null && !EXECUTOR_CLASSES.includes(executorClass)) {
    throw new TypeError(`unknown executor class: ${String(executorClass)}`);
  }
  const defaults = DEFAULTS[kind]({ executorClass });
  const skeleton = Object.fromEntries(INPUT_KEYS[kind].map((key) => [key, key === 'schema' ? TEMPLATE_SCHEMAS[kind] : defaults[key]]));
  const guide = Object.entries(GUIDE[kind]).map(([pointer, description]) => ({ pointer, description }))
    .sort((left, right) => (left.pointer < right.pointer ? -1 : left.pointer > right.pointer ? 1 : 0));
  return { kind, schema: TEMPLATE_SCHEMAS[kind], skeleton, guide };
}

// ---- missing-input detection ---------------------------------------------------------------------------------
const empty = (list) => !Array.isArray(list) || list.length === 0;
const isBlank = (value) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
const firstBlank = (list) => {
  if (!Array.isArray(list) || list.length === 0) return 0;
  const index = list.findIndex(isBlank);
  return index === -1 ? null : index;
};

const field = (key) => [`/${key}`, (input) => isBlank(input?.[key])];
const listFirst = (key) => [`/${key}/0`, (input) => {
  const index = firstBlank(input?.[key]);
  return index === null ? null : `/${key}/${index}`;
}];

const RULES = {
  road: () => [
    field('id'),
    listFirst('acceptance'),
    // only a write entry that exists but names no path fails validation (a Road with no writes is legal)
    ['/writes/0/path', (value) => {
      const writes = Array.isArray(value?.writes) ? value.writes : [];
      const index = writes.findIndex((entry) => isBlank(entry?.path));
      return index === -1 ? null : `/writes/${index}/path`;
    }],
  ],
  task: () => [field('id'), field('objective'), field('road')],
  verification: () => [field('plan'), listFirst('roads'), field('policy')],
  memory: (input) => [
    field('topic'), field('label'), field('text'),
    ...(input?.label === 'Decided' ? [field('decided_by'), listFirst('pointers')] : []),
    ...(typeof input?.label === 'string' && input.label.startsWith('Assumption') ? [listFirst('pointers')] : []),
    ...(input?.label === 'Unknown' ? [field('owner_plan')] : []),
  ],
  scope: () => [
    field('road'), field('reason'), ['/blocking', (input) => typeof input?.blocking !== 'boolean'],
    ['/add_reads/0', (input) => (empty(input?.add_reads) && empty(input?.add_writes))],
  ],
  handoff: () => [field('road'), field('result'), listFirst('reach'), field('expect')],
  result: () => [
    field('verdict'),
    ['/user_acceptance/answer', (input) => isBlank(input?.user_acceptance?.answer)],
    ['/user_acceptance/because', (input) => isBlank(input?.user_acceptance?.because)],
  ],
};

export function findMissingInputs(kind, input) {
  if (typeof kind !== 'string' || !TEMPLATE_KINDS.includes(kind)) throw new TypeError(`unknown template kind: ${String(kind)}`);
  const guide = GUIDE[kind];
  return RULES[kind](input)
    .map(([pointer, test]) => ({ pointer, result: test(input) }))
    .filter(({ result }) => result !== null && result !== false)
    .map(({ pointer, result }) => {
      const resolved = typeof result === 'string' ? result : pointer;
      const described = guide[resolved] ?? guide[pointer] ?? `input ${resolved}`;
      return { pointer: resolved, message: `${resolved} is required: ${described}` };
    })
    .sort((left, right) => (left.pointer < right.pointer ? -1 : left.pointer > right.pointer ? 1 : 0));
}

