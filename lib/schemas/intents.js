// The closed `data` schemas of the intent commands (P2-W12): work / work_blocked, done / done_blocked, yield / yield_blocked, boot and
// guard. An intent embeds the sub-results of the primitives it composes (the Worker packet, the finish data, the handoff record) and adds
// only what it decided; nothing here can express a Tester verdict, a hash the agent typed or a snapshot.
import {
  BOOT_SCHEMA, CLAIM_ACTIONS, DONE_SCHEMA, GUARD_PACKET_SCHEMA, QUESTION_KINDS, WORK_SCHEMA, YIELD_SCHEMA,
} from '../store/intents/policy.js';
import { GUARD_ALLOW_REASONS, GUARD_DECISIONS, GUARD_DENY_REASONS } from '../store/intents/guard-core.js';
import { checkBoolean, checkEach, checkEnum, checkId, checkInteger, checkLiteral, checkSha, checkText, checkTextList, checkUlid, validateClosedObject } from './artifact-kit.js';
import { validateRoadLifecycle } from './lifecycle.js';
import { validateRoadDetails } from './road-details.js';
import { issue, validationResult } from './validation.js';

const CLASSES = ['weak', 'medium', 'frontier'];
const HOLDER_SOURCES = ['env', 'flag', 'only_executor_of_role'];
const known = (value, keys, path, issues) => validateClosedObject(value, keys, path, issues);
const line = (value, path, issues, nullable = false) => checkText(value, path, issues, { nullable, singleLine: true });
const head = (value, schema, kind, keys, issues) => {
  if (!known(value, keys, '$', issues)) return false;
  checkLiteral(value.kind, kind, '$.kind', issues);
  checkLiteral(value.packet_version, schema, '$.packet_version', issues);
  return true;
};
const blockerList = (value, path, issues, keys = ['reason', 'subject']) => checkEach(value, path, issues, (entry, at) => {
  if (!known(entry, keys, at, issues)) return;
  line(entry.reason, `${at}.reason`, issues);
  line(entry.subject, `${at}.subject`, issues, true);
  if (keys.includes('fix')) line(entry.fix, `${at}.fix`, issues);
});

// ---- work ------------------------------------------------------------------------------------------------------------
export const WORK_KEYS = Object.freeze(['kind', 'packet_version', 'executor', 'road', 'claim', 'guard', 'done', 'details']);
export function validateWork(value) {
  const issues = [];
  if (!head(value, WORK_SCHEMA, 'work', WORK_KEYS, issues) || issues.length > 0) return validationResult(issues);
  if (known(value.executor, ['id', 'class', 'source'], '$.executor', issues)) {
    checkId(value.executor.id, '$.executor.id', issues);
    checkEnum(value.executor.class, CLASSES, '$.executor.class', issues);
    checkEnum(value.executor.source, HOLDER_SOURCES, '$.executor.source', issues);
  }
  checkId(value.road, '$.road', issues);
  if (known(value.claim, ['action', 'previous_holder'], '$.claim', issues)) {
    checkEnum(value.claim.action, CLAIM_ACTIONS, '$.claim.action', issues);
    checkId(value.claim.previous_holder, '$.claim.previous_holder', issues, { nullable: true });
  }
  if (known(value.guard, ['path', 'writes', 'forbidden'], '$.guard', issues)) {
    line(value.guard.path, '$.guard.path', issues);
    checkInteger(value.guard.writes, '$.guard.writes', issues, { min: 0 });
    checkInteger(value.guard.forbidden, '$.guard.forbidden', issues, { min: 0 });
  }
  if (known(value.done, ['requires', 'failures_before_yield'], '$.done', issues)) {
    checkTextList(value.done.requires, '$.done.requires', issues, { singleLine: true });
    if (value.done.failures_before_yield !== null) checkInteger(value.done.failures_before_yield, '$.done.failures_before_yield', issues, { min: 1 });
  }
  const details = validateRoadDetails(value.details);
  for (const entry of details.issues) issue(issues, `$.details${entry.path.slice(1)}`, entry.code, entry.message);
  if (details.ok && value.details.road.id !== value.road) issue(issues, '$.details.road.id', 'invalid_value', 'must be the Road that was claimed');
  return validationResult(issues);
}

