// The closed `data` schemas of the navigation queries (P2-W09): akrs.status/v1, akrs.next/v1, akrs.where/v1, akrs.graph/v1 (one
// schema, --touches returns a subgraph), akrs.stale/v1 and akrs.log/v1. Nothing in them can express a verdict or a write.
import {
  GRAPH_EDGE_TYPES, GRAPH_NODE_TYPES, GRAPH_SCHEMA, LOG_SCHEMA, MATCHES, NEXT_ACTION_KINDS, NEXT_SCHEMA, STALE_ITEM_KINDS, STALE_SCHEMA, STATUS_SCHEMA,
  WHERE_RELATIONS, WHERE_SCHEMA,
} from '../store/navigation/policy.js';
import { checkBoolean, checkEach, checkEnum, checkId, checkInteger, checkLiteral, checkText, checkTextList, checkTimestamp, checkUlid, validateClosedObject } from './artifact-kit.js';
import { issue, validationResult } from './validation.js';

const ROAD_STATUSES = ['ACTIVE', 'DONE', 'QUEUED'];
const LEASE_STATES = ['fresh', 'stale', 'unreadable'];
const TESTER_STATES = ['failed', 'not_required', 'passed', 'ready_for_test', 'stale', 'testing', 'unverified'];
const CLOSURES = ['closed', 'missing_file', 'open', 'unverified'];
const VERDICTS = ['blocked', 'fail', 'pass'];

const known = (value, keys, path, issues) => validateClosedObject(value, keys, path, issues);
const line = (value, path, issues, nullable = false) => checkText(value, path, issues, { nullable, singleLine: true });
const count = (value, path, issues) => checkInteger(value, path, issues, { min: 0 });
const ids = (value, path, issues) => checkEach(value, path, issues, (entry, at) => checkId(entry, at, issues));
const each = (value, path, issues, keys, body) => checkEach(value, path, issues, (entry, at) => {
  if (known(entry, keys, at, issues)) body(entry, at);
});
const root = (value, schema, kind, keys, issues) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issue(issues, '$', 'invalid_type', 'must be an object');
    return false;
  }
  if (!known(value, keys, '$', issues)) return false;
  checkLiteral(value.kind, kind, '$.kind', issues);
  checkLiteral(value.packet_version, schema, '$.packet_version', issues);
  return true;
};

