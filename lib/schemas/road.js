// Road `akrs.road/v1` (D05 §4 + A1 §2) and the Task scaffold input `akrs.task/v1` (Q31).
// Forms: `stored` (CLI-written file incl. CLI-owned `status` and `meta`), `input` (agent-authored create,
// no `status`/`meta`), `update` (agent-authored full replacement incl. the CLI-owned `status`, which must
// equal the stored value - lifecycle commands own transitions). Task prose never feeds executable fields.
import {
  READ_ENTRY_KEYS, WRITE_ACTIONS, WRITE_CLASSES, checkArgv, checkEach, checkEnum, checkId, checkIdSet, checkInteger,
  checkName, checkSchemaValue, checkText, checkTextList, checkUnique, deepFreeze, present, resolveForm, resolveWorkflowRoot,
  validateClosedObject, validateEnvelopeList, validatePathSet, validateMeta, validateReadList, validateWriteList,
  validateTimeout,
} from './artifact-kit.js';
import { EXECUTOR_CLASSES } from './executors.js';
import { validateRepoPath } from './primitives.js';
import { issue, validationResult } from './validation.js';

export const ROAD_SCHEMA = 'akrs.road/v1';
export const TASK_SCHEMA = 'akrs.task/v1';
export const ROAD_KEYS = Object.freeze([
  'schema', 'id', 'plan', 'task', 'status', 'deps', 'reads', 'writes', 'forbidden', 'checks',
  'acceptance', 'boundaries', 'on_landing', 'complexity', 'executor_class', 'steps',
  'scope_policy', 'oversize_reason', 'meta',
]);
export const ROAD_INPUT_KEYS = Object.freeze(ROAD_KEYS.filter((key) => key !== 'status' && key !== 'meta'));
export const ROAD_UPDATE_INPUT_KEYS = Object.freeze(ROAD_KEYS.filter((key) => key !== 'meta'));
export const ROAD_STATUSES = Object.freeze(['QUEUED', 'ACTIVE', 'DONE']);
export const ROAD_WRITE_ACTIONS = WRITE_ACTIONS;
export const ROAD_WRITE_CLASSES = WRITE_CLASSES;
export const ROAD_CHECK_KEYS = Object.freeze(['name', 'argv', 'timeout_ms']);
export const SCOPE_POLICY_KEYS = Object.freeze(['auto_reads', 'auto_writes']);
export const TASK_INPUT_KEYS = Object.freeze(['schema', 'id', 'plan', 'road', 'objective', 'constraints', 'approach', 'notes']);

export const READ_ENTRY_SPEC = deepFreeze({ keys: [...READ_ENTRY_KEYS], arrays: { lines: { kind: 'ordered', nullable: true } }, objects: {} });
export const WRITE_ENTRY_SPEC = deepFreeze({ keys: ['path', 'class', 'action'], arrays: {}, objects: {} });

// Canonical codec spec (the CLI-owned `meta` key is appended by `storedSpec`); `status` is stored data.
export const ROAD_SPEC = deepFreeze({
  keys: ROAD_KEYS.filter((key) => key !== 'meta'),
  arrays: {
    deps: { kind: 'set' },
    reads: { kind: 'ordered', item: READ_ENTRY_SPEC },
    writes: { kind: 'set', sortKey: 'path', item: WRITE_ENTRY_SPEC },
    forbidden: { kind: 'set' },
    checks: {
      kind: 'ordered',
      item: { keys: [...ROAD_CHECK_KEYS], arrays: { argv: { kind: 'ordered' } }, objects: {} },
    },
    acceptance: { kind: 'ordered' },
    boundaries: { kind: 'ordered' },
    steps: { kind: 'ordered' },
  },
  objects: {
    scope_policy: {
      keys: [...SCOPE_POLICY_KEYS],
      arrays: { auto_reads: { kind: 'set' }, auto_writes: { kind: 'set' } },
      objects: {},
    },
  },
});

export const TASK_SPEC = null;

function validateCheck(value, path, issues) {
  if (!validateClosedObject(value, ROAD_CHECK_KEYS, path, issues)) return;
  if (present(value, 'name')) checkName(value.name, `${path}.name`, issues);
  if (present(value, 'argv')) checkArgv(value.argv, `${path}.argv`, issues);
  if (present(value, 'timeout_ms')) validateTimeout(value.timeout_ms, `${path}.timeout_ms`, issues);
}

