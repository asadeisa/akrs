// Plan file `akrs.plan/v1` (Q13, OWNER decision) at akrs/plans/<plan-id>.json: it owns the Plan's open
// questions, integration seams, open-finding pointers (at Tester result records - results stay the
// evidence owner) and the closure state written by `plan finish`. Plan and Road IDs share one namespace.
import {
  checkEach, checkEnum, checkId, checkSchemaValue, checkSet, checkText, checkTimestamp, checkUlid, checkUnique,
  deepFreeze, isPlainObject, issue, present, resolveForm, validateClosedObject, validateMeta, validateOperationRef,
} from './artifact-kit.js';
import { validationResult } from './validation.js';

export const PLAN_SCHEMA = 'akrs.plan/v1';
export const PLAN_KEYS = Object.freeze(['schema', 'id', 'title', 'questions', 'seams', 'findings', 'closure', 'meta']);
// `findings` pointers and `closure` are CLI-owned (written by Tester results and `plan finish`): stored form only.
export const PLAN_INPUT_KEYS = Object.freeze(['schema', 'id', 'title', 'questions', 'seams']);
export const QUESTION_KEYS = Object.freeze(['id', 'text', 'status', 'resolution', 'decision']);
export const SEAM_KEYS = Object.freeze(['id', 'text', 'owner']);
export const SEAM_OWNER_KEYS = Object.freeze(['road', 'intent']);
export const FINDING_POINTER_KEYS = Object.freeze(['result', 'finding', 'status']);
export const PLAN_CLOSURE_KEYS = Object.freeze(['status', 'at', 'operation']);
export const QUESTION_STATUSES = Object.freeze(['open', 'resolved']);
export const FINDING_POINTER_STATUSES = Object.freeze(['open', 'resolved']);
export const CLOSURE_STATUSES = Object.freeze(['open', 'closed']);

// Canonical codec spec (the CLI-owned `meta` key is appended by `storedSpec`).
export const PLAN_SPEC = deepFreeze({
  keys: PLAN_KEYS.filter((key) => key !== 'meta'),
  arrays: {
    questions: { kind: 'set', sortKey: 'id', item: { keys: [...QUESTION_KEYS], arrays: {}, objects: {} } },
    seams: {
      kind: 'set',
      sortKey: 'id',
      item: { keys: [...SEAM_KEYS], arrays: {}, objects: { owner: { keys: [...SEAM_OWNER_KEYS], arrays: {}, objects: {} } } },
    },
    findings: { kind: 'ordered', item: { keys: [...FINDING_POINTER_KEYS], arrays: {}, objects: {} } },
  },
  objects: {
    closure: {
      keys: [...PLAN_CLOSURE_KEYS],
      arrays: {},
      objects: { operation: { keys: ['request', 'run'], arrays: {}, objects: {} } },
    },
  },
});

function validateQuestion(value, path, issues) {
  if (!validateClosedObject(value, QUESTION_KEYS, path, issues)) return;
  if (present(value, 'id')) checkId(value.id, `${path}.id`, issues);
  if (present(value, 'text')) checkText(value.text, `${path}.text`, issues);
  const statusOk = present(value, 'status') && checkEnum(value.status, QUESTION_STATUSES, `${path}.status`, issues);
  const resolved = statusOk && value.status === 'resolved';
  const open = statusOk && value.status === 'open';
  if (present(value, 'resolution')) {
    if (resolved && value.resolution === null) {
      issue(issues, `${path}.resolution`, 'invalid_value', 'a resolved question states its resolution (or why it is accepted)');
    } else if (open && value.resolution !== null) {
      issue(issues, `${path}.resolution`, 'invalid_value', 'an open question has no resolution yet');
    } else {
      checkText(value.resolution, `${path}.resolution`, issues, { nullable: true });
    }
  }
  if (present(value, 'decision') && checkUlid(value.decision, `${path}.decision`, issues, { nullable: true })
    && open && value.decision !== null) {
    issue(issues, `${path}.decision`, 'invalid_value', 'an open question has no decision record yet');
  }
}