// ---- status ----------------------------------------------------------------------------------------------------------
export const STATUS_KEYS = Object.freeze(['kind', 'packet_version', 'state', 'roads', 'plans', 'executors', 'leases', 'scope', 'closures']);
export function validateStatus(value) {
  const issues = [];
  if (!root(value, STATUS_SCHEMA, 'status', STATUS_KEYS, issues)) return validationResult(issues);
  if (value.state !== null && known(value.state, ['mode', 'role', 'plan', 'phase', 'task', 'next'], '$.state', issues)) {
    checkInteger(value.state.mode, '$.state.mode', issues, { min: 0 });
    line(value.state.role, '$.state.role', issues);
    checkId(value.state.plan, '$.state.plan', issues, { nullable: true });
    checkText(value.state.phase, '$.state.phase', issues, { nullable: true });
    checkId(value.state.task, '$.state.task', issues, { nullable: true });
    checkText(value.state.next, '$.state.next', issues, { nullable: true });
  }
  if (known(value.roads, ['total', 'by_status', 'unverified', 'ready', 'blocked', 'needs_split', 'class_fit_blockers'], '$.roads', issues)) {
    count(value.roads.total, '$.roads.total', issues);
    count(value.roads.unverified, '$.roads.unverified', issues);
    if (known(value.roads.by_status, ROAD_STATUSES, '$.roads.by_status', issues)) for (const name of ROAD_STATUSES) count(value.roads.by_status[name], `$.roads.by_status.${name}`, issues);
    for (const name of ['ready', 'blocked', 'needs_split']) ids(value.roads[name], `$.roads.${name}`, issues);
    each(value.roads.class_fit_blockers, '$.roads.class_fit_blockers', issues, ['road', 'reason'], (entry, at) => {
      checkId(entry.road, `${at}.road`, issues);
      line(entry.reason, `${at}.reason`, issues);
    });
  }
  each(value.plans, '$.plans', issues, ['id', 'roads', 'tester', 'closure'], (entry, at) => {
    checkId(entry.id, `${at}.id`, issues);
    if (known(entry.roads, ['total', 'done'], `${at}.roads`, issues)) {
      count(entry.roads.total, `${at}.roads.total`, issues);
      count(entry.roads.done, `${at}.roads.done`, issues);
    }
    if (known(entry.tester, ['state', 'required', 'latest'], `${at}.tester`, issues)) {
      checkEnum(entry.tester.state, TESTER_STATES, `${at}.tester.state`, issues);
      checkBoolean(entry.tester.required, `${at}.tester.required`, issues);
      if (entry.tester.latest !== null && known(entry.tester.latest, ['id', 'ts', 'verdict', 'current'], `${at}.tester.latest`, issues)) {
        checkUlid(entry.tester.latest.id, `${at}.tester.latest.id`, issues);
        line(entry.tester.latest.ts, `${at}.tester.latest.ts`, issues);
        checkEnum(entry.tester.latest.verdict, VERDICTS, `${at}.tester.latest.verdict`, issues);
        checkBoolean(entry.tester.latest.current, `${at}.tester.latest.current`, issues);
      }
    }
    checkEnum(entry.closure, CLOSURES, `${at}.closure`, issues);
  });
  each(value.executors, '$.executors', issues, ['id', 'role', 'class'], (entry, at) => {
    checkId(entry.id, `${at}.id`, issues);
    line(entry.role, `${at}.role`, issues);
    line(entry.class, `${at}.class`, issues, true);
  });
  each(value.leases, '$.leases', issues, ['kind', 'target', 'holder', 'state'], (entry, at) => {
    checkEnum(entry.kind, ['plan', 'road'], `${at}.kind`, issues);
    checkId(entry.target, `${at}.target`, issues);
    checkId(entry.holder, `${at}.holder`, issues, { nullable: true });
    checkEnum(entry.state, LEASE_STATES, `${at}.state`, issues);
  });
  if (known(value.scope, ['pending', 'envelope_grants'], '$.scope', issues)) {
    each(value.scope.pending, '$.scope.pending', issues, ['id', 'road', 'blocking'], (entry, at) => {
      checkUlid(entry.id, `${at}.id`, issues);
      checkId(entry.road, `${at}.road`, issues);
      checkBoolean(entry.blocking, `${at}.blocking`, issues);
    });
    count(value.scope.envelope_grants, '$.scope.envelope_grants', issues);
  }
  if (known(value.closures, ['total', 'last'], '$.closures', issues)) {
    count(value.closures.total, '$.closures.total', issues);
    if (value.closures.last !== null && known(value.closures.last, ['id', 'ts', 'kind', 'subject', 'outcome'], '$.closures.last', issues)) {
      checkUlid(value.closures.last.id, '$.closures.last.id', issues);
      checkTimestamp(value.closures.last.ts, '$.closures.last.ts', issues);
      checkEnum(value.closures.last.kind, ['plan', 'road'], '$.closures.last.kind', issues);
      checkId(value.closures.last.subject, '$.closures.last.subject', issues);
      checkEnum(value.closures.last.outcome, ['BLOCKED', 'DONE'], '$.closures.last.outcome', issues);
    }
  }
  return validationResult(issues);
}

// ---- next ------------------------------------------------------------------------------------------------------------
export const NEXT_KEYS = Object.freeze(['kind', 'packet_version', 'executor', 'actions', 'blocked', 'empty']);
export function validateNext(value) {
  const issues = [];
  if (!root(value, NEXT_SCHEMA, 'next', NEXT_KEYS, issues)) return validationResult(issues);
  if (value.executor !== null && known(value.executor, ['id', 'role', 'class'], '$.executor', issues)) {
    checkId(value.executor.id, '$.executor.id', issues);
    line(value.executor.role, '$.executor.role', issues);
    line(value.executor.class, '$.executor.class', issues, true);
  }
  each(value.actions, '$.actions', issues, ['kind', 'subject', 'command', 'args', 'why'], (entry, at) => {
    checkEnum(entry.kind, NEXT_ACTION_KINDS, `${at}.kind`, issues);
    checkId(entry.subject, `${at}.subject`, issues);
    line(entry.command, `${at}.command`, issues);
    checkTextList(entry.args, `${at}.args`, issues, { singleLine: true });
    checkText(entry.why, `${at}.why`, issues);
  });
  each(value.blocked, '$.blocked', issues, ['kind', 'subject', 'reasons'], (entry, at) => {
    checkEnum(entry.kind, ['plan', 'road'], `${at}.kind`, issues);
    checkId(entry.subject, `${at}.subject`, issues);
    each(entry.reasons, `${at}.reasons`, issues, ['reason', 'subject'], (reason, here) => {
      line(reason.reason, `${here}.reason`, issues);
      line(reason.subject, `${here}.subject`, issues, true);
    });
  });
  if (value.empty !== null && known(value.empty, ['reason'], '$.empty', issues)) checkEnum(value.empty.reason, ['blocked', 'nothing_to_do'], '$.empty.reason', issues);
  return validationResult(issues);
}

