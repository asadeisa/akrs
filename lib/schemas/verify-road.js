// The closed `data` schema of `verify --road` (P2-W03). Two shapes, told apart by `kind`: the run (or dry run) with one
// captured record per selected check, and `verify_road_blocked` when nothing could start. Nothing in it can express a
// Tester verdict or acceptance: the result is mechanical.
import { checkBoolean, checkEnum, checkId, checkInteger, checkLiteral, checkText, checkTextList, deepFreeze, validateClosedObject } from './artifact-kit.js';
import { issue, validationResult } from './validation.js';

export const VERIFY_ROAD_KINDS = Object.freeze(['verify_road', 'verify_road_blocked']);
export const VERIFY_CHECK_STATUSES = Object.freeze(['not_run', 'passed', 'failed', 'timed_out', 'spawn_failed', 'interrupted']);
export const VERIFY_OUTCOMES = Object.freeze(['passed', 'failed', 'dry_run', 'interrupted']);
export const VERIFY_TERMINATIONS = Object.freeze(['none', 'graceful', 'forced', 'unconfirmed']);
export const VERIFY_BLOCK_REASON_VALUES = Object.freeze(['road_ambiguous', 'road_unverified', 'no_checks', 'check_unknown', 'snapshot_unstable', 'stale_snapshot']);
export const VERIFY_ROAD_KEYS = Object.freeze(['kind', 'mode', 'road', 'dry_run', 'outcome', 'note', 'risk', 'limits', 'env', 'summary', 'checks']);
export const VERIFY_BLOCKED_KEYS = Object.freeze(['kind', 'mode', 'road', 'reason', 'subject', 'note', 'risk']);
const ROAD_KEYS = Object.freeze(['id', 'status', 'contract']);
const LIMIT_KEYS = Object.freeze(['stream_cap_bytes', 'head_bytes', 'tail_bytes', 'grace_ms', 'wait_after_kill_ms']);
const ENV_KEYS = Object.freeze(['inherited', 'set']);
const SUMMARY_KEYS = Object.freeze(['declared', 'selected', 'passed', 'failed', 'timed_out', 'spawn_failed', 'interrupted', 'not_run']);
const CHECK_KEYS = Object.freeze(['name', 'argv', 'cwd', 'timeout_ms', 'status', 'exit_code', 'signal', 'duration_ms', 'termination', 'error', 'stdout', 'stderr']);
const ERROR_KEYS = Object.freeze(['code', 'message']);
const STREAM_KEYS = Object.freeze(['text', 'tail', 'total_bytes', 'truncated']);

const known = (value, keys, path, issues) => validateClosedObject(value, keys, path, issues);
const nullable = (value, path, issues, check) => {
  if (value !== null) check(value, path, issues);
};
const nullableInteger = (value, path, issues, min = 0) => nullable(value, path, issues, () => checkInteger(value, path, issues, { min }));

function checkStream(value, path, issues) {
  if (value === null) return;
  if (!known(value, STREAM_KEYS, path, issues)) return;
  checkText(value.text, `${path}.text`, issues, { allowEmpty: true });
  nullable(value.tail, `${path}.tail`, issues, () => checkText(value.tail, `${path}.tail`, issues, { allowEmpty: true }));
  checkInteger(value.total_bytes, `${path}.total_bytes`, issues, { min: 0 });
  checkBoolean(value.truncated, `${path}.truncated`, issues);
  if ((value.tail !== null) !== (value.truncated === true)) issue(issues, path, 'invalid_value', 'a tail exists exactly when the stream was truncated');
}

