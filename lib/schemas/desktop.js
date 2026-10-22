// The closed `data` schemas of the desktop-readiness commands (P2-W17): projects add|remove|list, status --all-projects (akrs.status-all/v1),
// view and watch (its final packet and its event data). Nothing in them can express a verdict or a write outside the registry and the view cache.
import {
  PROJECT_KEYS, PROJECT_REASONS, PROJECT_STATES,
} from '../userconfig/policy.js';
import { WATCH_EVENT_KINDS, WATCH_ENDINGS, WATCH_SCHEMA } from '../watch/policy.js';
import { VIEW_SCHEMA } from '../view/policy.js';
import { validateStatus } from './navigation.js';
import {
  checkBoolean, checkEach, checkEnum, checkId, checkInteger, checkLiteral, checkSha, checkText, checkTimestamp, checkUlid, validateClosedObject,
} from './artifact-kit.js';
import { issue, validationResult } from './validation.js';

export const STATUS_ALL_SCHEMA = 'akrs.status-all/v1';
const REGISTRY_STATES = ['absent', 'invalid', 'valid'];
const ADD_OUTCOMES = ['added', 'blocked', 'full', 'invalid', 'noop', 'rejected', 'updated'];
const REMOVE_OUTCOMES = ['blocked', 'invalid', 'removed'];

const known = (value, keys, path, issues) => validateClosedObject(value, keys, path, issues);
const line = (value, path, issues, nullable = false) => checkText(value, path, issues, { nullable, singleLine: true });
const count = (value, path, issues) => checkInteger(value, path, issues, { min: 0 });
const kindOf = (value, kind, keys, issues) => {
  if (!known(value, keys, '$', issues)) return false;
  checkLiteral(value.kind, kind, '$.kind', issues);
  return true;
};

function checkProject(value, path, issues) {
  if (!known(value, PROJECT_KEYS, path, issues)) return;
  line(value.root, `${path}.root`, issues);
  line(value.workflow, `${path}.workflow`, issues);
  line(value.name, `${path}.name`, issues);
  checkTimestamp(value.added_at, `${path}.added_at`, issues);
}

export const PROJECTS_ADD_KEYS = Object.freeze(['kind', 'dry_run', 'outcome', 'config_root', 'project', 'requested', 'reason', 'count']);
export function validateProjectsAdd(value) {
  const issues = [];
  if (!kindOf(value, 'projects_add', PROJECTS_ADD_KEYS, issues)) return validationResult(issues);
  checkBoolean(value.dry_run, '$.dry_run', issues);
  checkEnum(value.outcome, ADD_OUTCOMES, '$.outcome', issues);
  line(value.config_root, '$.config_root', issues);
  if (value.project !== null) checkProject(value.project, '$.project', issues);
  line(value.requested, '$.requested', issues, true);
  if (value.reason !== null) checkEnum(value.reason, PROJECT_REASONS, '$.reason', issues);
  count(value.count, '$.count', issues);
  return validationResult(issues);
}

export const PROJECTS_REMOVE_KEYS = Object.freeze(['kind', 'dry_run', 'outcome', 'config_root', 'project', 'query', 'count']);
export function validateProjectsRemove(value) {
  const issues = [];
  if (!kindOf(value, 'projects_remove', PROJECTS_REMOVE_KEYS, issues)) return validationResult(issues);
  checkBoolean(value.dry_run, '$.dry_run', issues);
  checkEnum(value.outcome, REMOVE_OUTCOMES, '$.outcome', issues);
  line(value.config_root, '$.config_root', issues);
  if (value.project !== null) checkProject(value.project, '$.project', issues);
  line(value.query, '$.query', issues);
  count(value.count, '$.count', issues);
  return validationResult(issues);
}

export const PROJECTS_LIST_KEYS = Object.freeze(['kind', 'config_root', 'registry', 'projects']);
export function validateProjectsList(value) {
  const issues = [];
  if (!kindOf(value, 'projects_list', PROJECTS_LIST_KEYS, issues)) return validationResult(issues);
  line(value.config_root, '$.config_root', issues);
  checkEnum(value.registry, REGISTRY_STATES, '$.registry', issues);
  checkEach(value.projects, '$.projects', issues, (entry, at) => checkProject(entry, at, issues));
  return validationResult(issues);
}

export const STATUS_ALL_KEYS = Object.freeze(['kind', 'packet_version', 'config_root', 'registry', 'projects']);
export function validateStatusAllProjects(value) {
  const issues = [];
  if (!kindOf(value, 'status_all_projects', STATUS_ALL_KEYS, issues)) return validationResult(issues);
  checkLiteral(value.packet_version, STATUS_ALL_SCHEMA, '$.packet_version', issues);
  line(value.config_root, '$.config_root', issues);
  checkEnum(value.registry, REGISTRY_STATES, '$.registry', issues);
  checkEach(value.projects, '$.projects', issues, (entry, at) => {
    if (!known(entry, [...PROJECT_KEYS, 'state', 'message', 'status'], at, issues)) return;
    line(entry.root, `${at}.root`, issues);
    line(entry.workflow, `${at}.workflow`, issues);
    line(entry.name, `${at}.name`, issues);
    checkTimestamp(entry.added_at, `${at}.added_at`, issues);
    checkEnum(entry.state, PROJECT_STATES, `${at}.state`, issues);
    line(entry.message, `${at}.message`, issues, true);
    if (entry.status === null) {
      if (entry.state === 'ok') issue(issues, `${at}.status`, 'invalid_value', 'a readable project carries its status');
    } else {
      if (entry.state !== 'ok') issue(issues, `${at}.status`, 'invalid_value', 'only a readable project carries a status');
      issues.push(...validateStatus(entry.status).issues.map((problem) => ({ ...problem, path: `${at}.status${problem.path.slice(1)}` })));
    }
  });
  return validationResult(issues);
}

