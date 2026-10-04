// The closed `data` schemas of the `verify --road` events (akrs.event/v1, P2-W04). `started`, `progress`, `evidence` and
// `finding` each carry one closed object told apart by `kind`; `complete` carries the final packet (validated by the
// generic event schema). Events are facts about execution, never estimates.
import { VERIFY_CHECK_STATUSES } from './verify-road.js';
import { checkBoolean, checkEnum, checkId, checkInteger, checkLiteral, checkText, checkTextList, validateClosedObject } from './artifact-kit.js';
import { validateFinding } from './finding.js';
import { issue, validationResult } from './validation.js';

export const VERIFY_EVENT_PHASES = Object.freeze(['check_started', 'check_terminating', 'check_finished']);
export const VERIFY_EVENT_REASONS = Object.freeze(['timeout', 'interrupt']);
export const VERIFY_EVENT_STREAMS = Object.freeze(['stdout', 'stderr']);
export const VERIFY_EVENT_KINDS = Object.freeze({
  started: 'verify_started', progress: 'verify_progress', evidence: 'verify_output', finding: 'verify_finding',
});
const STARTED_KEYS = Object.freeze(['kind', 'road', 'mode', 'dry_run', 'checks', 'limits']);
const STARTED_CHECK_KEYS = Object.freeze(['index', 'name', 'argv', 'timeout_ms']);
const LIMIT_KEYS = Object.freeze(['stream_cap_bytes', 'head_bytes', 'tail_bytes', 'grace_ms', 'wait_after_kill_ms']);
const PROGRESS_KEYS = Object.freeze(['kind', 'phase', 'index', 'name', 'status', 'reason', 'exit_code', 'signal', 'duration_ms']);
const EVIDENCE_KEYS = Object.freeze(['kind', 'index', 'name', 'stream', 'total_bytes', 'truncated', 'text', 'tail']);
const FINDING_KEYS = Object.freeze(['kind', 'finding']);

const nullable = (value, path, issues, check) => {
  if (value !== null) check(value, path, issues);
};

function checkStarted(data, issues) {
  if (!validateClosedObject(data, STARTED_KEYS, '$.data', issues)) return;
  checkLiteral(data.kind, VERIFY_EVENT_KINDS.started, '$.data.kind', issues);
  checkId(data.road, '$.data.road', issues);
  checkLiteral(data.mode, 'mechanical', '$.data.mode', issues);
  checkBoolean(data.dry_run, '$.data.dry_run', issues);
  if (!Array.isArray(data.checks)) issue(issues, '$.data.checks', 'invalid_type', 'must be an array');
  else {
    data.checks.forEach((entry, index) => {
      const at = `$.data.checks[${index}]`;
      if (!validateClosedObject(entry, STARTED_CHECK_KEYS, at, issues)) return;
      checkInteger(entry.index, `${at}.index`, issues, { min: 0 });
      checkText(entry.name, `${at}.name`, issues, { singleLine: true });
      checkTextList(entry.argv, `${at}.argv`, issues, { nonEmpty: true });
      checkInteger(entry.timeout_ms, `${at}.timeout_ms`, issues, { min: 1 });
    });
  }
  if (validateClosedObject(data.limits, LIMIT_KEYS, '$.data.limits', issues)) for (const key of LIMIT_KEYS) checkInteger(data.limits[key], `$.data.limits.${key}`, issues, { min: 1 });
}

function checkProgress(data, issues) {
  if (!validateClosedObject(data, PROGRESS_KEYS, '$.data', issues)) return;
  checkLiteral(data.kind, VERIFY_EVENT_KINDS.progress, '$.data.kind', issues);
  checkEnum(data.phase, VERIFY_EVENT_PHASES, '$.data.phase', issues);
  checkInteger(data.index, '$.data.index', issues, { min: 0 });
  checkText(data.name, '$.data.name', issues, { singleLine: true });
  nullable(data.status, '$.data.status', issues, () => checkEnum(data.status, VERIFY_CHECK_STATUSES, '$.data.status', issues));
  nullable(data.reason, '$.data.reason', issues, () => checkEnum(data.reason, VERIFY_EVENT_REASONS, '$.data.reason', issues));
  nullable(data.exit_code, '$.data.exit_code', issues, () => checkInteger(data.exit_code, '$.data.exit_code', issues, { min: 0 }));
  nullable(data.signal, '$.data.signal', issues, () => checkText(data.signal, '$.data.signal', issues, { singleLine: true }));
  nullable(data.duration_ms, '$.data.duration_ms', issues, () => checkInteger(data.duration_ms, '$.data.duration_ms', issues, { min: 0 }));
  if (data.phase === 'check_finished' && data.status === null) issue(issues, '$.data.status', 'invalid_value', 'a finished check names its status');
  if (data.phase !== 'check_finished' && data.status !== null) issue(issues, '$.data.status', 'invalid_value', 'only a finished check has a status');
  if ((data.phase === 'check_terminating') !== (data.reason !== null)) issue(issues, '$.data.reason', 'invalid_value', 'a reason belongs to the terminating phase only');
}

function checkEvidence(data, issues) {
  if (!validateClosedObject(data, EVIDENCE_KEYS, '$.data', issues)) return;
  checkLiteral(data.kind, VERIFY_EVENT_KINDS.evidence, '$.data.kind', issues);
  checkInteger(data.index, '$.data.index', issues, { min: 0 });
  checkText(data.name, '$.data.name', issues, { singleLine: true });
  checkEnum(data.stream, VERIFY_EVENT_STREAMS, '$.data.stream', issues);
  checkInteger(data.total_bytes, '$.data.total_bytes', issues, { min: 1 });
  checkBoolean(data.truncated, '$.data.truncated', issues);
  checkText(data.text, '$.data.text', issues, { allowEmpty: true });
  nullable(data.tail, '$.data.tail', issues, () => checkText(data.tail, '$.data.tail', issues, { allowEmpty: true }));
  if ((data.tail !== null) !== (data.truncated === true)) issue(issues, '$.data', 'invalid_value', 'a tail exists exactly when the stream was truncated');
}

function checkFinding(data, issues) {
  if (!validateClosedObject(data, FINDING_KEYS, '$.data', issues)) return;
  checkLiteral(data.kind, VERIFY_EVENT_KINDS.finding, '$.data.kind', issues);
  issues.push(...validateFinding(data.finding, { path: '$.data.finding' }).issues);
}

// event -> { ok, issues }: the type-specific part of a verify event (the envelope is validateEvent's job).
export function validateVerifyEvent(event) {
  const issues = [];
  const data = event?.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    issue(issues, '$.data', 'invalid_type', 'must be an object');
    return validationResult(issues);
  }
  switch (event.type) {
    case 'started': checkStarted(data, issues); break;
    case 'progress': checkProgress(data, issues); break;
    case 'evidence': checkEvidence(data, issues); break;
    case 'finding': checkFinding(data, issues); break;
    case 'complete': validateClosedObject(data, ['packet'], '$.data', issues); break;
    default: issue(issues, '$.type', 'invalid_value', 'a verify event is started, progress, evidence, finding or complete');
  }
  return validationResult(issues);
}