export const WORK_BLOCKED_KEYS = Object.freeze(['kind', 'packet_version', 'reason', 'road', 'holder', 'subject', 'choices', 'candidates', 'blockers']);
export function validateWorkBlocked(value) {
  const issues = [];
  if (!head(value, WORK_SCHEMA, 'work_blocked', WORK_BLOCKED_KEYS, issues) || issues.length > 0) return validationResult(issues);
  line(value.reason, '$.reason', issues);
  checkId(value.road, '$.road', issues, { nullable: true });
  checkId(value.holder, '$.holder', issues, { nullable: true });
  line(value.subject, '$.subject', issues, true);
  checkEach(value.choices, '$.choices', issues, (entry, at) => checkId(entry, at, issues));
  checkEach(value.candidates, '$.candidates', issues, (entry, at) => {
    if (!known(entry, ['road', 'reason', 'subject'], at, issues)) return;
    checkId(entry.road, `${at}.road`, issues);
    line(entry.reason, `${at}.reason`, issues);
    line(entry.subject, `${at}.subject`, issues, true);
  });
  blockerList(value.blockers, '$.blockers', issues);
  return validationResult(issues);
}

// ---- done ------------------------------------------------------------------------------------------------------------
const HANDOFF_REF_KEYS = ['id', 'plan', 'road', 'snapshot', 'ready', 'path', 'line', 'hash'];
export const DONE_ONLY_KEYS = Object.freeze(['packet_version', 'holder', 'handoff']);
export function validateDone(value) {
  const issues = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return validationResult([{ path: '$', code: 'invalid_type', message: 'must be an object' }]);
  const { packet_version: version, holder, handoff, ...rest } = value;
  checkLiteral(version, DONE_SCHEMA, '$.packet_version', issues);
  checkLiteral(value.kind, 'done', '$.kind', issues);
  const finish = validateRoadLifecycle({ ...rest, kind: 'road_lifecycle' });
  for (const entry of finish.issues) issues.push({ ...entry });
  if (finish.ok && rest.transition !== 'finish') issue(issues, '$.transition', 'invalid_value', 'done finishes a Road');
  checkId(holder, '$.holder', issues);
  if (known(handoff, HANDOFF_REF_KEYS, '$.handoff', issues)) {
    checkUlid(handoff.id, '$.handoff.id', issues, { nullable: true });
    checkId(handoff.plan, '$.handoff.plan', issues);
    checkId(handoff.road, '$.handoff.road', issues);
    checkSha(handoff.snapshot, '$.handoff.snapshot', issues);
    checkBoolean(handoff.ready, '$.handoff.ready', issues);
    line(handoff.path, '$.handoff.path', issues);
    checkInteger(handoff.line, '$.handoff.line', issues, { min: 1 });
    checkSha(handoff.hash, '$.handoff.hash', issues, { nullable: true });
  }
  return validationResult(issues);
}

export const DONE_BLOCKED_KEYS = Object.freeze([
  'kind', 'packet_version', 'reason', 'road', 'holder', 'subject', 'blockers', 'checks', 'audit', 'changed_files', 'attempts', 'delta', 'fresh',
]);
export function validateDoneBlocked(value) {
  const issues = [];
  if (!head(value, DONE_SCHEMA, 'done_blocked', DONE_BLOCKED_KEYS, issues) || issues.length > 0) return validationResult(issues);
  line(value.reason, '$.reason', issues);
  checkId(value.road, '$.road', issues);
  checkId(value.holder, '$.holder', issues, { nullable: true });
  line(value.subject, '$.subject', issues, true);
  blockerList(value.blockers, '$.blockers', issues, ['reason', 'subject', 'fix']);
  if (value.checks !== null && (typeof value.checks !== 'object' || Array.isArray(value.checks))) issue(issues, '$.checks', 'invalid_type', 'must be an object or null');
  if (value.audit !== null && (typeof value.audit !== 'object' || Array.isArray(value.audit))) issue(issues, '$.audit', 'invalid_type', 'must be an object or null');
  checkEach(value.changed_files, '$.changed_files', issues, () => {});
  if (value.attempts !== null && known(value.attempts, ['failures', 'limit'], '$.attempts', issues)) {
    checkInteger(value.attempts.failures, '$.attempts.failures', issues, { min: 0 });
    checkInteger(value.attempts.limit, '$.attempts.limit', issues, { min: 1 });
  }
  if (value.delta !== null && known(value.delta, ['changed', 'added', 'removed'], '$.delta', issues)) {
    for (const name of ['changed', 'added', 'removed']) checkTextList(value.delta[name], `$.delta.${name}`, issues, { singleLine: true });
  }
  if (value.fresh !== null && known(value.fresh, ['status', 'data'], '$.fresh', issues)) {
    line(value.fresh.status, '$.fresh.status', issues);
    const details = validateRoadDetails(value.fresh.data);
    for (const entry of details.issues) issue(issues, `$.fresh.data${entry.path.slice(1)}`, entry.code, entry.message);
  }
  return validationResult(issues);
}

