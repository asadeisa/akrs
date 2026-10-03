// Handoff and Tester result records (F6, Q22, Q33): JSONL records, one line each. A handoff is a baton
// (what is ready, how to reach it, what to expect) and never changes acceptance; the Tester result owns the
// evidence, the verdict, the findings and the user's acceptance answer.
import {
  checkBoolean, checkEach, checkEnum, checkId, checkInteger, checkName, checkSchemaValue, checkSha, checkText,
  checkTextList, checkTimestamp, checkUlid, checkUnique, deepFreeze, present, resolveForm, resolveWorkflowRoot,
  validateClosedObject,
} from './artifact-kit.js';
import { EVIDENCE_REF_KEYS, validateEvidenceList } from './verification.js';
import { validationResult } from './validation.js';

export const HANDOFF_SCHEMA = 'akrs.handoff/v1';
export const RESULT_SCHEMA = 'akrs.result/v1';
export const HANDOFF_KEYS = Object.freeze(['id', 'hash', 'ts', 'road', 'snapshot', 'result', 'reach', 'expect', 'ready']);
export const HANDOFF_INPUT_KEYS = Object.freeze(['schema', 'road', 'result', 'reach', 'expect']);
export const RESULT_KEYS = Object.freeze([
  'id', 'hash', 'ts', 'plan', 'tested_snapshot', 'contract_hash', 'verdict', 'checks', 'measurements', 'evidence',
  'findings', 'user_acceptance', 'run',
]);
export const RESULT_INPUT_KEYS = Object.freeze([
  'schema', 'verdict', 'checks', 'measurements', 'evidence', 'findings', 'user_acceptance',
]);
export const VERDICTS = Object.freeze(['pass', 'fail', 'blocked']);
export const ACCEPTANCE_ANSWERS = Object.freeze(['yes', 'no']);
export const FINDING_STATUSES = Object.freeze(['open', 'resolved']);
export const RESULT_CHECK_KEYS = Object.freeze(['name', 'passed', 'exit_code']);
export const RESULT_MEASUREMENT_KEYS = Object.freeze(['name', 'value', 'unit', 'within_budget']);
export const RESULT_FINDING_KEYS = Object.freeze(['id', 'text', 'status']);
export const USER_ACCEPTANCE_KEYS = Object.freeze(['answer', 'because']);

const bare = (keys, extra = {}) => ({ keys: [...keys], arrays: {}, objects: {}, ...extra });

export const HANDOFF_SPEC = deepFreeze(bare(HANDOFF_KEYS, { arrays: { reach: { kind: 'ordered' } } }));
export const RESULT_SPEC = deepFreeze(bare(RESULT_KEYS, {
  arrays: {
    checks: { kind: 'ordered', item: bare(RESULT_CHECK_KEYS) },
    measurements: { kind: 'ordered', item: bare(RESULT_MEASUREMENT_KEYS) },
    evidence: { kind: 'set', sortKey: 'path', item: bare(EVIDENCE_REF_KEYS) },
    findings: { kind: 'ordered', item: bare(RESULT_FINDING_KEYS) },
  },
  objects: { user_acceptance: bare(USER_ACCEPTANCE_KEYS) },
}));

export function validateHandoff(value, options = {}) {
  const form = resolveForm(options, ['stored', 'input']);
  const issues = [];
  if (!validateClosedObject(value, form === 'stored' ? HANDOFF_KEYS : HANDOFF_INPUT_KEYS, '$', issues)) {
    return validationResult(issues);
  }
  if (present(value, 'schema')) checkSchemaValue(value.schema, HANDOFF_SCHEMA, '$.schema', issues);
  if (form === 'stored') {
    if (present(value, 'id')) checkUlid(value.id, '$.id', issues);
    if (present(value, 'hash')) checkSha(value.hash, '$.hash', issues);
    if (present(value, 'ts')) checkTimestamp(value.ts, '$.ts', issues);
    if (present(value, 'snapshot')) checkSha(value.snapshot, '$.snapshot', issues);
    if (present(value, 'ready')) checkBoolean(value.ready, '$.ready', issues);
  }
  if (present(value, 'road')) checkId(value.road, '$.road', issues);
  if (present(value, 'result')) checkText(value.result, '$.result', issues);
  if (present(value, 'reach')) checkTextList(value.reach, '$.reach', issues, { nonEmpty: true });
  if (present(value, 'expect')) checkText(value.expect, '$.expect', issues);
  return validationResult(issues);
}

