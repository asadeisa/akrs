// The closed `data` schemas of the `test run` events (akrs.event/v1, P2-W14): started, progress, evidence and finding, each
// one closed object told apart by `kind`; `complete` carries the final packet (validated by the generic event schema).
// Events are facts about execution, never estimates.
import { checkEnum, checkId, checkInteger, checkLiteral, checkText, validateClosedObject } from './artifact-kit.js';
import { validateEvent } from './event.js';
import { validateFinding } from './finding.js';
import { issue, validationResult } from './validation.js';
import { EVIDENCE_TYPES, RUN_STEP_STATUSES, SCENARIO_STEPS } from './verification.js';

export const RUN_EVENT_KINDS = Object.freeze({ started: 'run_started', progress: 'run_progress', evidence: 'run_evidence', finding: 'run_finding' });
export const RUN_EVENT_PHASES = Object.freeze([
  'app_launching', 'app_ready', 'app_stopped', 'setup_finished', 'setup_started', 'step_finished', 'step_skipped', 'step_started', 'teardown_finished', 'teardown_started',
]);
const STARTED_KEYS = Object.freeze(['kind', 'plan', 'holder', 'policy', 'steps', 'timeout_ms']);
const PROGRESS_KEYS = Object.freeze(['kind', 'phase', 'index', 'name', 'status', 'duration_ms']);
const EVIDENCE_KEYS = Object.freeze(['kind', 'type', 'name', 'bytes']);
const FINDING_KEYS = Object.freeze(['kind', 'finding']);
const FINISHED = new Set(['step_finished', 'setup_finished', 'teardown_finished']);

const nullable = (value, path, issues, check) => {
  if (value !== null) check(value, path, issues);
};

function checkStarted(data, issues) {
  if (!validateClosedObject(data, STARTED_KEYS, '$.data', issues)) return;
  checkLiteral(data.kind, RUN_EVENT_KINDS.started, '$.data.kind', issues);
  checkId(data.plan, '$.data.plan', issues);
  checkId(data.holder, '$.data.holder', issues);
  checkText(data.policy, '$.data.policy', issues, { singleLine: true });
  checkInteger(data.timeout_ms, '$.data.timeout_ms', issues, { min: 1 });
  if (!Array.isArray(data.steps)) {
    issue(issues, '$.data.steps', 'invalid_type', 'must be an array');
    return;
  }
  data.steps.forEach((entry, index) => {
    const at = `$.data.steps[${index}]`;
    if (!validateClosedObject(entry, ['index', 'step'], at, issues)) return;
    checkInteger(entry.index, `${at}.index`, issues, { min: 0 });
    checkEnum(entry.step, SCENARIO_STEPS, `${at}.step`, issues);
  });
}

function checkProgress(data, issues) {
  if (!validateClosedObject(data, PROGRESS_KEYS, '$.data', issues)) return;
  checkLiteral(data.kind, RUN_EVENT_KINDS.progress, '$.data.kind', issues);
  checkEnum(data.phase, RUN_EVENT_PHASES, '$.data.phase', issues);
  nullable(data.index, '$.data.index', issues, () => checkInteger(data.index, '$.data.index', issues, { min: 0 }));
  nullable(data.name, '$.data.name', issues, () => checkText(data.name, '$.data.name', issues, { singleLine: true }));
  nullable(data.status, '$.data.status', issues, () => checkEnum(data.status, [...RUN_STEP_STATUSES, 'timed_out', 'spawn_failed', 'interrupted'], '$.data.status', issues));
  nullable(data.duration_ms, '$.data.duration_ms', issues, () => checkInteger(data.duration_ms, '$.data.duration_ms', issues, { min: 0 }));
  if (FINISHED.has(data.phase) && data.status === null) issue(issues, '$.data.status', 'invalid_value', 'a finished step or command names its status');
  if (!FINISHED.has(data.phase) && data.phase !== 'step_skipped' && data.status !== null) issue(issues, '$.data.status', 'invalid_value', 'only a finished or skipped step has a status');
}

function checkEvidence(data, issues) {
  if (!validateClosedObject(data, EVIDENCE_KEYS, '$.data', issues)) return;
  checkLiteral(data.kind, RUN_EVENT_KINDS.evidence, '$.data.kind', issues);
  checkEnum(data.type, EVIDENCE_TYPES, '$.data.type', issues);
  checkText(data.name, '$.data.name', issues, { singleLine: true });
  checkInteger(data.bytes, '$.data.bytes', issues, { min: 0 });
}

function checkFinding(data, issues) {
  if (!validateClosedObject(data, FINDING_KEYS, '$.data', issues)) return;
  checkLiteral(data.kind, RUN_EVENT_KINDS.finding, '$.data.kind', issues);
  issues.push(...validateFinding(data.finding, { path: '$.data.finding' }).issues);
}

// The closed data of one non-complete event (the stream has already validated the envelope).
export function validateRunEventData(event) {
  const issues = [];
  const check = { started: checkStarted, progress: checkProgress, evidence: checkEvidence, finding: checkFinding }[event.type];
  if (check === undefined) issue(issues, '$.type', 'invalid_value', 'only started, progress, evidence and finding carry run data');
  else check(event.data, issues);
  return validationResult(issues);
}

// A whole event: the generic envelope first, then the closed data of its type.
export function validateRunEvent(event, { knownCommands } = {}) {
  const envelope = validateEvent(event, { knownCommands });
  if (!envelope.ok || event.type === 'complete') return envelope;
  return validateRunEventData(event);
}