// ---- where -----------------------------------------------------------------------------------------------------------
export const WHERE_KEYS = Object.freeze(['kind', 'packet_version', 'path', 'provisional', 'relations']);
export function validateWhere(value) {
  const issues = [];
  if (!root(value, WHERE_SCHEMA, 'where', WHERE_KEYS, issues)) return validationResult(issues);
  line(value.path, '$.path', issues);
  checkLiteral(value.provisional, true, '$.provisional', issues);
  if (!known(value.relations, [...WHERE_RELATIONS], '$.relations', issues)) return validationResult(issues);
  each(value.relations.closures, '$.relations.closures', issues, ['id', 'kind', 'subject', 'outcome', 'ts', 'via'], (entry, at) => {
    checkUlid(entry.id, `${at}.id`, issues);
    checkEnum(entry.kind, ['plan', 'road'], `${at}.kind`, issues);
    checkId(entry.subject, `${at}.subject`, issues);
    checkEnum(entry.outcome, ['BLOCKED', 'DONE'], `${at}.outcome`, issues);
    checkTimestamp(entry.ts, `${at}.ts`, issues);
    checkEnum(entry.via, ['plan', 'reader', 'writer'], `${at}.via`, issues);
  });
  each(value.relations.readers, '$.relations.readers', issues, ['road', 'status', 'match', 'pattern', 'windows'], (entry, at) => {
    checkId(entry.road, `${at}.road`, issues);
    checkEnum(entry.status, ROAD_STATUSES, `${at}.status`, issues);
    checkEnum(entry.match, MATCHES, `${at}.match`, issues);
    line(entry.pattern, `${at}.pattern`, issues);
    each(entry.windows, `${at}.windows`, issues, ['lines', 'why'], (window, here) => {
      if (window.lines !== null) checkEach(window.lines, `${here}.lines`, issues, (number, deeper) => checkInteger(number, deeper, issues, { min: 1 }));
      line(window.why, `${here}.why`, issues, true);
    });
  });
  each(value.relations.scope_requests, '$.relations.scope_requests', issues, ['id', 'road', 'state', 'blocking', 'via', 'match'], (entry, at) => {
    checkUlid(entry.id, `${at}.id`, issues);
    checkId(entry.road, `${at}.road`, issues);
    line(entry.state, `${at}.state`, issues);
    checkBoolean(entry.blocking, `${at}.blocking`, issues);
    checkEnum(entry.via, ['add_reads', 'add_writes'], `${at}.via`, issues);
    checkEnum(entry.match, MATCHES, `${at}.match`, issues);
  });
  each(value.relations.writers, '$.relations.writers', issues, ['road', 'status', 'match', 'pattern', 'action'], (entry, at) => {
    checkId(entry.road, `${at}.road`, issues);
    checkEnum(entry.status, ROAD_STATUSES, `${at}.status`, issues);
    checkEnum(entry.match, MATCHES, `${at}.match`, issues);
    line(entry.pattern, `${at}.pattern`, issues);
    line(entry.action, `${at}.action`, issues);
  });
  return validationResult(issues);
}

// ---- graph -----------------------------------------------------------------------------------------------------------
export const GRAPH_KEYS = Object.freeze(['kind', 'packet_version', 'touches', 'nodes', 'edges']);
export function validateGraph(value) {
  const issues = [];
  if (!root(value, GRAPH_SCHEMA, 'graph', GRAPH_KEYS, issues)) return validationResult(issues);
  line(value.touches, '$.touches', issues, true);
  const nodeIds = new Set();
  each(value.nodes, '$.nodes', issues, ['id', 'type', 'status', 'class', 'lease', 'needs_split', 'plan'], (entry, at) => {
    line(entry.id, `${at}.id`, issues);
    if (nodeIds.has(entry.id)) issue(issues, `${at}.id`, 'duplicate', 'a node ID is listed once');
    nodeIds.add(entry.id);
    checkEnum(entry.type, GRAPH_NODE_TYPES, `${at}.type`, issues);
    line(entry.status, `${at}.status`, issues, true);
    line(entry.class, `${at}.class`, issues, true);
    if (entry.lease !== null && known(entry.lease, ['holder', 'state'], `${at}.lease`, issues)) {
      checkId(entry.lease.holder, `${at}.lease.holder`, issues, { nullable: true });
      checkEnum(entry.lease.state, LEASE_STATES, `${at}.lease.state`, issues);
    }
    if (entry.needs_split !== null) checkBoolean(entry.needs_split, `${at}.needs_split`, issues);
    checkId(entry.plan, `${at}.plan`, issues, { nullable: true });
  });
  each(value.edges, '$.edges', issues, ['from', 'to', 'type', 'certainty'], (entry, at) => {
    line(entry.from, `${at}.from`, issues);
    line(entry.to, `${at}.to`, issues);
    if (!nodeIds.has(entry.from)) issue(issues, `${at}.from`, 'dangling', 'an edge starts at a listed node');
    if (!nodeIds.has(entry.to)) issue(issues, `${at}.to`, 'dangling', 'an edge ends at a listed node');
    checkEnum(entry.type, GRAPH_EDGE_TYPES, `${at}.type`, issues);
    if (entry.certainty !== null) checkEnum(entry.certainty, ['overlap', 'unknown'], `${at}.certainty`, issues);
  });
  return validationResult(issues);
}

