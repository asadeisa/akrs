// The closed `data` schema of `road-details` (akrs.road-details/v2). The Worker and Leader projections share one core
// packet; the Leader adds readiness and class-fit keys. A refused packet (`road_details_refused`) carries identity and
// the budget numbers only, so no agent ever works from a partial contract.
import {
  checkBoolean, checkEnum, checkId, checkInteger, checkLiteral, checkText, checkTextList, deepFreeze, present, validateClosedObject,
  validateReadList, validateWriteList,
} from './artifact-kit.js';
import { EXECUTOR_CLASSES } from './executors.js';
import { issue, validationResult } from './validation.js';

export const ROAD_DETAILS_SCHEMA = 'akrs.road-details/v2';
export const ROAD_DETAILS_ROLES = Object.freeze(['leader', 'worker']);
export const ROAD_DETAILS_KINDS = Object.freeze(['road_details', 'road_details_refused', 'road_details_blocked']);
export const ROAD_STATUSES = Object.freeze(['QUEUED', 'ACTIVE', 'DONE']);
export const DEPENDENCY_STATUSES = Object.freeze([...ROAD_STATUSES, 'missing', 'unverified']);
export const READ_STATUSES = Object.freeze([
  'ok', 'own_write', 'consumed', 'missing', 'not_file', 'not_text', 'out_of_range', 'case_mismatch', 'unsafe',
]);
// Statuses that resolve a read: it is delivered (or is a Road-owned write target that does not exist yet).
export const RESOLVED_READ_STATUSES = Object.freeze(['ok', 'own_write']);
export const READ_KINDS = Object.freeze(['file', 'window', 'dir', 'glob']);
export const DELIVERY_READS = Object.freeze(['inlined', 'pointers']);
export const DELIVERY_REASONS = Object.freeze(['class_profile', 'explicit_flag', 'read_budget_exceeded', 'leader_view']);
export const LEASE_STATES = Object.freeze(['none', 'fresh', 'stale', 'other', 'unknown']);
export const FIT_VERDICTS = Object.freeze(['fits', 'split_required', 'reads_over_budget']);

export const WORKER_KEYS = Object.freeze([
  'kind', 'packet_version', 'role', 'road', 'task', 'reads', 'writes', 'forbidden', 'deps', 'checks', 'acceptance', 'boundaries', 'steps',
  'reuse', 'conventions', 'collisions', 'recent', 'scope_requests', 'delivery', 'lease', 'budget', 'coverage',
]);
export const LEADER_KEYS = Object.freeze([...WORKER_KEYS, 'readiness', 'class_fit', 'needs_split', 'envelope']);
export const REFUSED_KEYS = Object.freeze(['kind', 'packet_version', 'role', 'road', 'budget', 'refusal']);
// No trustworthy Road could be joined (ambiguous ID, schema-invalid file): identity and the blockers only.
export const BLOCKED_KEYS = Object.freeze(['kind', 'packet_version', 'role', 'road', 'blockers']);
const ROAD_KEYS = Object.freeze(['id', 'plan', 'task', 'status', 'contract', 'executor_class', 'path']);
const TASK_KEYS = Object.freeze(['id', 'path', 'exists']);
const READ_KEYS = Object.freeze(['index', 'path', 'window', 'kind', 'status', 'bytes', 'line_count', 'why', 'declared_by', 'text']);
const WRITE_KEYS = Object.freeze(['path', 'class', 'action', 'exists']);
const DEP_KEYS = Object.freeze(['id', 'status']);
const CHECK_KEYS = Object.freeze(['name', 'argv', 'timeout_ms']);
const REQUEST_KEYS = Object.freeze(['id', 'state', 'blocking', 'ts', 'reason', 'add_reads', 'add_writes', 'resolution']);
const RESOLUTION_KEYS = Object.freeze(['outcome', 'granted_by', 'reason']);
const DELIVERY_KEYS = Object.freeze(['class', 'reads', 'reason', 'read_budget_tokens']);
const LEASE_KEYS = Object.freeze(['holder', 'caller', 'state']);
const BUDGET_KEYS = Object.freeze(['read_files', 'read_bytes', 'estimated_tokens', 'packet_tokens', 'max_tokens']);
const COVERAGE_KEYS = Object.freeze(['declared', 'resolved', 'reads', 'unresolved']);
const UNRESOLVED_KEYS = Object.freeze(['index', 'path', 'window', 'status', 'declared_by']);
const READINESS_KEYS = Object.freeze(['ready', 'blockers']);
const BLOCKER_KEYS = Object.freeze(['reason', 'subject']);
const FIT_KEYS = Object.freeze(['verdict', 'class', 'violations']);
const ENVELOPE_KEYS = Object.freeze(['policy', 'grants', 'grant_cap']);
const POLICY_KEYS = Object.freeze(['auto_reads', 'auto_writes']);
const REFUSAL_KEYS = Object.freeze(['max_tokens', 'packet_tokens']);
const nullableString = (value, path, issues) => {
  if (value !== null) checkText(value, path, issues, { allowEmpty: true });
};
const nullableInteger = (value, path, issues) => checkInteger(value, path, issues, { min: 0, nullable: true });
const list = (value, path, issues, each) => {
  if (!Array.isArray(value)) {
    issue(issues, path, 'invalid_type', 'must be an array');
    return;
  }
  value.forEach((entry, index) => each(entry, `${path}[${index}]`));
};
const known = (value, keys, path, issues) => validateClosedObject(value, keys, path, issues);

