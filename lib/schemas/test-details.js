// The closed `data` schema of `test-details` (P2-W06): the Plan-level Tester packet, and `test_details_blocked` when no
// verified contract could be read at all. Nothing in it can express a verdict: the Tester's result is a separate record.
import { checkBoolean, checkEach, checkEnum, checkId, checkInteger, checkLiteral, checkSha, checkText, checkTextList, checkTimestamp, checkUlid, validateClosedObject } from './artifact-kit.js';
import { issue, validationResult } from './validation.js';

export const TEST_DETAILS_SCHEMA = 'akrs.test-details/v1';
export const TEST_DETAILS_KINDS = Object.freeze(['test_details', 'test_details_blocked']);
export const TEST_MODES = Object.freeze(['plan', 'road']);
export const TEST_POLICIES = Object.freeze(['none', 'checks', 'live', 'measured']);
export const TEST_BLOCKER_REASONS = Object.freeze([
  'acceptance_missing', 'changed_during_query', 'contract_missing', 'contract_unverified', 'evidence_types_missing', 'handoff_missing',
  'handoff_unresolved', 'launch_missing', 'ledger_unusable', 'measurement_missing', 'read_unresolved', 'road_missing', 'road_not_done',
  'road_unverified', 'snapshot_unstable',
]);
export const LEASE_STATES = Object.freeze(['none', 'fresh', 'stale', 'unreadable']);
export const TEST_DETAILS_KEYS = Object.freeze([
  'kind', 'packet_version', 'plan', 'mode', 'tested_snapshot', 'policy', 'contract', 'roads', 'reads', 'acceptance', 'launch', 'setup', 'teardown', 'checks',
  'diff', 'handoffs', 'measurements', 'evidence_slots', 'previous_failures', 'reachability', 'boundaries', 'timeout_ms', 'allowed_hosts', 'scenario', 'runs', 'run_problems',
  'permissions', 'lease', 'tester', 'coverage', 'blockers',
]);
export const TEST_BLOCKED_KEYS = Object.freeze(['kind', 'packet_version', 'plan', 'mode', 'blockers']);
const CONTRACT_KEYS = Object.freeze(['hash', 'path', 'meta_state']);
const ROAD_KEYS = Object.freeze(['id', 'plan', 'status', 'contract', 'executor_class', 'path']);
const READ_KEYS = Object.freeze(['index', 'path', 'window', 'kind', 'status', 'why', 'line_count']);
const COMMAND_KEYS = Object.freeze(['name', 'argv']);
const CHECK_KEYS = Object.freeze(['road', 'name', 'argv', 'timeout_ms', 'last_result']);
const LAST_KEYS = Object.freeze(['result', 'passed', 'exit_code', 'current']);
const DIFF_KEYS = Object.freeze(['pinned_to', 'files', 'declared_absent']);
const FILE_KEYS = Object.freeze(['path', 'kind', 'sha256', 'declared_by']);
const ABSENT_KEYS = Object.freeze(['road', 'path', 'action']);
const HANDOFF_KEYS = Object.freeze(['id', 'ts', 'road', 'snapshot', 'result', 'reach', 'expect', 'ready']);
const SLOT_KEYS = Object.freeze(['type', 'directory', 'filled']);
const FAILURE_KEYS = Object.freeze(['id', 'ts', 'verdict', 'tested_snapshot', 'contract_hash', 'current', 'counts_as_pass', 'open_findings']);
const PERMISSION_KEYS = Object.freeze(['product_code_write', 'may_write']);
const MAY_WRITE_KEYS = Object.freeze(['what', 'where']);
const LEASE_KEYS = Object.freeze(['holder', 'state']);
const TESTER_KEYS = Object.freeze(['holder', 'class', 'run_required']);
const COVERAGE_KEYS = Object.freeze(['required', 'roads', 'reads', 'handoffs', 'acceptance', 'measurements', 'evidence_types', 'blockers']);
const BLOCKER_KEYS = Object.freeze(['reason', 'subject']);
const RUN_SLOT_KEYS = Object.freeze(['id', 'path', 'status', 'started_at', 'snapshot', 'contract_hash', 'current', 'hard_failures']);
const RUN_PROBLEM_KEYS = Object.freeze(['id', 'reason']);

const known = (value, keys, path, issues) => validateClosedObject(value, keys, path, issues);
const line = (value, path, issues, nullable = false) => {
  if (!(nullable && value === null)) checkText(value, path, issues, { singleLine: true });
};
const each = (value, path, issues, keys, body) => checkEach(value, path, issues, (entry, at) => {
  if (known(entry, keys, at, issues)) body(entry, at);
});

function checkBlockers(value, path, issues) {
  each(value, path, issues, BLOCKER_KEYS, (entry, at) => {
    checkEnum(entry.reason, TEST_BLOCKER_REASONS, `${at}.reason`, issues);
    line(entry.subject, `${at}.subject`, issues, true);
  });
}