// ---- stale -----------------------------------------------------------------------------------------------------------
export const STALE_KEYS = Object.freeze(['kind', 'packet_version', 'empty', 'items']);
export function validateStale(value) {
  const issues = [];
  if (!root(value, STALE_SCHEMA, 'stale', STALE_KEYS, issues)) return validationResult(issues);
  checkBoolean(value.empty, '$.empty', issues);
  each(value.items, '$.items', issues, ['kind', 'subject', 'plan', 'holder', 'reasons', 'inputs'], (entry, at) => {
    checkEnum(entry.kind, STALE_ITEM_KINDS, `${at}.kind`, issues);
    line(entry.subject, `${at}.subject`, issues);
    checkId(entry.plan, `${at}.plan`, issues, { nullable: true });
    checkId(entry.holder, `${at}.holder`, issues, { nullable: true });
    checkTextList(entry.reasons, `${at}.reasons`, issues, { nonEmpty: true, singleLine: true });
    if (entry.inputs !== null && known(entry.inputs, ['added', 'changed', 'removed'], `${at}.inputs`, issues)) {
      for (const name of ['added', 'changed', 'removed']) checkTextList(entry.inputs[name], `${at}.inputs.${name}`, issues, { singleLine: true });
    }
  });
  if (Array.isArray(value.items) && typeof value.empty === 'boolean' && value.empty !== (value.items.length === 0)) issue(issues, '$.empty', 'invalid_value', 'empty is true exactly when there are no items');
  return validationResult(issues);
}

// ---- log -------------------------------------------------------------------------------------------------------------
export const LOG_KEYS = Object.freeze(['kind', 'packet_version', 'total', 'shown', 'empty', 'filters', 'entries']);
export function validateLog(value) {
  const issues = [];
  if (!root(value, LOG_SCHEMA, 'log', LOG_KEYS, issues)) return validationResult(issues);
  count(value.total, '$.total', issues);
  count(value.shown, '$.shown', issues);
  checkBoolean(value.empty, '$.empty', issues);
  if (known(value.filters, ['kind', 'subject', 'limit'], '$.filters', issues)) {
    if (value.filters.kind !== null) checkEnum(value.filters.kind, ['plan', 'road'], '$.filters.kind', issues);
    checkId(value.filters.subject, '$.filters.subject', issues, { nullable: true });
    checkInteger(value.filters.limit, '$.filters.limit', issues, { min: 1, nullable: true });
  }
  each(value.entries, '$.entries', issues, ['segment', 'line', 'id', 'ts', 'kind', 'subject', 'outcome', 'deviations', 'operation', 'verified'], (entry, at) => {
    count(entry.segment, `${at}.segment`, issues);
    count(entry.line, `${at}.line`, issues);
    checkUlid(entry.id, `${at}.id`, issues);
    checkTimestamp(entry.ts, `${at}.ts`, issues);
    checkEnum(entry.kind, ['plan', 'road'], `${at}.kind`, issues);
    checkId(entry.subject, `${at}.subject`, issues);
    checkEnum(entry.outcome, ['BLOCKED', 'DONE'], `${at}.outcome`, issues);
    checkText(entry.deviations, `${at}.deviations`, issues, { nullable: true });
    if (entry.operation !== null && known(entry.operation, ['request', 'run'], `${at}.operation`, issues)) {
      checkUlid(entry.operation.request, `${at}.operation.request`, issues);
      checkUlid(entry.operation.run, `${at}.operation.run`, issues);
    }
    checkBoolean(entry.verified, `${at}.verified`, issues);
  });
  if (Array.isArray(value.entries) && typeof value.shown === 'number' && value.shown !== value.entries.length) issue(issues, '$.shown', 'invalid_value', 'shown is the number of entries listed');
  return validationResult(issues);
}
