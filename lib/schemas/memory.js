// Memory records (Q18): agent-authored input `akrs.memory-input/v1` (JSON) and the stored record
// `akrs.memory-record/v1` rendered as one Markdown table row per record with a hidden id/hash marker.
import { inspectPath } from './glob.js';
import { validateLineRange, validateRepoPath } from './primitives.js';
import {
  checkEach, checkEnum, checkId, checkSchemaValue, checkText, checkUlid, deepFreeze, present,
  validateClosedObject,
} from './artifact-kit.js';
import { issue, validationResult } from './validation.js';

export const MEMORY_INPUT_SCHEMA = 'akrs.memory-input/v1';
export const MEMORY_RECORD_SCHEMA = 'akrs.memory-record/v1';
export const MEMORY_LABELS = Object.freeze(['Decided', 'Assumption High', 'Assumption Med', 'Assumption Low', 'Unknown']);
export const MEMORY_INPUT_KEYS = Object.freeze(['schema', 'topic', 'label', 'decided_by', 'owner_plan', 'text', 'pointers']);
export const MEMORY_RECORD_KEYS = Object.freeze(['id', 'label', 'decided_by', 'owner_plan', 'text', 'pointers']);
export const MEMORY_POINTER_KEYS = Object.freeze(['path', 'lines']);

const POINTER_SPEC = deepFreeze({
  keys: [...MEMORY_POINTER_KEYS], arrays: { lines: { kind: 'ordered', nullable: true } }, objects: {},
});
const arrays = { pointers: { kind: 'ordered', item: POINTER_SPEC } };

// Codec-shape specs (ordering table source); the Markdown row layout is MEMORY_RECORD_SPEC.
export const MEMORY_INPUT_SPEC = deepFreeze({ keys: [...MEMORY_INPUT_KEYS], arrays, objects: {} });
export const MEMORY_RECORD_SHAPE = deepFreeze({ keys: [...MEMORY_RECORD_KEYS], arrays, objects: {} });

// One table row per record: id + marker are written by the codec; `pointers` is a JSON cell.
export const MEMORY_RECORD_SPEC = deepFreeze({
  columns: [
    { key: 'label', header: 'Label', kind: 'text' },
    { key: 'decided_by', header: 'Decided by', kind: 'json' },
    { key: 'owner_plan', header: 'Owner plan', kind: 'json' },
    { key: 'text', header: 'Text', kind: 'text' },
    { key: 'pointers', header: 'Pointers', kind: 'json' },
  ],
});

function validatePointer(value, path, issues) {
  if (!validateClosedObject(value, MEMORY_POINTER_KEYS, path, issues)) return;
  if (present(value, 'path')) validateRepoPath(value.path, `${path}.path`, issues, { allow: ['file', 'dir', 'ephemeral'] });
  if (present(value, 'lines')) {
    validateLineRange(value.lines, `${path}.lines`, issues);
    if (value.lines !== null && typeof value.path === 'string' && inspectPath(value.path).class === 'glob') {
      issue(issues, `${path}.lines`, 'invalid_value', 'a glob pointer has no line window; lines must be null');
    }
  }
}

// Label-dependent rules shared by the input and the stored record.
function validateLabelRules(value, issues) {
  if (!present(value, 'label') || !MEMORY_LABELS.includes(value.label)) return;
  const decided = value.label === 'Decided';
  const unknown = value.label === 'Unknown';
  if (present(value, 'decided_by') && checkId(value.decided_by, '$.decided_by', issues, { nullable: true })) {
    if (decided && value.decided_by === null) issue(issues, '$.decided_by', 'invalid_value', 'a Decided record names the deciding Plan or Road');
    if (!decided && value.decided_by !== null) issue(issues, '$.decided_by', 'invalid_value', 'only Decided records carry decided_by');
  }
  if (present(value, 'owner_plan') && checkId(value.owner_plan, '$.owner_plan', issues, { nullable: true })) {
    if (unknown && value.owner_plan === null) issue(issues, '$.owner_plan', 'invalid_value', 'an Unknown record names the Plan that owns the open question');
    if (!unknown && value.owner_plan !== null) issue(issues, '$.owner_plan', 'invalid_value', 'only Unknown records carry owner_plan');
  }
  if (Array.isArray(value.pointers)) {
    if (unknown && value.pointers.length > 0) issue(issues, '$.pointers', 'invalid_value', 'an Unknown record has no pointers');
    if (!unknown && value.pointers.length === 0) issue(issues, '$.pointers', 'invalid_value', 'a Decided or Assumption record needs at least one pointer');
  }
}

function validateBody(value, issues) {
  if (present(value, 'label')) checkEnum(value.label, MEMORY_LABELS, '$.label', issues);
  if (present(value, 'text')) checkText(value.text, '$.text', issues);
  if (present(value, 'pointers')) {
    checkEach(value.pointers, '$.pointers', issues, (entry, path) => validatePointer(entry, path, issues));
  }
  if (!present(value, 'label') || !MEMORY_LABELS.includes(value.label)) {
    // still shape-check the label-dependent keys so type errors surface where they occur
    if (present(value, 'decided_by')) checkId(value.decided_by, '$.decided_by', issues, { nullable: true });
    if (present(value, 'owner_plan')) checkId(value.owner_plan, '$.owner_plan', issues, { nullable: true });
    return;
  }
  validateLabelRules(value, issues);
}

export function validateMemoryInput(value) {
  const issues = [];
  if (!validateClosedObject(value, MEMORY_INPUT_KEYS, '$', issues)) return validationResult(issues);
  if (present(value, 'schema')) checkSchemaValue(value.schema, MEMORY_INPUT_SCHEMA, '$.schema', issues);
  if (present(value, 'topic')) checkId(value.topic, '$.topic', issues);
  validateBody(value, issues);
  return validationResult(issues);
}

export function validateMemoryRecord(value) {
  const issues = [];
  if (!validateClosedObject(value, MEMORY_RECORD_KEYS, '$', issues)) return validationResult(issues);
  if (present(value, 'id')) checkUlid(value.id, '$.id', issues);
  validateBody(value, issues);
  // a Markdown table cell cannot hold a carriage return; the writer turns input CRLF into LF before storing
  if (typeof value?.text === 'string' && value.text.includes('\r')) {
    issue(issues, '$.text', 'invalid_value', 'a stored record uses LF line breaks only (carriage returns are normalized on write)');
  }
  return validationResult(issues);
}
