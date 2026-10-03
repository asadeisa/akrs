// Executors file `akrs.executors/v1` (A1 §2.1, Q17): the user's own class answer per executor, plus sparse
// per-class numeric knob overrides. Classes are never inferred from model names.
import {
  checkEach, checkEnum, checkId, checkInteger, checkSchemaValue, checkSet, checkText, deepFreeze,
  isPlainObject, present, resolveForm, validateClosedObject, validateMeta, validateOptionalKeys,
} from './artifact-kit.js';
import { validationResult } from './validation.js';

export const EXECUTORS_SCHEMA = 'akrs.executors/v1';
export const EXECUTORS_KEYS = Object.freeze(['schema', 'executors', 'class_overrides', 'meta']);
export const EXECUTORS_INPUT_KEYS = Object.freeze(['schema', 'executors', 'class_overrides']);
export const EXECUTOR_ROLES = Object.freeze(['leader', 'worker', 'tester']);
export const EXECUTOR_CLASSES = Object.freeze(['weak', 'medium', 'frontier']);
export const CLASS_KNOBS = Object.freeze([
  'max_writes', 'max_write_dirs', 'read_budget_tokens', 'done_failures_before_yield', 'envelope_grant_cap',
]);
export const EXECUTOR_KEYS = Object.freeze(['id', 'role', 'class', 'label', 'user_answer']);
export const KNOB_MAX = 1000000;

const knobSpec = Object.freeze({ keys: [...CLASS_KNOBS], optional: [...CLASS_KNOBS], arrays: {}, objects: {} });

// Canonical codec spec (the CLI-owned `meta` key is appended by `storedSpec`).
export const EXECUTORS_SPEC = deepFreeze({
  keys: ['schema', 'executors', 'class_overrides'],
  arrays: { executors: { kind: 'set', sortKey: 'id', item: { keys: [...EXECUTOR_KEYS], arrays: {}, objects: {} } } },
  objects: {
    class_overrides: {
      keys: [...EXECUTOR_CLASSES],
      optional: [...EXECUTOR_CLASSES],
      arrays: {},
      objects: Object.fromEntries(EXECUTOR_CLASSES.map((name) => [name, knobSpec])),
    },
  },
});

function validateExecutor(value, path, issues) {
  if (!validateClosedObject(value, EXECUTOR_KEYS, path, issues)) return;
  if (present(value, 'id')) checkId(value.id, `${path}.id`, issues);
  if (present(value, 'role')) checkEnum(value.role, EXECUTOR_ROLES, `${path}.role`, issues);
  if (present(value, 'class')) checkEnum(value.class, EXECUTOR_CLASSES, `${path}.class`, issues);
  if (present(value, 'label')) checkText(value.label, `${path}.label`, issues, { singleLine: true });
  // the user's own words, stored verbatim (only blank answers are rejected)
  if (present(value, 'user_answer')) checkText(value.user_answer, `${path}.user_answer`, issues);
}

function validateOverrides(value, path, issues) {
  if (!validateOptionalKeys(value, EXECUTOR_CLASSES, path, issues)) return;
  for (const name of EXECUTOR_CLASSES) {
    if (!Object.hasOwn(value, name)) continue;
    const knobs = value[name];
    const knobPath = `${path}.${name}`;
    if (!validateOptionalKeys(knobs, CLASS_KNOBS, knobPath, issues)) continue;
    if (Object.keys(knobs).length === 0) {
      issues.push({ path: knobPath, code: 'invalid_value', message: 'omit a class with no overrides instead of writing {}' });
    }
    for (const knob of CLASS_KNOBS) {
      if (Object.hasOwn(knobs, knob)) {
        // 0 grants nothing: only the envelope cap may be switched off this way
        checkInteger(knobs[knob], `${knobPath}.${knob}`, issues, { min: knob === 'envelope_grant_cap' ? 0 : 1, max: KNOB_MAX });
      }
    }
  }
}

export function validateExecutors(value, options = {}) {
  const form = resolveForm(options, ['stored', 'input']);
  const issues = [];
  if (!validateClosedObject(value, form === 'stored' ? EXECUTORS_KEYS : EXECUTORS_INPUT_KEYS, '$', issues)) {
    return validationResult(issues);
  }
  if (present(value, 'schema')) checkSchemaValue(value.schema, EXECUTORS_SCHEMA, '$.schema', issues);
  if (present(value, 'executors')) {
    if (checkEach(value.executors, '$.executors', issues, (entry, path) => validateExecutor(entry, path, issues))) {
      checkSet(value.executors, '$.executors', issues, {
        sorted: form === 'stored',
        keyOf: (entry) => (isPlainObject(entry) && typeof entry.id === 'string' ? entry.id : null),
        keyPath: '.id',
        fold: true,
      });
    }
  }
  if (present(value, 'class_overrides')) validateOverrides(value.class_overrides, '$.class_overrides', issues);
  if (form === 'stored' && present(value, 'meta')) validateMeta(value.meta, '$.meta', issues);
  return validationResult(issues);
}