function checkCheck(value, path, issues) {
  if (!known(value, CHECK_KEYS, path, issues)) return;
  checkText(value.name, `${path}.name`, issues, { singleLine: true });
  checkTextList(value.argv, `${path}.argv`, issues, { nonEmpty: true });
  checkLiteral(value.cwd, '.', `${path}.cwd`, issues);
  checkInteger(value.timeout_ms, `${path}.timeout_ms`, issues, { min: 1 });
  checkEnum(value.status, VERIFY_CHECK_STATUSES, `${path}.status`, issues);
  nullableInteger(value.exit_code, `${path}.exit_code`, issues);
  nullable(value.signal, `${path}.signal`, issues, () => checkText(value.signal, `${path}.signal`, issues, { singleLine: true }));
  nullableInteger(value.duration_ms, `${path}.duration_ms`, issues);
  nullable(value.termination, `${path}.termination`, issues, () => checkEnum(value.termination, VERIFY_TERMINATIONS, `${path}.termination`, issues));
  if (value.error !== null && known(value.error, ERROR_KEYS, `${path}.error`, issues)) {
    checkText(value.error.code, `${path}.error.code`, issues, { singleLine: true });
    checkText(value.error.message, `${path}.error.message`, issues, { singleLine: true });
  }
  checkStream(value.stdout, `${path}.stdout`, issues);
  checkStream(value.stderr, `${path}.stderr`, issues);
  if (value.status === 'passed' && (value.exit_code !== 0 || value.signal !== null || value.termination !== 'none' || value.error !== null)) {
    issue(issues, path, 'invalid_value', 'a passed check exited by itself with code 0');
  }
  if (value.status === 'not_run' && (value.exit_code !== null || value.duration_ms !== null || value.stdout !== null)) issue(issues, path, 'invalid_value', 'a check that did not run has no result');
  if (value.status === 'spawn_failed' && value.error === null) issue(issues, path, 'invalid_value', 'a spawn failure names its error');
}

export function validateVerifyRoad(value) {
  const issues = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issue(issues, '$', 'invalid_type', 'must be an object');
    return validationResult(issues);
  }
  const blocked = value.kind === 'verify_road_blocked';
  if (!validateClosedObject(value, blocked ? VERIFY_BLOCKED_KEYS : VERIFY_ROAD_KEYS, '$', issues) || issues.length > 0) return validationResult(issues);
  checkEnum(value.kind, VERIFY_ROAD_KINDS, '$.kind', issues);
  checkLiteral(value.mode, 'mechanical', '$.mode', issues);
  checkText(value.note, '$.note', issues, { singleLine: true });
  checkText(value.risk, '$.risk', issues, { singleLine: true });
  if (blocked) {
    checkId(value.road, '$.road', issues);
    checkEnum(value.reason, VERIFY_BLOCK_REASON_VALUES, '$.reason', issues);
    nullable(value.subject, '$.subject', issues, () => checkText(value.subject, '$.subject', issues, { singleLine: true }));
    return validationResult(issues);
  }
  if (known(value.road, ROAD_KEYS, '$.road', issues)) {
    checkId(value.road.id, '$.road.id', issues);
    checkText(value.road.status, '$.road.status', issues, { singleLine: true });
    checkEnum(value.road.contract, ['declared'], '$.road.contract', issues);
  }
  checkBoolean(value.dry_run, '$.dry_run', issues);
  checkEnum(value.outcome, VERIFY_OUTCOMES, '$.outcome', issues);
  if (known(value.limits, LIMIT_KEYS, '$.limits', issues)) for (const key of LIMIT_KEYS) checkInteger(value.limits[key], `$.limits.${key}`, issues, { min: 1 });
  if (known(value.env, ENV_KEYS, '$.env', issues)) {
    checkTextList(value.env.inherited, '$.env.inherited', issues);
    if (value.env.set === null || typeof value.env.set !== 'object' || Array.isArray(value.env.set)) issue(issues, '$.env.set', 'invalid_type', 'must be an object');
  }
  if (known(value.summary, SUMMARY_KEYS, '$.summary', issues)) for (const key of SUMMARY_KEYS) checkInteger(value.summary[key], `$.summary.${key}`, issues, { min: 0 });
  if (!Array.isArray(value.checks)) issue(issues, '$.checks', 'invalid_type', 'must be an array');
  else value.checks.forEach((entry, index) => checkCheck(entry, `$.checks[${index}]`, issues));
  return validationResult(issues);
}

export const VERIFY_ROAD_SHAPES = deepFreeze({ run: [...VERIFY_ROAD_KEYS], blocked: [...VERIFY_BLOCKED_KEYS] });
