// The closed `data` schema of `test run` (P2-W14): `test_run` (the scenario ran, or could not run in full, and a run record
// was written) and `test_run_blocked` (nothing was tested and nothing was written). Nothing in it can express a verdict.
import { RUN_BLOCK_REASONS, RUN_REFUSAL_REASONS } from '../scenario/policy.js';
import { checkBoolean, checkEach, checkEnum, checkId, checkInteger, checkLiteral, checkSha, checkText, checkTimestamp, checkUlid, validateClosedObject } from './artifact-kit.js';
import { EVIDENCE_TYPES, RUN_STATUSES, RUN_STEP_STATUSES, SCENARIO_STEPS } from './verification.js';
import { TEST_BLOCKER_REASONS } from './test-details.js';
import { issue, validationResult } from './validation.js';

export const TEST_RUN_SCHEMA = 'akrs.test-run/v1';
export const TEST_RUN_KINDS = Object.freeze(['test_run', 'test_run_blocked']);
export const TEST_RUN_BLOCKED_REASONS = Object.freeze([...RUN_REFUSAL_REASONS, 'lease_held']);
export const TEST_RUN_KEYS = Object.freeze(['kind', 'packet_version', 'plan', 'holder', 'run', 'steps', 'evidence', 'summary', 'lease', 'app', 'setup', 'teardown', 'browser']);
export const TEST_RUN_BLOCKED_KEYS = Object.freeze(['kind', 'packet_version', 'plan', 'reason', 'subject', 'choices', 'blockers']);
export const COMMAND_STATUSES = Object.freeze(['passed', 'failed', 'timed_out', 'spawn_failed', 'interrupted']);
const RUN_KEYS = Object.freeze(['id', 'path', 'status', 'started_at', 'ended_at', 'snapshot', 'contract_hash', 'block']);
const STEP_KEYS = Object.freeze(['index', 'step', 'status', 'soft', 'duration_ms', 'detail', 'evidence']);
const REF_KEYS = Object.freeze(['path', 'type', 'bytes', 'sha256']);
const SUMMARY_KEYS = Object.freeze(['passed', 'failed', 'soft_failed', 'skipped']);
const COMMAND_KEYS = Object.freeze(['name', 'status', 'exit_code', 'duration_ms']);

const known = (value, keys, path, issues) => validateClosedObject(value, keys, path, issues);
const line = (value, path, issues, nullable = false) => checkText(value, path, issues, { singleLine: true, nullable });
const count = (value, path, issues, nullable = false) => checkInteger(value, path, issues, { min: 0, nullable });

function checkRefs(value, path, issues) {
  checkEach(value, path, issues, (entry, at) => {
    if (!known(entry, REF_KEYS, at, issues)) return;
    line(entry.path, `${at}.path`, issues);
    checkEnum(entry.type, EVIDENCE_TYPES, `${at}.type`, issues);
    count(entry.bytes, `${at}.bytes`, issues);
    checkSha(entry.sha256, `${at}.sha256`, issues);
  });
}

function checkCommands(value, path, issues) {
  checkEach(value, path, issues, (entry, at) => {
    if (!known(entry, COMMAND_KEYS, at, issues)) return;
    line(entry.name, `${at}.name`, issues);
    checkEnum(entry.status, COMMAND_STATUSES, `${at}.status`, issues);
    count(entry.exit_code, `${at}.exit_code`, issues, true);
    count(entry.duration_ms, `${at}.duration_ms`, issues, true);
  });
}

export function validateTestRun(value) {
  const issues = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issue(issues, '$', 'invalid_type', 'must be an object');
    return validationResult(issues);
  }
  const blocked = value.kind === 'test_run_blocked';
  if (!blocked && value.kind !== 'test_run') {
    issue(issues, '$.kind', 'invalid_value', `must be one of: ${TEST_RUN_KINDS.join(', ')}`);
    return validationResult(issues);
  }
  if (!known(value, blocked ? TEST_RUN_BLOCKED_KEYS : TEST_RUN_KEYS, '$', issues)) return validationResult(issues);
  checkLiteral(value.packet_version, TEST_RUN_SCHEMA, '$.packet_version', issues);
  checkId(value.plan, '$.plan', issues);
  if (blocked) {
    checkEnum(value.reason, TEST_RUN_BLOCKED_REASONS, '$.reason', issues);
    line(value.subject, '$.subject', issues, true);
    checkEach(value.choices, '$.choices', issues, (entry, at) => checkId(entry, at, issues));
    checkEach(value.blockers, '$.blockers', issues, (entry, at) => {
      if (!known(entry, ['reason', 'subject'], at, issues)) return;
      checkEnum(entry.reason, TEST_BLOCKER_REASONS, `${at}.reason`, issues);
      line(entry.subject, `${at}.subject`, issues, true);
    });
    return validationResult(issues);
  }
  checkId(value.holder, '$.holder', issues);
  if (known(value.run, RUN_KEYS, '$.run', issues)) {
    checkUlid(value.run.id, '$.run.id', issues);
    line(value.run.path, '$.run.path', issues);
    checkEnum(value.run.status, RUN_STATUSES, '$.run.status', issues);
    checkTimestamp(value.run.started_at, '$.run.started_at', issues);
    checkTimestamp(value.run.ended_at, '$.run.ended_at', issues);
    checkSha(value.run.snapshot, '$.run.snapshot', issues);
    checkSha(value.run.contract_hash, '$.run.contract_hash', issues);
    if (value.run.block !== null) checkEnum(value.run.block, RUN_BLOCK_REASONS, '$.run.block', issues);
  }
  checkEach(value.steps, '$.steps', issues, (entry, at) => {
    if (!known(entry, STEP_KEYS, at, issues)) return;
    count(entry.index, `${at}.index`, issues);
    checkEnum(entry.step, SCENARIO_STEPS, `${at}.step`, issues);
    checkEnum(entry.status, RUN_STEP_STATUSES, `${at}.status`, issues);
    checkBoolean(entry.soft, `${at}.soft`, issues);
    count(entry.duration_ms, `${at}.duration_ms`, issues);
    line(entry.detail, `${at}.detail`, issues, true);
    checkRefs(entry.evidence, `${at}.evidence`, issues);
  });
  checkRefs(value.evidence, '$.evidence', issues);
  if (known(value.summary, SUMMARY_KEYS, '$.summary', issues)) for (const key of SUMMARY_KEYS) count(value.summary[key], `$.summary.${key}`, issues);
  if (known(value.lease, ['holder', 'action'], '$.lease', issues)) {
    checkId(value.lease.holder, '$.lease.holder', issues);
    checkEnum(value.lease.action, ['claimed', 'refreshed'], '$.lease.action', issues);
  }
  if (known(value.app, ['ready_ms', 'termination'], '$.app', issues)) {
    count(value.app.ready_ms, '$.app.ready_ms', issues, true);
    checkEnum(value.app.termination, ['none', 'graceful', 'forced'], '$.app.termination', issues);
  }
  checkCommands(value.setup, '$.setup', issues);
  checkCommands(value.teardown, '$.teardown', issues);
  line(value.browser, '$.browser', issues, true);
  return validationResult(issues);
}