function validateScopePolicy(value, path, issues, { sorted, workflowRoot }) {
  if (!validateClosedObject(value, SCOPE_POLICY_KEYS, path, issues)) return;
  if (present(value, 'auto_reads')) validateEnvelopeList(value.auto_reads, `${path}.auto_reads`, issues, { sorted, workflowRoot });
  if (present(value, 'auto_writes')) validateEnvelopeList(value.auto_writes, `${path}.auto_writes`, issues, { sorted, workflowRoot });
}

export function validateRoad(value, options = {}) {
  const form = resolveForm(options, ['stored', 'input', 'update']);
  const keys = { stored: ROAD_KEYS, input: ROAD_INPUT_KEYS, update: ROAD_UPDATE_INPUT_KEYS }[form];
  const workflowRoot = resolveWorkflowRoot(options);
  const sorted = form === 'stored';
  const issues = [];
  if (!validateClosedObject(value, keys, '$', issues)) return validationResult(issues);

  if (present(value, 'schema')) checkSchemaValue(value.schema, ROAD_SCHEMA, '$.schema', issues);
  const idOk = present(value, 'id') && checkId(value.id, '$.id', issues);
  const ownId = idOk ? value.id : null;
  if (present(value, 'plan') && checkId(value.plan, '$.plan', issues, { nullable: true }) && ownId !== null && value.plan === ownId) {
    issue(issues, '$.plan', 'invalid_value', 'Plan and Road IDs share one namespace; a Road cannot be its own Plan');
  }
  if (present(value, 'task') && checkId(value.task, '$.task', issues, { nullable: true }) && ownId !== null && value.task === ownId) {
    issue(issues, '$.task', 'invalid_value', 'a Task ID cannot equal its Road ID');
  }
  if (present(value, 'status')) checkEnum(value.status, ROAD_STATUSES, '$.status', issues);
  if (present(value, 'deps')) checkIdSet(value.deps, '$.deps', issues, { sorted, exclude: ownId });
  if (present(value, 'reads')) validateReadList(value.reads, '$.reads', issues);
  if (present(value, 'writes')) validateWriteList(value.writes, '$.writes', issues, { sorted });
  if (present(value, 'forbidden')) validatePathSet(value.forbidden, '$.forbidden', issues, { sorted });
  if (present(value, 'checks')) {
    if (checkEach(value.checks, '$.checks', issues, (entry, path) => validateCheck(entry, path, issues))) {
      checkUnique(value.checks, '$.checks', issues, (entry) => (typeof entry?.name === 'string' ? entry.name : null), '.name');
    }
  }
  if (present(value, 'acceptance')) {
    checkTextList(value.acceptance, '$.acceptance', issues, { nonEmpty: true });
  }
  if (present(value, 'boundaries')) checkTextList(value.boundaries, '$.boundaries', issues);
  if (present(value, 'on_landing') && value.on_landing !== null) {
    validateRepoPath(value.on_landing, '$.on_landing', issues, { allow: ['file'] });
  }
  if (present(value, 'complexity')) checkInteger(value.complexity, '$.complexity', issues, { min: 0, max: 10, nullable: true });
  if (present(value, 'executor_class') && value.executor_class !== null) {
    checkEnum(value.executor_class, EXECUTOR_CLASSES, '$.executor_class', issues);
  }
  if (present(value, 'steps')) checkTextList(value.steps, '$.steps', issues);
  if (present(value, 'scope_policy')) validateScopePolicy(value.scope_policy, '$.scope_policy', issues, { sorted, workflowRoot });
  if (present(value, 'oversize_reason')) checkText(value.oversize_reason, '$.oversize_reason', issues, { nullable: true });
  if (form === 'stored' && present(value, 'meta')) validateMeta(value.meta, '$.meta', issues);
  return validationResult(issues);
}

export function validateTaskInput(value) {
  const issues = [];
  if (!validateClosedObject(value, TASK_INPUT_KEYS, '$', issues)) return validationResult(issues);
  if (present(value, 'schema')) checkSchemaValue(value.schema, TASK_SCHEMA, '$.schema', issues);
  if (present(value, 'id')) checkId(value.id, '$.id', issues);
  if (present(value, 'plan')) checkId(value.plan, '$.plan', issues, { nullable: true });
  if (present(value, 'road')) checkId(value.road, '$.road', issues);
  if (present(value, 'objective')) checkText(value.objective, '$.objective', issues);
  for (const key of ['constraints', 'approach', 'notes']) {
    if (present(value, key)) checkText(value[key], `$.${key}`, issues, { nullable: true });
  }
  return validationResult(issues);
}
