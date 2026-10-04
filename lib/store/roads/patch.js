// Patch-style Road updates (A1 5.3): a closed operation set that expands to the full update-form Road. The expansion is
// pure; the identical validation, diff and transaction path then judges the result.
import { compareStrings } from '../../schemas/common.js';

export const ROAD_PATCH_SCHEMA = 'akrs.road-patch/v1';
export const PATCH_OPERATIONS = Object.freeze({
  add_read: ['op', 'read'],
  remove_read: ['op', 'path', 'lines', 'reason'],
  add_write: ['op', 'write'],
  remove_write: ['op', 'path', 'reason'],
  add_check: ['op', 'check'],
  remove_check: ['op', 'name', 'reason'],
  replace_acceptance: ['op', 'acceptance'],
  replace_boundaries: ['op', 'boundaries'],
  replace_steps: ['op', 'steps'],
});
const MAX_OPERATIONS = 64;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const issue = (path, code, message) => ({ path, code, message });
const linesKey = (lines) => (lines === null || lines === undefined ? 'null' : `${lines[0]}-${lines[1]}`);

// Closed structure only; the entries themselves (a read, a write, a check) are judged by the Road schema on the
// expanded object.
export function validatePatchDocument(document) {
  const issues = [];
  if (!isObject(document)) return [issue('$', 'invalid_type', 'the patch must be a JSON object')];
  for (const key of Object.keys(document)) if (!['schema', 'ops'].includes(key)) issues.push(issue(`$.${key}`, 'unknown_key', 'unknown key'));
  if (document.schema !== ROAD_PATCH_SCHEMA) issues.push(issue('$.schema', 'invalid_value', `must be ${ROAD_PATCH_SCHEMA}`));
  if (!Array.isArray(document.ops) || document.ops.length === 0 || document.ops.length > MAX_OPERATIONS) {
    issues.push(issue('$.ops', 'invalid_value', `ops must be a list of 1 to ${MAX_OPERATIONS} operations`));
    return issues;
  }
  document.ops.forEach((operation, index) => {
    const at = `$.ops[${index}]`;
    if (!isObject(operation) || !Object.hasOwn(PATCH_OPERATIONS, operation.op)) {
      issues.push(issue(`${at}.op`, 'invalid_value', `op must be one of: ${Object.keys(PATCH_OPERATIONS).join(', ')}`));
      return;
    }
    const keys = PATCH_OPERATIONS[operation.op];
    for (const key of Object.keys(operation)) if (!keys.includes(key)) issues.push(issue(`${at}.${key}`, 'unknown_key', `${operation.op} has no key ${key}`));
    for (const key of keys) if (!Object.hasOwn(operation, key)) issues.push(issue(`${at}.${key}`, 'missing_key', `${operation.op} needs ${key}`));
    if (operation.op.startsWith('remove_') && (typeof operation.reason !== 'string' || operation.reason.trim() === '')) {
      issues.push(issue(`${at}.reason`, 'invalid_value', 'every remove_* operation states a reason'));
    }
  });
  return issues;
}

// current: the update-form Road (stored form without `meta`). Returns { document, problems, removals } where
// `problems` are { reason, pointer, subject, message } (patch_target_missing | patch_target_exists).
export function applyPatch(current, operations) {
  const document = structuredClone(current);
  const problems = [];
  const removals = [];
  operations.forEach((operation, index) => {
    const pointer = `/ops/${index}`;
    const problem = (reason, subject, message) => problems.push({ reason, pointer, subject, message });
    if (operation.op === 'add_read') {
      const key = `${operation.read?.path}|${linesKey(operation.read?.lines)}`;
      if (document.reads.some((entry) => `${entry.path}|${linesKey(entry.lines)}` === key)) {
        problem('patch_target_exists', String(operation.read?.path), 'that read (path and lines) is already declared');
      } else document.reads.push(operation.read);
    } else if (operation.op === 'remove_read') {
      const at = document.reads.findIndex((entry) => entry.path === operation.path && linesKey(entry.lines) === linesKey(operation.lines));
      if (at === -1) problem('patch_target_missing', String(operation.path), 'no declared read has that path and lines');
      else {
        removals.push({ kind: 'read', key: `${operation.path}|${linesKey(operation.lines)}`, reason: operation.reason });
        document.reads.splice(at, 1);
      }
    } else if (operation.op === 'add_write') {
      if (document.writes.some((entry) => entry.path === operation.write?.path)) {
        problem('patch_target_exists', String(operation.write?.path), 'that write path is already declared');
      } else document.writes.push(operation.write);
    } else if (operation.op === 'remove_write') {
      const at = document.writes.findIndex((entry) => entry.path === operation.path);
      if (at === -1) problem('patch_target_missing', String(operation.path), 'no declared write has that path');
      else {
        removals.push({ kind: 'write', key: operation.path, reason: operation.reason });
        document.writes.splice(at, 1);
      }
    } else if (operation.op === 'add_check') {
      if (document.checks.some((entry) => entry.name === operation.check?.name)) {
        problem('patch_target_exists', String(operation.check?.name), 'a check with that name is already declared');
      } else document.checks.push(operation.check);
    } else if (operation.op === 'remove_check') {
      const at = document.checks.findIndex((entry) => entry.name === operation.name);
      if (at === -1) problem('patch_target_missing', String(operation.name), 'no declared check has that name');
      else {
        removals.push({ kind: 'check', key: operation.name, reason: operation.reason });
        document.checks.splice(at, 1);
      }
    } else if (operation.op === 'replace_acceptance') document.acceptance = operation.acceptance;
    else if (operation.op === 'replace_boundaries') document.boundaries = operation.boundaries;
    else if (operation.op === 'replace_steps') document.steps = operation.steps;
  });
  // writes are a set: the canonical stored form is code-point sorted
  if (Array.isArray(document.writes)) document.writes.sort((left, right) => compareStrings(String(left?.path), String(right?.path)));
  return { document, problems, removals };
}

// What a full replacement removes relative to the current Road: reads by (path, lines), writes by path, checks by name.
export function removalsBetween(before, after) {
  const removed = [];
  const keep = (list, keyOf) => new Set((Array.isArray(list) ? list : []).map(keyOf));
  const readKeys = keep(after.reads, (entry) => `${entry?.path}|${linesKey(entry?.lines)}`);
  for (const entry of before.reads) if (!readKeys.has(`${entry.path}|${linesKey(entry.lines)}`)) removed.push({ kind: 'read', key: `${entry.path}|${linesKey(entry.lines)}` });
  const writeKeys = keep(after.writes, (entry) => entry?.path);
  for (const entry of before.writes) if (!writeKeys.has(entry.path)) removed.push({ kind: 'write', key: entry.path });
  const checkKeys = keep(after.checks, (entry) => entry?.name);
  for (const entry of before.checks) if (!checkKeys.has(entry.name)) removed.push({ kind: 'check', key: entry.name });
  return removed;
}