function checkRoad(value, path, issues) {
  if (!known(value, ROAD_KEYS, path, issues)) return;
  if (present(value, 'id')) checkId(value.id, `${path}.id`, issues);
  if (present(value, 'plan')) checkId(value.plan, `${path}.plan`, issues, { nullable: true });
  if (present(value, 'task')) checkId(value.task, `${path}.task`, issues, { nullable: true });
  if (present(value, 'status')) checkEnum(value.status, ROAD_STATUSES, `${path}.status`, issues);
  if (present(value, 'contract')) checkEnum(value.contract, ['declared', 'unverified'], `${path}.contract`, issues);
  if (present(value, 'executor_class') && value.executor_class !== null) checkEnum(value.executor_class, EXECUTOR_CLASSES, `${path}.executor_class`, issues);
  if (present(value, 'path')) checkText(value.path, `${path}.path`, issues, { singleLine: true });
}

function checkWindow(value, path, issues) {
  if (value === null) return;
  if (!known(value, ['lines'], path, issues)) return;
  if (!Array.isArray(value.lines) || value.lines.length !== 2) issue(issues, `${path}.lines`, 'invalid_value', 'must be [start, end]');
}

function checkReadEntry(value, path, issues) {
  if (!known(value, READ_KEYS, path, issues)) return;
  if (present(value, 'index')) checkInteger(value.index, `${path}.index`, issues, { min: 0 });
  if (present(value, 'path')) checkText(value.path, `${path}.path`, issues, { singleLine: true });
  if (present(value, 'window')) checkWindow(value.window, `${path}.window`, issues);
  if (present(value, 'kind')) checkEnum(value.kind, READ_KINDS, `${path}.kind`, issues);
  if (present(value, 'status')) checkEnum(value.status, READ_STATUSES, `${path}.status`, issues);
  if (present(value, 'bytes')) nullableInteger(value.bytes, `${path}.bytes`, issues);
  if (present(value, 'line_count')) nullableInteger(value.line_count, `${path}.line_count`, issues);
  if (present(value, 'why')) nullableString(value.why, `${path}.why`, issues);
  if (present(value, 'declared_by')) checkId(value.declared_by, `${path}.declared_by`, issues, { nullable: true });
  if (present(value, 'text')) nullableString(value.text, `${path}.text`, issues);
}

function checkRequest(value, path, issues) {
  if (!known(value, REQUEST_KEYS, path, issues)) return;
  if (present(value, 'id')) checkText(value.id, `${path}.id`, issues, { singleLine: true });
  if (present(value, 'state')) checkEnum(value.state, ['pending', 'approved', 'rejected'], `${path}.state`, issues);
  if (present(value, 'blocking')) checkBoolean(value.blocking, `${path}.blocking`, issues);
  if (present(value, 'ts')) checkText(value.ts, `${path}.ts`, issues, { singleLine: true });
  if (present(value, 'reason')) checkText(value.reason, `${path}.reason`, issues, { allowEmpty: true });
  if (present(value, 'add_reads')) validateReadList(value.add_reads, `${path}.add_reads`, issues);
  if (present(value, 'add_writes')) validateWriteList(value.add_writes, `${path}.add_writes`, issues, { sorted: false });
  if (present(value, 'resolution') && value.resolution !== null) {
    if (known(value.resolution, RESOLUTION_KEYS, `${path}.resolution`, issues)) {
      checkEnum(value.resolution.outcome, ['approved', 'rejected'], `${path}.resolution.outcome`, issues);
      checkEnum(value.resolution.granted_by, ['leader', 'envelope'], `${path}.resolution.granted_by`, issues);
      nullableString(value.resolution.reason, `${path}.resolution.reason`, issues);
    }
  }
}

