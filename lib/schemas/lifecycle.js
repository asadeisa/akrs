// The closed `data` schemas of the lifecycle packets (P2-W05): `road_check` (readiness and legal transitions), `road_lifecycle`
// (an applied or previewed activate, finish or reopen) and `lease_release`. A refusal is a `findings` packet with
// AKRS-R025 findings, not one of these shapes. Nothing here can express a Tester verdict or a user acceptance claim.
import { checkBoolean, checkEach, checkEnum, checkId, checkInteger, checkLiteral, checkText, checkTextList, validateClosedObject } from './artifact-kit.js';
import { issue, validationResult } from './validation.js';

export const LIFECYCLE_STATUSES = Object.freeze(['QUEUED', 'ACTIVE', 'DONE']);
export const LIFECYCLE_VERBS = Object.freeze(['activate', 'finish', 'reopen']);
export const CLOSURE_ACTIONS = Object.freeze(['appended', 'already_recorded']);
const CLASSES = Object.freeze(['weak', 'medium', 'frontier']);

export const ROAD_CHECK_KEYS = Object.freeze(['kind', 'road', 'ready', 'needs_split', 'class_fit', 'readiness', 'transitions']);
export const ROAD_LIFECYCLE_KEYS = Object.freeze(['kind', 'transition', 'dry_run', 'road', 'readiness', 'checks', 'audit', 'changed_files', 'closure', 'lease', 'draft']);
export const ROAD_LIFECYCLE_DRY_KEYS = Object.freeze([...ROAD_LIFECYCLE_KEYS, 'would_change', 'proposed']);
export const LEASE_RELEASE_KEYS = Object.freeze(['kind', 'dry_run', 'road', 'released', 'previous_holder']);
const ROAD_REF_KEYS = Object.freeze(['id', 'plan', 'status', 'contract', 'executor_class', 'path']);
const MOVE_KEYS = Object.freeze(['id', 'plan', 'from', 'to', 'path']);
const FIT_KEYS = Object.freeze(['verdict', 'class', 'violations']);
const READINESS_KEYS = Object.freeze(['ready', 'blockers']);
const BLOCKER_KEYS = Object.freeze(['reason', 'subject']);
const TRANSITION_KEYS = Object.freeze(['command', 'verb', 'from', 'to', 'legal', 'blockers', 'requires']);
const SUMMARY_KEYS = Object.freeze(['declared', 'selected', 'passed', 'failed', 'timed_out', 'spawn_failed', 'interrupted', 'not_run']);
const AUDIT_KEYS = Object.freeze(['status', 'reason', 'posture', 'counts']);
const CHANGED_KEYS = Object.freeze(['path', 'category']);
const CLOSURE_KEYS = Object.freeze(['action', 'id', 'segment']);
const LEASE_KEYS = Object.freeze(['holder', 'released']);

const known = (value, keys, path, issues) => validateClosedObject(value, keys, path, issues);
const orNull = (value, path, issues, check) => {
  if (value !== null) check();
};
const line = (value, path, issues, nullable = false) => orNull(nullable && value === null ? null : value, path, issues, () => checkText(value, path, issues, { singleLine: true }));

function checkReadiness(value, path, issues) {
  if (!known(value, READINESS_KEYS, path, issues)) return;
  checkBoolean(value.ready, `${path}.ready`, issues);
  checkEach(value.blockers, `${path}.blockers`, issues, (entry, at) => {
    if (!known(entry, BLOCKER_KEYS, at, issues)) return;
    checkText(entry.reason, `${at}.reason`, issues, { singleLine: true });
    line(entry.subject, `${at}.subject`, issues, true);
  });
  if (value.ready === true && Array.isArray(value.blockers) && value.blockers.length > 0) issue(issues, path, 'invalid_value', 'a ready Road has no blocker');
}

export function validateRoadCheck(value) {
  const issues = [];
  if (!known(value, ROAD_CHECK_KEYS, '$', issues) || issues.length > 0) return validationResult(issues);
  checkLiteral(value.kind, 'road_check', '$.kind', issues);
  if (value.road !== null && known(value.road, ROAD_REF_KEYS, '$.road', issues)) {
    checkId(value.road.id, '$.road.id', issues);
    checkId(value.road.plan, '$.road.plan', issues, { nullable: true });
    checkEnum(value.road.status, LIFECYCLE_STATUSES, '$.road.status', issues);
    checkEnum(value.road.contract, ['declared'], '$.road.contract', issues);
    orNull(value.road.executor_class, '$.road.executor_class', issues, () => checkEnum(value.road.executor_class, CLASSES, '$.road.executor_class', issues));
    checkText(value.road.path, '$.road.path', issues, { singleLine: true });
  }
  checkBoolean(value.ready, '$.ready', issues);
  checkBoolean(value.needs_split, '$.needs_split', issues);
  if (value.class_fit !== null && known(value.class_fit, FIT_KEYS, '$.class_fit', issues)) {
    checkText(value.class_fit.verdict, '$.class_fit.verdict', issues, { singleLine: true });
    checkEnum(value.class_fit.class, CLASSES, '$.class_fit.class', issues);
    checkEach(value.class_fit.violations, '$.class_fit.violations', issues, () => {});
  }
  checkReadiness(value.readiness, '$.readiness', issues);
  checkEach(value.transitions, '$.transitions', issues, (entry, at) => {
    if (!known(entry, TRANSITION_KEYS, at, issues)) return;
    checkText(entry.command, `${at}.command`, issues, { singleLine: true });
    checkEnum(entry.verb, LIFECYCLE_VERBS, `${at}.verb`, issues);
    checkTextList(entry.from, `${at}.from`, issues, { nonEmpty: true, singleLine: true });
    checkEnum(entry.to, LIFECYCLE_STATUSES, `${at}.to`, issues);
    checkBoolean(entry.legal, `${at}.legal`, issues);
    checkEach(entry.blockers, `${at}.blockers`, issues, (blocker, blockerAt) => {
      if (known(blocker, BLOCKER_KEYS, blockerAt, issues)) checkText(blocker.reason, `${blockerAt}.reason`, issues, { singleLine: true });
    });
    checkTextList(entry.requires, `${at}.requires`, issues, { singleLine: true });
  });
  return validationResult(issues);
}