export function validateTestDetails(value) {
  const issues = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issue(issues, '$', 'invalid_type', 'must be an object');
    return validationResult(issues);
  }
  const blocked = value.kind === 'test_details_blocked';
  if (!known(value, blocked ? TEST_BLOCKED_KEYS : TEST_DETAILS_KEYS, '$', issues) || issues.length > 0) return validationResult(issues);
  checkEnum(value.kind, TEST_DETAILS_KINDS, '$.kind', issues);
  checkLiteral(value.packet_version, TEST_DETAILS_SCHEMA, '$.packet_version', issues);
  checkId(value.plan, '$.plan', issues);
  checkEnum(value.mode, TEST_MODES, '$.mode', issues);
  checkBlockers(value.blockers, '$.blockers', issues);
  if (blocked) return validationResult(issues);
  checkSha(value.tested_snapshot, '$.tested_snapshot', issues);
  checkEnum(value.policy, TEST_POLICIES, '$.policy', issues);
  if (known(value.contract, CONTRACT_KEYS, '$.contract', issues)) {
    checkSha(value.contract.hash, '$.contract.hash', issues);
    line(value.contract.path, '$.contract.path', issues);
    checkLiteral(value.contract.meta_state, 'declared', '$.contract.meta_state', issues);
  }
  each(value.roads, '$.roads', issues, ROAD_KEYS, (entry, at) => {
    checkId(entry.id, `${at}.id`, issues);
    checkId(entry.plan, `${at}.plan`, issues, { nullable: true });
    line(entry.status, `${at}.status`, issues, true);
    line(entry.contract, `${at}.contract`, issues, true);
    line(entry.executor_class, `${at}.executor_class`, issues, true);
    line(entry.path, `${at}.path`, issues, true);
  });
  each(value.reads, '$.reads', issues, READ_KEYS, (entry, at) => {
    checkInteger(entry.index, `${at}.index`, issues, { min: 0 });
    line(entry.path, `${at}.path`, issues);
    if (entry.window !== null && known(entry.window, ['lines'], `${at}.window`, issues)) checkEach(entry.window.lines, `${at}.window.lines`, issues, (n, nAt) => checkInteger(n, nAt, issues, { min: 1 }));
    line(entry.kind, `${at}.kind`, issues);
    line(entry.status, `${at}.status`, issues);
    line(entry.why, `${at}.why`, issues, true);
    if (entry.line_count !== null) checkInteger(entry.line_count, `${at}.line_count`, issues, { min: 0 });
  });
  checkTextList(value.acceptance, '$.acceptance', issues);
  if (value.launch !== null && (typeof value.launch !== 'object' || Array.isArray(value.launch))) issue(issues, '$.launch', 'invalid_type', 'must be an object or null');
  for (const name of ['setup', 'teardown']) each(value[name], `$.${name}`, issues, COMMAND_KEYS, (entry, at) => { line(entry.name, `${at}.name`, issues); checkTextList(entry.argv, `${at}.argv`, issues, { nonEmpty: true }); });
  each(value.checks, '$.checks', issues, CHECK_KEYS, (entry, at) => {
    checkId(entry.road, `${at}.road`, issues);
    line(entry.name, `${at}.name`, issues);
    checkTextList(entry.argv, `${at}.argv`, issues, { nonEmpty: true });
    checkInteger(entry.timeout_ms, `${at}.timeout_ms`, issues, { min: 1 });
    if (entry.last_result !== null && known(entry.last_result, LAST_KEYS, `${at}.last_result`, issues)) {
      checkText(entry.last_result.result, `${at}.last_result.result`, issues, { singleLine: true });
      checkBoolean(entry.last_result.passed, `${at}.last_result.passed`, issues);
      if (entry.last_result.exit_code !== null) checkInteger(entry.last_result.exit_code, `${at}.last_result.exit_code`, issues, { min: 0 });
      checkBoolean(entry.last_result.current, `${at}.last_result.current`, issues);
    }
  });
  if (known(value.diff, DIFF_KEYS, '$.diff', issues)) {
    checkSha(value.diff.pinned_to, '$.diff.pinned_to', issues);
    each(value.diff.files, '$.diff.files', issues, FILE_KEYS, (entry, at) => {
      line(entry.path, `${at}.path`, issues);
      line(entry.kind, `${at}.kind`, issues);
      checkSha(entry.sha256, `${at}.sha256`, issues);
      checkTextList(entry.declared_by, `${at}.declared_by`, issues, { singleLine: true });
    });
    each(value.diff.declared_absent, '$.diff.declared_absent', issues, ABSENT_KEYS, (entry, at) => {
      checkId(entry.road, `${at}.road`, issues);
      line(entry.path, `${at}.path`, issues);
      line(entry.action, `${at}.action`, issues);
    });
  }
  each(value.handoffs, '$.handoffs', issues, HANDOFF_KEYS, (entry, at) => {
    checkText(entry.id, `${at}.id`, issues, { singleLine: true });
    checkText(entry.ts, `${at}.ts`, issues, { singleLine: true });
    checkId(entry.road, `${at}.road`, issues);
    checkSha(entry.snapshot, `${at}.snapshot`, issues);
    checkText(entry.result, `${at}.result`, issues);
    checkTextList(entry.reach, `${at}.reach`, issues);
    checkText(entry.expect, `${at}.expect`, issues);
    checkBoolean(entry.ready, `${at}.ready`, issues);
  });
  checkEach(value.measurements, '$.measurements', issues, () => {});
  each(value.evidence_slots, '$.evidence_slots', issues, SLOT_KEYS, (entry, at) => {
    line(entry.type, `${at}.type`, issues);
    line(entry.directory, `${at}.directory`, issues);
    checkBoolean(entry.filled, `${at}.filled`, issues);
  });
  each(value.previous_failures, '$.previous_failures', issues, FAILURE_KEYS, (entry, at) => {
    checkText(entry.id, `${at}.id`, issues, { singleLine: true });
    checkText(entry.ts, `${at}.ts`, issues, { singleLine: true });
    checkEnum(entry.verdict, ['fail', 'blocked'], `${at}.verdict`, issues);
    checkSha(entry.tested_snapshot, `${at}.tested_snapshot`, issues);
    checkSha(entry.contract_hash, `${at}.contract_hash`, issues);
    checkBoolean(entry.current, `${at}.current`, issues);
    checkLiteral(entry.counts_as_pass, false, `${at}.counts_as_pass`, issues);
    checkEach(entry.open_findings, `${at}.open_findings`, issues, () => {});
  });
  checkTextList(value.reachability, '$.reachability', issues);
  checkTextList(value.boundaries, '$.boundaries', issues, { nonEmpty: true });
  checkInteger(value.timeout_ms, '$.timeout_ms', issues, { min: 1 });
  checkTextList(value.allowed_hosts, '$.allowed_hosts', issues, { singleLine: true });
  checkEach(value.scenario, '$.scenario', issues, () => {});
  each(value.runs, '$.runs', issues, RUN_SLOT_KEYS, (entry, at) => {
    checkUlid(entry.id, `${at}.id`, issues);
    line(entry.path, `${at}.path`, issues);
    checkEnum(entry.status, ['passed', 'failed', 'blocked'], `${at}.status`, issues);
    checkTimestamp(entry.started_at, `${at}.started_at`, issues);
    checkSha(entry.snapshot, `${at}.snapshot`, issues);
    checkSha(entry.contract_hash, `${at}.contract_hash`, issues);
    checkBoolean(entry.current, `${at}.current`, issues);
    checkInteger(entry.hard_failures, `${at}.hard_failures`, issues, { min: 0 });
  });
  each(value.run_problems, '$.run_problems', issues, RUN_PROBLEM_KEYS, (entry, at) => {
    checkUlid(entry.id, `${at}.id`, issues);
    checkEnum(entry.reason, ['incomplete', 'invalid_record', 'unsafe'], `${at}.reason`, issues);
  });
  if (known(value.permissions, PERMISSION_KEYS, '$.permissions', issues)) {
    checkLiteral(value.permissions.product_code_write, false, '$.permissions.product_code_write', issues);
    each(value.permissions.may_write, '$.permissions.may_write', issues, MAY_WRITE_KEYS, (entry, at) => {
      checkEnum(entry.what, ['evidence', 'result'], `${at}.what`, issues);
      line(entry.where, `${at}.where`, issues);
    });
  }
  if (known(value.lease, LEASE_KEYS, '$.lease', issues)) {
    checkId(value.lease.holder, '$.lease.holder', issues, { nullable: true });
    checkEnum(value.lease.state, LEASE_STATES, '$.lease.state', issues);
  }
  if (known(value.tester, TESTER_KEYS, '$.tester', issues)) {
    checkId(value.tester.holder, '$.tester.holder', issues, { nullable: true });
    line(value.tester.class, '$.tester.class', issues, true);
    checkBoolean(value.tester.run_required, '$.tester.run_required', issues);
  }
  if (known(value.coverage, COVERAGE_KEYS, '$.coverage', issues)) {
    checkBoolean(value.coverage.required, '$.coverage.required', issues);
    for (const name of ['roads', 'reads', 'handoffs']) checkText(value.coverage[name], `$.coverage.${name}`, issues, { singleLine: true });
    for (const name of ['acceptance', 'measurements', 'evidence_types', 'blockers']) checkInteger(value.coverage[name], `$.coverage.${name}`, issues, { min: 0 });
    if (Array.isArray(value.blockers) && value.coverage.blockers !== value.blockers.length) issue(issues, '$.coverage.blockers', 'invalid_value', 'must equal the number of blockers');
  }
  return validationResult(issues);
}