function validateChecks(value, issues) {
  if (!checkEach(value, '$.checks', issues, (entry, path) => {
    if (!validateClosedObject(entry, RESULT_CHECK_KEYS, path, issues)) return;
    if (present(entry, 'name')) checkName(entry.name, `${path}.name`, issues);
    if (present(entry, 'passed')) checkBoolean(entry.passed, `${path}.passed`, issues);
    if (present(entry, 'exit_code')) checkInteger(entry.exit_code, `${path}.exit_code`, issues, { nullable: true });
  })) return;
  checkUnique(value, '$.checks', issues, (entry) => (typeof entry?.name === 'string' ? entry.name : null), '.name');
}

function validateMeasurements(value, issues) {
  if (!checkEach(value, '$.measurements', issues, (entry, path) => {
    if (!validateClosedObject(entry, RESULT_MEASUREMENT_KEYS, path, issues)) return;
    if (present(entry, 'name')) checkName(entry.name, `${path}.name`, issues);
    if (present(entry, 'value')) checkInteger(entry.value, `${path}.value`, issues);
    if (present(entry, 'unit')) checkText(entry.unit, `${path}.unit`, issues, { singleLine: true });
    if (present(entry, 'within_budget')) checkBoolean(entry.within_budget, `${path}.within_budget`, issues);
  })) return;
  checkUnique(value, '$.measurements', issues, (entry) => (typeof entry?.name === 'string' ? entry.name : null), '.name');
}

function validateFindings(value, issues) {
  if (!checkEach(value, '$.findings', issues, (entry, path) => {
    if (!validateClosedObject(entry, RESULT_FINDING_KEYS, path, issues)) return;
    if (present(entry, 'id')) checkId(entry.id, `${path}.id`, issues);
    if (present(entry, 'text')) checkText(entry.text, `${path}.text`, issues);
    if (present(entry, 'status')) checkEnum(entry.status, FINDING_STATUSES, `${path}.status`, issues);
  })) return;
  checkUnique(value, '$.findings', issues, (entry) => (typeof entry?.id === 'string' ? entry.id : null), '.id');
}

export function validateResult(value, options = {}) {
  const form = resolveForm(options, ['stored', 'input']);
  const stored = form === 'stored';
  const workflowRoot = resolveWorkflowRoot(options);
  const issues = [];
  if (!validateClosedObject(value, stored ? RESULT_KEYS : RESULT_INPUT_KEYS, '$', issues)) return validationResult(issues);
  if (present(value, 'schema')) checkSchemaValue(value.schema, RESULT_SCHEMA, '$.schema', issues);
  let plan = null;
  if (stored) {
    if (present(value, 'id')) checkUlid(value.id, '$.id', issues);
    if (present(value, 'hash')) checkSha(value.hash, '$.hash', issues);
    if (present(value, 'ts')) checkTimestamp(value.ts, '$.ts', issues);
    if (present(value, 'plan') && checkId(value.plan, '$.plan', issues)) plan = value.plan;
    if (present(value, 'tested_snapshot')) checkSha(value.tested_snapshot, '$.tested_snapshot', issues);
    if (present(value, 'contract_hash')) checkSha(value.contract_hash, '$.contract_hash', issues);
    if (present(value, 'run')) checkUlid(value.run, '$.run', issues, { nullable: true });
  }
  if (present(value, 'verdict')) checkEnum(value.verdict, VERDICTS, '$.verdict', issues);
  if (present(value, 'checks')) validateChecks(value.checks, issues);
  if (present(value, 'measurements')) validateMeasurements(value.measurements, issues);
  if (present(value, 'evidence')) validateEvidenceList(value.evidence, '$.evidence', issues, { plan, sorted: stored, workflowRoot, input: !stored });
  if (present(value, 'findings')) validateFindings(value.findings, issues);
  if (present(value, 'user_acceptance')
    && validateClosedObject(value.user_acceptance, USER_ACCEPTANCE_KEYS, '$.user_acceptance', issues)) {
    const acceptance = value.user_acceptance;
    if (present(acceptance, 'answer')) checkEnum(acceptance.answer, ACCEPTANCE_ANSWERS, '$.user_acceptance.answer', issues);
    if (present(acceptance, 'because')) checkText(acceptance.because, '$.user_acceptance.because', issues);
  }
  return validationResult(issues);
}