function checkBudget(value, path, issues) {
  if (!known(value, BUDGET_KEYS, path, issues)) return;
  for (const key of ['read_files', 'read_bytes', 'estimated_tokens', 'packet_tokens']) if (present(value, key)) checkInteger(value[key], `${path}.${key}`, issues, { min: 0 });
  if (present(value, 'max_tokens')) checkInteger(value.max_tokens, `${path}.max_tokens`, issues, { min: 1, nullable: true });
}

function checkSharedBody(value, path, issues) {
  checkRoad(value.road, `${path}.road`, issues);
  if (value.task !== null) {
    if (known(value.task, TASK_KEYS, `${path}.task`, issues)) {
      checkId(value.task.id, `${path}.task.id`, issues);
      checkText(value.task.path, `${path}.task.path`, issues, { singleLine: true });
      checkBoolean(value.task.exists, `${path}.task.exists`, issues);
    }
  }
  list(value.reads, `${path}.reads`, issues, (entry, at) => checkReadEntry(entry, at, issues));
  list(value.writes, `${path}.writes`, issues, (entry, at) => {
    if (!known(entry, WRITE_KEYS, at, issues)) return;
    checkText(entry.path, `${at}.path`, issues, { singleLine: true });
    checkEnum(entry.class, ['file', 'dir', 'glob', 'ephemeral'], `${at}.class`, issues);
    checkEnum(entry.action, ['create', 'modify', 'delete'], `${at}.action`, issues);
    if (entry.exists !== null) checkBoolean(entry.exists, `${at}.exists`, issues);
  });
  checkTextList(value.forbidden, `${path}.forbidden`, issues);
  list(value.deps, `${path}.deps`, issues, (entry, at) => {
    if (!known(entry, DEP_KEYS, at, issues)) return;
    checkId(entry.id, `${at}.id`, issues);
    checkEnum(entry.status, DEPENDENCY_STATUSES, `${at}.status`, issues);
  });
  list(value.checks, `${path}.checks`, issues, (entry, at) => {
    if (!known(entry, CHECK_KEYS, at, issues)) return;
    checkText(entry.name, `${at}.name`, issues, { singleLine: true });
    checkTextList(entry.argv, `${at}.argv`, issues, { nonEmpty: true });
    checkInteger(entry.timeout_ms, `${at}.timeout_ms`, issues, { min: 1 });
  });
  for (const key of ['acceptance', 'boundaries', 'steps']) checkTextList(value[key], `${path}.${key}`, issues);
  for (const key of ['reuse', 'conventions', 'collisions', 'recent']) {
    if (!Array.isArray(value[key])) issue(issues, `${path}.${key}`, 'invalid_type', 'must be an array');
  }
  list(value.scope_requests, `${path}.scope_requests`, issues, (entry, at) => checkRequest(entry, at, issues));
  if (known(value.delivery, DELIVERY_KEYS, `${path}.delivery`, issues)) {
    if (value.delivery.class !== null) checkEnum(value.delivery.class, EXECUTOR_CLASSES, `${path}.delivery.class`, issues);
    checkEnum(value.delivery.reads, DELIVERY_READS, `${path}.delivery.reads`, issues);
    checkEnum(value.delivery.reason, DELIVERY_REASONS, `${path}.delivery.reason`, issues);
    nullableInteger(value.delivery.read_budget_tokens, `${path}.delivery.read_budget_tokens`, issues);
  }
  if (known(value.lease, LEASE_KEYS, `${path}.lease`, issues)) {
    checkId(value.lease.holder, `${path}.lease.holder`, issues, { nullable: true });
    checkId(value.lease.caller, `${path}.lease.caller`, issues, { nullable: true });
    checkEnum(value.lease.state, LEASE_STATES, `${path}.lease.state`, issues);
  }
  checkBudget(value.budget, `${path}.budget`, issues);
  if (known(value.coverage, COVERAGE_KEYS, `${path}.coverage`, issues)) {
    checkInteger(value.coverage.declared, `${path}.coverage.declared`, issues, { min: 0 });
    checkInteger(value.coverage.resolved, `${path}.coverage.resolved`, issues, { min: 0 });
    checkText(value.coverage.reads, `${path}.coverage.reads`, issues, { singleLine: true });
    list(value.coverage.unresolved, `${path}.coverage.unresolved`, issues, (entry, at) => {
      if (!known(entry, UNRESOLVED_KEYS, at, issues)) return;
      checkInteger(entry.index, `${at}.index`, issues, { min: 0 });
      checkText(entry.path, `${at}.path`, issues, { singleLine: true });
      checkWindow(entry.window, `${at}.window`, issues);
      checkEnum(entry.status, READ_STATUSES, `${at}.status`, issues);
      checkId(entry.declared_by, `${at}.declared_by`, issues, { nullable: true });
    });
  }
}

