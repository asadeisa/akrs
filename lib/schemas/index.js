// Artifact schema registry (P1-W01, Stream B): every closed artifact schema, its canonical codec spec and
// the machine-readable ordering table (Q6) that tells readers which arrays keep authored order and which
// are sets (code point sorted, unique). `validateArtifact` refuses unknown schema IDs instead of guessing.
import { deepFreeze, resolveWorkflowRoot } from './artifact-kit.js';
import { validateClosure, CLOSURE_KEYS, CLOSURE_SPEC } from './closure.js';
import { validateExecutors, EXECUTORS_INPUT_KEYS, EXECUTORS_KEYS, EXECUTORS_SPEC } from './executors.js';
import { toJsonPointer } from './primitives.js';
import { compareStrings } from './common.js';
import { validateFinding } from './finding.js';
import {
  HANDOFF_INPUT_KEYS, HANDOFF_KEYS, HANDOFF_SPEC, RESULT_INPUT_KEYS, RESULT_KEYS, RESULT_SPEC, validateHandoff,
  validateResult,
} from './handoff-result.js';
import {
  MEMORY_INPUT_KEYS, MEMORY_INPUT_SPEC, MEMORY_RECORD_KEYS, MEMORY_RECORD_SHAPE, MEMORY_RECORD_SPEC, validateMemoryInput,
  validateMemoryRecord,
} from './memory.js';
import { PLAN_INPUT_KEYS, PLAN_KEYS, PLAN_SPEC, validatePlan } from './plan.js';
import {
  ROAD_INPUT_KEYS, ROAD_KEYS, ROAD_SPEC, TASK_INPUT_KEYS, validateRoad, validateTaskInput,
} from './road.js';
import {
  SCOPE_REQUEST_INPUT_KEYS, SCOPE_REQUEST_KEYS, SCOPE_REQUEST_SPEC, SCOPE_RESOLUTION_INPUT_KEYS, SCOPE_RESOLUTION_KEYS,
  SCOPE_RESOLUTION_SPEC, validateScopeRequest, validateScopeResolution,
} from './scope.js';
import { STATE_INPUT_KEYS, STATE_KEYS, STATE_SPEC, validateState } from './state.js';
import {
  RUN_KEYS, RUN_SPEC, VERIFICATION_INPUT_KEYS, VERIFICATION_KEYS, VERIFICATION_SPEC, validateRun, validateVerification,
} from './verification.js';

export * from './templates.js';

// kind -> { schema, format, validate, spec, shape, inputKeys, storedKeys, family }
//   format:   json (one file), jsonl (append-only records, id + hash), markdown (task scaffold / memory table row)
//   spec:     input to the canonical codec (null where no codec applies); `shape` feeds the ordering table
//   inputKeys: the agent-authored key set (null where the CLI generates the whole record)
const DEFINITIONS = [
  ['road', 'akrs.road/v1', 'json', validateRoad, ROAD_SPEC, ROAD_SPEC, ROAD_INPUT_KEYS, ROAD_KEYS, 'road'],
  ['task', 'akrs.task/v1', 'markdown', (value) => validateTaskInput(value), null, null, TASK_INPUT_KEYS, TASK_INPUT_KEYS, 'road'],
  ['state', 'akrs.state/v1', 'json', validateState, STATE_SPEC, STATE_SPEC, STATE_INPUT_KEYS, STATE_KEYS, 'state'],
  ['memory-input', 'akrs.memory-input/v1', 'json', (value) => validateMemoryInput(value), MEMORY_INPUT_SPEC,
    MEMORY_INPUT_SPEC, MEMORY_INPUT_KEYS, MEMORY_INPUT_KEYS, 'memory'],
  ['memory-record', 'akrs.memory-record/v1', 'markdown', (value) => validateMemoryRecord(value), MEMORY_RECORD_SPEC,
    MEMORY_RECORD_SHAPE, null, MEMORY_RECORD_KEYS, 'memory'],
  ['closure', 'akrs.closure/v1', 'jsonl', (value) => validateClosure(value), CLOSURE_SPEC, CLOSURE_SPEC, null, CLOSURE_KEYS, 'state'],
  ['scope-request', 'akrs.scope-request/v1', 'jsonl', validateScopeRequest, SCOPE_REQUEST_SPEC, SCOPE_REQUEST_SPEC,
    SCOPE_REQUEST_INPUT_KEYS, SCOPE_REQUEST_KEYS, 'road'],
  ['scope-resolution', 'akrs.scope-resolution/v1', 'jsonl', validateScopeResolution, SCOPE_RESOLUTION_SPEC,
    SCOPE_RESOLUTION_SPEC, SCOPE_RESOLUTION_INPUT_KEYS, SCOPE_RESOLUTION_KEYS, 'road'],
  ['verification', 'akrs.verification/v1', 'json', validateVerification, VERIFICATION_SPEC, VERIFICATION_SPEC,
    VERIFICATION_INPUT_KEYS, VERIFICATION_KEYS, 'tester'],
  ['handoff', 'akrs.handoff/v1', 'jsonl', validateHandoff, HANDOFF_SPEC, HANDOFF_SPEC, HANDOFF_INPUT_KEYS, HANDOFF_KEYS, 'tester'],
  ['result', 'akrs.result/v1', 'jsonl', validateResult, RESULT_SPEC, RESULT_SPEC, RESULT_INPUT_KEYS, RESULT_KEYS, 'tester'],
  ['executors', 'akrs.executors/v1', 'json', validateExecutors, EXECUTORS_SPEC, EXECUTORS_SPEC, EXECUTORS_INPUT_KEYS,
    EXECUTORS_KEYS, 'state'],
  ['plan', 'akrs.plan/v1', 'json', validatePlan, PLAN_SPEC, PLAN_SPEC, PLAN_INPUT_KEYS, PLAN_KEYS, 'state'],
  ['run', 'akrs.run/v1', 'json', validateRun, RUN_SPEC, RUN_SPEC, null, RUN_KEYS, 'tester'],
];