// ---- yield -----------------------------------------------------------------------------------------------------------
export const YIELD_KEYS = Object.freeze(['kind', 'packet_version', 'road', 'holder', 'reason', 'yielded', 'needs_split', 'lease', 'question_for_leader', 'draft', 'dry_run']);
export const YIELD_DRY_KEYS = Object.freeze([...YIELD_KEYS, 'would_change', 'proposed']);
export function validateYield(value) {
  const issues = [];
  const keys = value !== null && typeof value === 'object' && value.dry_run === true ? YIELD_DRY_KEYS : YIELD_KEYS;
  if (!head(value, YIELD_SCHEMA, 'yield', keys, issues) || issues.length > 0) return validationResult(issues);
  checkId(value.road, '$.road', issues);
  checkId(value.holder, '$.holder', issues);
  checkText(value.reason, '$.reason', issues);
  if (known(value.yielded, ['id', 'hash', 'path'], '$.yielded', issues)) {
    checkUlid(value.yielded.id, '$.yielded.id', issues, { nullable: true });
    checkSha(value.yielded.hash, '$.yielded.hash', issues, { nullable: true });
    line(value.yielded.path, '$.yielded.path', issues);
  }
  checkLiteral(value.needs_split, true, '$.needs_split', issues);
  if (known(value.lease, ['holder', 'released'], '$.lease', issues)) {
    checkId(value.lease.holder, '$.lease.holder', issues);
    checkBoolean(value.lease.released, '$.lease.released', issues);
  }
  if (known(value.question_for_leader, ['kind', 'subject', 'text'], '$.question_for_leader', issues)) {
    checkEnum(value.question_for_leader.kind, QUESTION_KINDS, '$.question_for_leader.kind', issues);
    checkId(value.question_for_leader.subject, '$.question_for_leader.subject', issues);
    checkText(value.question_for_leader.text, '$.question_for_leader.text', issues);
  }
  return validationResult(issues);
}

export const YIELD_BLOCKED_KEYS = Object.freeze(['kind', 'packet_version', 'reason', 'road', 'holder', 'subject']);
export function validateYieldBlocked(value) {
  const issues = [];
  if (!head(value, YIELD_SCHEMA, 'yield_blocked', YIELD_BLOCKED_KEYS, issues) || issues.length > 0) return validationResult(issues);
  line(value.reason, '$.reason', issues);
  checkId(value.road, '$.road', issues);
  checkId(value.holder, '$.holder', issues, { nullable: true });
  line(value.subject, '$.subject', issues, true);
  return validationResult(issues);
}