export const VIEW_KEYS = Object.freeze(['kind', 'packet_version', 'outcome', 'path', 'bytes', 'sha256', 'nodes', 'edges']);
export function validateViewData(value) {
  const issues = [];
  if (!kindOf(value, 'view', VIEW_KEYS, issues)) return validationResult(issues);
  checkLiteral(value.packet_version, VIEW_SCHEMA, '$.packet_version', issues);
  checkEnum(value.outcome, ['unchanged', 'written'], '$.outcome', issues);
  line(value.path, '$.path', issues);
  count(value.bytes, '$.bytes', issues);
  checkSha(value.sha256, '$.sha256', issues);
  count(value.nodes, '$.nodes', issues);
  count(value.edges, '$.edges', issues);
  return validationResult(issues);
}

export const WATCH_KEYS = Object.freeze(['kind', 'packet_version', 'ended', 'since', 'cursor', 'ops', 'changes', 'snapshot']);
export function validateWatchData(value) {
  const issues = [];
  if (!kindOf(value, 'watch', WATCH_KEYS, issues)) return validationResult(issues);
  checkLiteral(value.packet_version, WATCH_SCHEMA, '$.packet_version', issues);
  checkEnum(value.ended, WATCH_ENDINGS, '$.ended', issues);
  checkUlid(value.since, '$.since', issues, { nullable: true });
  checkUlid(value.cursor, '$.cursor', issues, { nullable: true });
  count(value.ops, '$.ops', issues);
  count(value.changes, '$.changes', issues);
  checkSha(value.snapshot, '$.snapshot', issues);
  return validationResult(issues);
}

// ---- watch events (akrs.event/v1 data of started and progress) --------------------------------------------
const STARTED_KEYS = Object.freeze(['kind', 'since', 'cursor', 'snapshot', 'debounce_ms', 'poll_ms']);
const OP_KEYS = Object.freeze(['kind', 'op', 'command', 'road', 'plan', 'ts', 'changed', 'before', 'after']);
const CHANGE_KEYS = Object.freeze(['kind', 'before', 'after', 'paths']);

function checkStarted(data, issues) {
  if (!known(data, STARTED_KEYS, '$.data', issues)) return;
  checkLiteral(data.kind, WATCH_EVENT_KINDS.started, '$.data.kind', issues);
  checkUlid(data.since, '$.data.since', issues, { nullable: true });
  checkUlid(data.cursor, '$.data.cursor', issues, { nullable: true });
  checkSha(data.snapshot, '$.data.snapshot', issues);
  checkInteger(data.debounce_ms, '$.data.debounce_ms', issues, { min: 1 });
  checkInteger(data.poll_ms, '$.data.poll_ms', issues, { min: 1 });
}

function checkOp(data, issues) {
  if (!known(data, OP_KEYS, '$.data', issues)) return;
  checkLiteral(data.kind, WATCH_EVENT_KINDS.op, '$.data.kind', issues);
  checkUlid(data.op, '$.data.op', issues);
  line(data.command, '$.data.command', issues);
  checkId(data.road, '$.data.road', issues, { nullable: true });
  checkId(data.plan, '$.data.plan', issues, { nullable: true });
  checkTimestamp(data.ts, '$.data.ts', issues);
  checkEach(data.changed, '$.data.changed', issues, (entry, at) => line(entry, at, issues));
  checkSha(data.before, '$.data.before', issues, { nullable: true });
  checkSha(data.after, '$.data.after', issues, { nullable: true });
}

function checkChange(data, issues) {
  if (!known(data, CHANGE_KEYS, '$.data', issues)) return;
  checkLiteral(data.kind, WATCH_EVENT_KINDS.change, '$.data.kind', issues);
  checkSha(data.before, '$.data.before', issues);
  checkSha(data.after, '$.data.after', issues);
  checkEach(data.paths, '$.data.paths', issues, (entry, at) => line(entry, at, issues));
}

// The closed data of one non-complete watch event (the stream has already validated the envelope).
export function validateWatchEventData(event) {
  const issues = [];
  if (event.type === 'started') checkStarted(event.data, issues);
  else if (event.type === 'progress') {
    if (event.data?.kind === WATCH_EVENT_KINDS.change) checkChange(event.data, issues);
    else checkOp(event.data, issues);
  } else issue(issues, '$.type', 'invalid_value', 'only started and progress carry watch data');
  return validationResult(issues);
}