export function validateRoadLifecycle(value) {
  const issues = [];
  const keys = value !== null && typeof value === 'object' && value.dry_run === true ? ROAD_LIFECYCLE_DRY_KEYS : ROAD_LIFECYCLE_KEYS;
  if (!known(value, keys, '$', issues) || issues.length > 0) return validationResult(issues);
  checkLiteral(value.kind, 'road_lifecycle', '$.kind', issues);
  checkEnum(value.transition, LIFECYCLE_VERBS, '$.transition', issues);
  checkBoolean(value.dry_run, '$.dry_run', issues);
  if (known(value.road, MOVE_KEYS, '$.road', issues)) {
    checkId(value.road.id, '$.road.id', issues);
    checkId(value.road.plan, '$.road.plan', issues, { nullable: true });
    checkEnum(value.road.from, LIFECYCLE_STATUSES, '$.road.from', issues);
    checkEnum(value.road.to, LIFECYCLE_STATUSES, '$.road.to', issues);
    checkText(value.road.path, '$.road.path', issues, { singleLine: true });
  }
  if (value.readiness !== null) checkReadiness(value.readiness, '$.readiness', issues);
  if (value.checks !== null && known(value.checks, SUMMARY_KEYS, '$.checks', issues)) {
    for (const key of SUMMARY_KEYS) checkInteger(value.checks[key], `$.checks.${key}`, issues, { min: 0 });
  }
  if (value.audit !== null && known(value.audit, AUDIT_KEYS, '$.audit', issues)) {
    checkEnum(value.audit.status, ['clean', 'findings', 'skipped'], '$.audit.status', issues);
    line(value.audit.reason, '$.audit.reason', issues, true);
    line(value.audit.posture, '$.audit.posture', issues, true);
    if (value.audit.counts !== null && (typeof value.audit.counts !== 'object' || Array.isArray(value.audit.counts))) issue(issues, '$.audit.counts', 'invalid_type', 'must be an object or null');
  }
  checkEach(value.changed_files, '$.changed_files', issues, (entry, at) => {
    if (!known(entry, CHANGED_KEYS, at, issues)) return;
    checkText(entry.path, `${at}.path`, issues, { singleLine: true });
    checkText(entry.category, `${at}.category`, issues, { singleLine: true });
  });
  if (value.closure !== null && known(value.closure, CLOSURE_KEYS, '$.closure', issues)) {
    checkEnum(value.closure.action, CLOSURE_ACTIONS, '$.closure.action', issues);
    line(value.closure.id, '$.closure.id', issues, true);
    line(value.closure.segment, '$.closure.segment', issues, true);
  }
  if (value.lease !== null && known(value.lease, LEASE_KEYS, '$.lease', issues)) {
    checkId(value.lease.holder, '$.lease.holder', issues, { nullable: true });
    checkBoolean(value.lease.released, '$.lease.released', issues);
  }
  const finish = value.transition === 'finish';
  if (finish !== (value.closure !== null)) issue(issues, '$.closure', 'invalid_value', 'exactly a finish carries a closure');
  if ((value.transition === 'activate') !== (value.readiness !== null)) issue(issues, '$.readiness', 'invalid_value', 'exactly an activation carries its readiness');
  if (value.transition === 'activate' && value.lease !== null) issue(issues, '$.lease', 'invalid_value', 'an activation touches no lease');
  return validationResult(issues);
}

export function validateLeaseRelease(value) {
  const issues = [];
  if (!known(value, LEASE_RELEASE_KEYS, '$', issues) || issues.length > 0) return validationResult(issues);
  checkLiteral(value.kind, 'lease_release', '$.kind', issues);
  checkBoolean(value.dry_run, '$.dry_run', issues);
  checkId(value.road, '$.road', issues);
  checkBoolean(value.released, '$.released', issues);
  checkId(value.previous_holder, '$.previous_holder', issues, { nullable: true });
  return validationResult(issues);
}
