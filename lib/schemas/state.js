// State `akrs.state/v1` (Q20): the agent-authored fields plus CLI-owned `updated {at, by}` and `meta`.
// Open questions are not stored here; they are a projection of the Plan files (Q13).
import {
  checkEnum, checkId, checkInteger, checkSchemaValue, checkText, checkTimestamp, deepFreeze, present, resolveForm,
  validateClosedObject, validateMeta,
} from './artifact-kit.js';
import { validationResult } from './validation.js';

export const STATE_SCHEMA = 'akrs.state/v1';
export const STATE_KEYS = Object.freeze(['schema', 'mode', 'role', 'plan', 'phase', 'task', 'next', 'updated', 'meta']);
export const STATE_INPUT_KEYS = Object.freeze(['schema', 'mode', 'role', 'plan', 'phase', 'task', 'next']);
export const STATE_MODES = Object.freeze([0, 1, 2, 3, 4]);
export const STATE_ROLES = Object.freeze(['leader', 'worker', 'tester']);
export const STATE_UPDATED_KEYS = Object.freeze(['at', 'by']);

// Canonical codec spec (the CLI-owned `meta` key is appended by `storedSpec`).
export const STATE_SPEC = deepFreeze({
  keys: STATE_KEYS.filter((key) => key !== 'meta'),
  arrays: {},
  objects: { updated: { keys: [...STATE_UPDATED_KEYS], arrays: {}, objects: {} } },
});

export function validateState(value, options = {}) {
  const form = resolveForm(options, ['stored', 'input']);
  const issues = [];
  if (!validateClosedObject(value, form === 'stored' ? STATE_KEYS : STATE_INPUT_KEYS, '$', issues)) {
    return validationResult(issues);
  }
  if (present(value, 'schema')) checkSchemaValue(value.schema, STATE_SCHEMA, '$.schema', issues);
  if (present(value, 'mode')) {
    checkInteger(value.mode, '$.mode', issues, { min: STATE_MODES[0], max: STATE_MODES.at(-1) });
  }
  if (present(value, 'role')) checkEnum(value.role, STATE_ROLES, '$.role', issues);
  if (present(value, 'plan')) checkId(value.plan, '$.plan', issues, { nullable: true });
  if (present(value, 'phase')) checkText(value.phase, '$.phase', issues, { nullable: true });
  if (present(value, 'task')) checkId(value.task, '$.task', issues, { nullable: true });
  if (present(value, 'next')) checkText(value.next, '$.next', issues, { nullable: true });
  if (form === 'stored') {
    if (present(value, 'updated') && validateClosedObject(value.updated, STATE_UPDATED_KEYS, '$.updated', issues)) {
      if (present(value.updated, 'at')) checkTimestamp(value.updated.at, '$.updated.at', issues);
      if (present(value.updated, 'by')) checkText(value.updated.by, '$.updated.by', issues, { singleLine: true });
    }
    if (present(value, 'meta')) validateMeta(value.meta, '$.meta', issues);
  }
  return validationResult(issues);
}