// ---- boot ------------------------------------------------------------------------------------------------------------
export const BOOT_KEYS = Object.freeze(['kind', 'packet_version', 'role', 'kernel', 'workflow', 'questions_for_user', 'class_fit_blockers', 'needs_split', 'pending_scope_requests', 'next']);
export function validateBoot(value) {
  const issues = [];
  if (!head(value, BOOT_SCHEMA, 'boot', BOOT_KEYS, issues) || issues.length > 0) return validationResult(issues);
  checkLiteral(value.role, 'leader', '$.role', issues);
  if (known(value.kernel, ['core', 'leader'], '$.kernel', issues)) {
    for (const name of ['core', 'leader']) {
      const file = value.kernel[name];
      if (file !== null && known(file, ['path', 'bytes', 'text'], `$.kernel.${name}`, issues)) {
        line(file.path, `$.kernel.${name}.path`, issues);
        checkInteger(file.bytes, `$.kernel.${name}.bytes`, issues, { min: 0 });
        if (file.text !== null) checkText(file.text, `$.kernel.${name}.text`, issues, { allowEmpty: true });
      }
    }
  }
  if (known(value.workflow, ['roads', 'plans', 'executors', 'leases'], '$.workflow', issues)) {
    if (known(value.workflow.roads, ['total', 'by_status', 'unverified'], '$.workflow.roads', issues)) {
      checkInteger(value.workflow.roads.total, '$.workflow.roads.total', issues, { min: 0 });
      checkInteger(value.workflow.roads.unverified, '$.workflow.roads.unverified', issues, { min: 0 });
      if (known(value.workflow.roads.by_status, ['ACTIVE', 'DONE', 'QUEUED'], '$.workflow.roads.by_status', issues)) {
        for (const name of ['ACTIVE', 'DONE', 'QUEUED']) checkInteger(value.workflow.roads.by_status[name], `$.workflow.roads.by_status.${name}`, issues, { min: 0 });
      }
    }
    if (known(value.workflow.plans, ['total', 'closed'], '$.workflow.plans', issues)) {
      checkInteger(value.workflow.plans.total, '$.workflow.plans.total', issues, { min: 0 });
      checkInteger(value.workflow.plans.closed, '$.workflow.plans.closed', issues, { min: 0 });
    }
    checkEach(value.workflow.executors, '$.workflow.executors', issues, (entry, at) => {
      if (!known(entry, ['id', 'role', 'class'], at, issues)) return;
      checkId(entry.id, `${at}.id`, issues);
      line(entry.role, `${at}.role`, issues);
      line(entry.class, `${at}.class`, issues, true);
    });
    checkEach(value.workflow.leases, '$.workflow.leases', issues, (entry, at) => {
      if (!known(entry, ['kind', 'target', 'holder', 'state'], at, issues)) return;
      line(entry.kind, `${at}.kind`, issues);
      checkId(entry.target, `${at}.target`, issues);
      checkId(entry.holder, `${at}.holder`, issues, { nullable: true });
      line(entry.state, `${at}.state`, issues);
    });
  }
  checkEach(value.questions_for_user, '$.questions_for_user', issues, (entry, at) => {
    if (!known(entry, ['kind', 'subject', 'text'], at, issues)) return;
    checkEnum(entry.kind, QUESTION_KINDS, `${at}.kind`, issues);
    line(entry.subject, `${at}.subject`, issues);
    checkText(entry.text, `${at}.text`, issues);
  });
  checkEach(value.class_fit_blockers, '$.class_fit_blockers', issues, (entry, at) => {
    if (!known(entry, ['road', 'class', 'reasons'], at, issues)) return;
    checkId(entry.road, `${at}.road`, issues);
    line(entry.class, `${at}.class`, issues, true);
    blockerList(entry.reasons, `${at}.reasons`, issues);
  });
  checkEach(value.needs_split, '$.needs_split', issues, (entry, at) => {
    if (!known(entry, ['road', 'holder', 'reason'], at, issues)) return;
    checkId(entry.road, `${at}.road`, issues);
    checkId(entry.holder, `${at}.holder`, issues, { nullable: true });
    checkText(entry.reason, `${at}.reason`, issues, { nullable: true });
  });
  checkEach(value.pending_scope_requests, '$.pending_scope_requests', issues, (entry, at) => {
    if (!known(entry, ['id', 'road', 'blocking'], at, issues)) return;
    checkUlid(entry.id, `${at}.id`, issues);
    checkId(entry.road, `${at}.road`, issues);
    checkBoolean(entry.blocking, `${at}.blocking`, issues);
  });
  if (value.next === null || typeof value.next !== 'object' || Array.isArray(value.next)) issue(issues, '$.next', 'invalid_type', 'must be the next-action object');
  return validationResult(issues);
}

// ---- guard -----------------------------------------------------------------------------------------------------------
export const GUARD_KEYS = Object.freeze(['kind', 'packet_version', 'decision', 'reason', 'path', 'road', 'executor']);
export function validateGuardCheck(value) {
  const issues = [];
  if (!head(value, GUARD_PACKET_SCHEMA, 'guard', GUARD_KEYS, issues) || issues.length > 0) return validationResult(issues);
  checkEnum(value.decision, GUARD_DECISIONS, '$.decision', issues);
  checkEnum(value.reason, value.decision === 'deny' ? GUARD_DENY_REASONS : GUARD_ALLOW_REASONS, '$.reason', issues);
  line(value.path, '$.path', issues, true);
  checkId(value.road, '$.road', issues, { nullable: true });
  checkId(value.executor, '$.executor', issues, { nullable: true });
  return validationResult(issues);
}

export const INTENT_VALIDATORS = Object.freeze({
  boot: validateBoot, done: validateDone, done_blocked: validateDoneBlocked, guard: validateGuardCheck, work: validateWork,
  work_blocked: validateWorkBlocked, yield: validateYield, yield_blocked: validateYieldBlocked,
});