export const ARTIFACT_KINDS = Object.freeze(DEFINITIONS.map(([kind]) => kind));

// The forms each kind accepts; an unknown form is a programming error for every kind.
const FORMS = {
  road: ['stored', 'input', 'update'], task: ['input'], state: ['stored', 'input'], 'memory-input': ['input'],
  'memory-record': ['stored'], closure: ['stored'], 'scope-request': ['stored', 'input'], 'scope-resolution': ['stored', 'input'],
  verification: ['stored', 'input'], handoff: ['stored', 'input'], result: ['stored', 'input'], executors: ['stored', 'input'],
  plan: ['stored', 'input'], run: ['stored'],
};

export const SCHEMA_REGISTRY = Object.freeze(Object.fromEntries(DEFINITIONS.map(
  ([kind, schema, format, validate, spec, shape, inputKeys, storedKeys, family]) => [schema, Object.freeze({
    kind, schema, format, validate, spec, shape, inputKeys, storedKeys, family, forms: Object.freeze([...FORMS[kind]]),
  })],
)));

// ---- ordering table (Q6) -----------------------------------------------------------------------------------
// Derived from the shapes, depth first in key order: one row per array, `reads[].lines` style paths.
function collectRows(shape, prefix, rows) {
  for (const key of shape.keys) {
    const path = `${prefix}${key}`;
    const array = shape.arrays?.[key];
    if (array !== undefined) {
      if (!rows.some((row) => row.path === path)) {
        rows.push(array.sortKey === undefined ? { path, kind: array.kind } : { path, kind: array.kind, sortKey: array.sortKey });
      }
      const item = array.item;
      if (item !== undefined) {
        const variants = item.variants === undefined ? [item] : Object.values(item.variants);
        for (const variant of variants) collectRows(variant, `${path}[].`, rows);
      }
    } else if (shape.objects?.[key] !== undefined) {
      collectRows(shape.objects[key], `${path}.`, rows);
    }
  }
}

export const ORDERING_TABLE = deepFreeze(Object.fromEntries(DEFINITIONS.map(([, schema, , , , shape]) => {
  const rows = [];
  if (shape !== null) collectRows(shape, '', rows);
  return [schema, rows];
})));

export function validateArtifact(schemaId, value, options = {}) {
  if (typeof schemaId !== 'string' || !Object.hasOwn(SCHEMA_REGISTRY, schemaId)) {
    throw new TypeError(`unknown artifact schema: ${String(schemaId)}`);
  }
  resolveWorkflowRoot(options); // Q30: a bad root is a programming error for every kind
  const { forms } = SCHEMA_REGISTRY[schemaId];
  if (options?.form !== undefined && !forms.includes(options.form)) {
    throw new TypeError(`unknown form for ${schemaId}: ${String(options.form)} (expected one of: ${forms.join(', ')})`);
  }
  return SCHEMA_REGISTRY[schemaId].validate(value, options);
}

// ---- findings (Q24) ----------------------------------------------------------------------------------------
// One permanent schema-violation code per family; `input` covers the input channel itself.
export const SCHEMA_VIOLATION_CODES = Object.freeze({
  road: 'AKRS-R011',
  memory: 'AKRS-M001',
  state: 'AKRS-S001',
  tester: 'AKRS-T001',
  input: 'AKRS-C008',
});

export function findingsForSchemaIssues(schemaId, issues, { file = null } = {}) {
  if (typeof schemaId !== 'string' || !Object.hasOwn(SCHEMA_REGISTRY, schemaId)) {
    throw new TypeError(`unknown artifact schema: ${String(schemaId)}`);
  }
  const code = SCHEMA_VIOLATION_CODES[SCHEMA_REGISTRY[schemaId].family];
  const findings = issues.map(({ path, code: issueCode, message }) => {
    const pointer = toJsonPointer(path);
    return {
      code,
      severity: 'error',
      message: `${schemaId}: ${message} (at ${pointer === '' ? '/' : pointer})`,
      file,
      line: null,
      detail: { schema: schemaId, pointer, issue: `${issueCode}: ${message}` },
    };
  });
  findings.sort((left, right) => compareStrings(
    `${left.detail.pointer}:${left.detail.issue}`, `${right.detail.pointer}:${right.detail.issue}`,
  ));
  for (const finding of findings) {
    const checked = validateFinding(finding);
    if (!checked.ok) throw new TypeError(`schema finding is invalid: ${JSON.stringify(checked.issues)}`);
  }
  return findings;
}