function checkLeaderBody(value, path, issues) {
  if (known(value.readiness, READINESS_KEYS, `${path}.readiness`, issues)) {
    checkBoolean(value.readiness.ready, `${path}.readiness.ready`, issues);
    list(value.readiness.blockers, `${path}.readiness.blockers`, issues, (entry, at) => {
      if (!known(entry, BLOCKER_KEYS, at, issues)) return;
      checkText(entry.reason, `${at}.reason`, issues, { singleLine: true });
      nullableString(entry.subject, `${at}.subject`, issues);
    });
  }
  if (value.class_fit !== null && known(value.class_fit, FIT_KEYS, `${path}.class_fit`, issues)) {
    checkEnum(value.class_fit.verdict, FIT_VERDICTS, `${path}.class_fit.verdict`, issues);
    checkEnum(value.class_fit.class, EXECUTOR_CLASSES, `${path}.class_fit.class`, issues);
    if (!Array.isArray(value.class_fit.violations)) issue(issues, `${path}.class_fit.violations`, 'invalid_type', 'must be an array');
  }
  checkBoolean(value.needs_split, `${path}.needs_split`, issues);
  if (known(value.envelope, ENVELOPE_KEYS, `${path}.envelope`, issues)) {
    if (value.envelope.policy !== null && known(value.envelope.policy, POLICY_KEYS, `${path}.envelope.policy`, issues)) {
      checkTextList(value.envelope.policy.auto_reads, `${path}.envelope.policy.auto_reads`, issues);
      checkTextList(value.envelope.policy.auto_writes, `${path}.envelope.policy.auto_writes`, issues);
    }
    checkInteger(value.envelope.grants, `${path}.envelope.grants`, issues, { min: 0 });
    checkInteger(value.envelope.grant_cap, `${path}.envelope.grant_cap`, issues, { min: 0, nullable: true });
  }
}

// A road-details `data` object: one of the three closed shapes, told apart by `kind` and `role`.
export function validateRoadDetails(value) {
  const issues = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issue(issues, '$', 'invalid_type', 'must be an object');
    return validationResult(issues);
  }
  const refused = value.kind === 'road_details_refused';
  const blocked = value.kind === 'road_details_blocked';
  let keys = value.role === 'leader' ? LEADER_KEYS : WORKER_KEYS;
  if (refused) keys = REFUSED_KEYS;
  else if (blocked) keys = BLOCKED_KEYS;
  // a wrong key set is reported alone: the value checks below assume every key is there
  if (!validateClosedObject(value, keys, '$', issues) || issues.length > 0) return validationResult(issues);
  checkEnum(value.kind, ROAD_DETAILS_KINDS, '$.kind', issues);
  checkLiteral(value.packet_version, ROAD_DETAILS_SCHEMA, '$.packet_version', issues);
  checkEnum(value.role, ROAD_DETAILS_ROLES, '$.role', issues);
  if (blocked) {
    checkId(value.road, '$.road', issues);
    list(value.blockers, '$.blockers', issues, (entry, at) => {
      if (!known(entry, BLOCKER_KEYS, at, issues)) return;
      checkText(entry.reason, `${at}.reason`, issues, { singleLine: true });
      nullableString(entry.subject, `${at}.subject`, issues);
    });
    return validationResult(issues);
  }
  if (refused) {
    checkId(value.road, '$.road', issues);
    checkBudget(value.budget, '$.budget', issues);
    if (known(value.refusal, REFUSAL_KEYS, '$.refusal', issues)) {
      checkInteger(value.refusal.max_tokens, '$.refusal.max_tokens', issues, { min: 1 });
      checkInteger(value.refusal.packet_tokens, '$.refusal.packet_tokens', issues, { min: 0 });
    }
    return validationResult(issues);
  }
  checkSharedBody(value, '$', issues);
  if (value.role === 'leader') checkLeaderBody(value, '$', issues);
  return validationResult(issues);
}

export const ROAD_DETAILS_SHAPES = deepFreeze({ worker: [...WORKER_KEYS], leader: [...LEADER_KEYS], refused: [...REFUSED_KEYS], blocked: [...BLOCKED_KEYS] });