function validateSeamOwner(value, path, issues) {
  if (value === null) return;
  if (!validateClosedObject(value, SEAM_OWNER_KEYS, path, issues)) return;
  const road = present(value, 'road') && value.road !== null;
  const intent = present(value, 'intent') && value.intent !== null;
  if (present(value, 'road')) checkId(value.road, `${path}.road`, issues, { nullable: true });
  if (present(value, 'intent')) checkText(value.intent, `${path}.intent`, issues, { nullable: true });
  if (present(value, 'road') && present(value, 'intent') && road === intent) {
    issue(issues, path, 'invalid_value', 'a seam owner names exactly one of: an owning Road or a wiring intent');
  }
}

function validateSeam(value, path, issues) {
  if (!validateClosedObject(value, SEAM_KEYS, path, issues)) return;
  if (present(value, 'id')) checkId(value.id, `${path}.id`, issues);
  if (present(value, 'text')) checkText(value.text, `${path}.text`, issues);
  if (present(value, 'owner')) validateSeamOwner(value.owner, `${path}.owner`, issues);
}

function validateFindingPointer(value, path, issues) {
  if (!validateClosedObject(value, FINDING_POINTER_KEYS, path, issues)) return;
  if (present(value, 'result')) checkUlid(value.result, `${path}.result`, issues);
  if (present(value, 'finding')) checkId(value.finding, `${path}.finding`, issues);
  if (present(value, 'status')) checkEnum(value.status, FINDING_POINTER_STATUSES, `${path}.status`, issues);
}

function validateClosureState(value, path, issues) {
  if (!validateClosedObject(value, PLAN_CLOSURE_KEYS, path, issues)) return;
  const statusOk = present(value, 'status') && checkEnum(value.status, CLOSURE_STATUSES, `${path}.status`, issues);
  const closed = statusOk && value.status === 'closed';
  const open = statusOk && value.status === 'open';
  if (present(value, 'at')) {
    if (closed && value.at === null) issue(issues, `${path}.at`, 'invalid_value', 'a closed Plan records when it closed');
    else if (open && value.at !== null) issue(issues, `${path}.at`, 'invalid_value', 'an open Plan has no closing time');
    else checkTimestamp(value.at, `${path}.at`, issues, { nullable: true });
  }
  if (present(value, 'operation')) {
    if (closed && value.operation === null) issue(issues, `${path}.operation`, 'invalid_value', 'a closed Plan records the operation that closed it');
    else if (open && value.operation !== null) issue(issues, `${path}.operation`, 'invalid_value', 'an open Plan has no closing operation');
    else if (value.operation !== null) validateOperationRef(value.operation, `${path}.operation`, issues);
  }
}

export function validatePlan(value, options = {}) {
  const form = resolveForm(options, ['stored', 'input']);
  const sorted = form === 'stored';
  const issues = [];
  if (!validateClosedObject(value, form === 'stored' ? PLAN_KEYS : PLAN_INPUT_KEYS, '$', issues)) return validationResult(issues);
  if (present(value, 'schema')) checkSchemaValue(value.schema, PLAN_SCHEMA, '$.schema', issues);
  if (present(value, 'id')) checkId(value.id, '$.id', issues);
  if (present(value, 'title')) checkText(value.title, '$.title', issues, { nullable: true });
  const idOf = (entry) => (isPlainObject(entry) && typeof entry.id === 'string' ? entry.id : null);
  if (present(value, 'questions')
    && checkEach(value.questions, '$.questions', issues, (entry, path) => validateQuestion(entry, path, issues))) {
    checkSet(value.questions, '$.questions', issues, { sorted, keyOf: idOf, keyPath: '.id', fold: true });
  }
  if (present(value, 'seams') && checkEach(value.seams, '$.seams', issues, (entry, path) => validateSeam(entry, path, issues))) {
    checkSet(value.seams, '$.seams', issues, { sorted, keyOf: idOf, keyPath: '.id', fold: true });
  }
  if (present(value, 'findings')
    && checkEach(value.findings, '$.findings', issues, (entry, path) => validateFindingPointer(entry, path, issues))) {
    checkUnique(value.findings, '$.findings', issues, (entry) => (
      isPlainObject(entry) && typeof entry.result === 'string' && typeof entry.finding === 'string'
        ? `${entry.result}\u0000${entry.finding}` : null));
  }
  if (present(value, 'closure')) validateClosureState(value.closure, '$.closure', issues);
  if (form === 'stored' && present(value, 'meta')) validateMeta(value.meta, '$.meta', issues);
  return validationResult(issues);
}
