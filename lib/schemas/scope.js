// Scope records (Q14, Q15): per-Road append-only JSONL with `request` and `resolution` records told apart by
// a literal `type`. A request grants nothing; only a resolution changes scope. The CLI fills id, hash, ts,
// type, snapshot and granted_by.
import {
  checkBoolean, checkEnum, checkId, checkLiteral, checkSchemaValue, checkSha, checkText, checkTimestamp, checkUlid,
  deepFreeze, present, resolveForm, validateClosedObject, validateOperationRef, validateReadList, validateWriteList,
} from './artifact-kit.js';
import { READ_ENTRY_SPEC, WRITE_ENTRY_SPEC } from './road.js';
import { issue, validationResult } from './validation.js';

export const SCOPE_REQUEST_SCHEMA = 'akrs.scope-request/v1';
export const SCOPE_RESOLUTION_SCHEMA = 'akrs.scope-resolution/v1';
export const SCOPE_REQUEST_KEYS = Object.freeze([
  'id', 'hash', 'ts', 'type', 'road', 'snapshot', 'add_reads', 'add_writes', 'reason', 'blocking',
]);
export const SCOPE_REQUEST_INPUT_KEYS = Object.freeze(['schema', 'road', 'add_reads', 'add_writes', 'reason', 'blocking']);
export const SCOPE_RESOLUTION_KEYS = Object.freeze([
  'id', 'hash', 'ts', 'type', 'request', 'outcome', 'granted_by', 'reason', 'road_snapshot_after', 'operation',
]);
export const SCOPE_RESOLUTION_INPUT_KEYS = Object.freeze(['schema', 'request', 'outcome', 'reason']);
export const SCOPE_OUTCOMES = Object.freeze(['approved', 'rejected']);
export const SCOPE_GRANTED_BY = Object.freeze(['leader', 'envelope']);

export const SCOPE_REQUEST_SPEC = deepFreeze({
  keys: [...SCOPE_REQUEST_KEYS],
  arrays: {
    add_reads: { kind: 'ordered', item: READ_ENTRY_SPEC },
    add_writes: { kind: 'set', sortKey: 'path', item: WRITE_ENTRY_SPEC },
  },
  objects: {},
});
export const SCOPE_RESOLUTION_SPEC = deepFreeze({
  keys: [...SCOPE_RESOLUTION_KEYS],
  arrays: {},
  objects: { operation: { keys: ['request', 'run'], arrays: {}, objects: {} } },
});

export function validateScopeRequest(value, options = {}) {
  const form = resolveForm(options, ['stored', 'input']);
  const issues = [];
  if (!validateClosedObject(value, form === 'stored' ? SCOPE_REQUEST_KEYS : SCOPE_REQUEST_INPUT_KEYS, '$', issues)) {
    return validationResult(issues);
  }
  if (present(value, 'schema')) checkSchemaValue(value.schema, SCOPE_REQUEST_SCHEMA, '$.schema', issues);
  if (form === 'stored') {
    if (present(value, 'id')) checkUlid(value.id, '$.id', issues);
    if (present(value, 'hash')) checkSha(value.hash, '$.hash', issues);
    if (present(value, 'ts')) checkTimestamp(value.ts, '$.ts', issues);
    if (present(value, 'type')) checkLiteral(value.type, 'request', '$.type', issues);
    if (present(value, 'snapshot')) checkSha(value.snapshot, '$.snapshot', issues);
  }
  if (present(value, 'road')) checkId(value.road, '$.road', issues);
  if (present(value, 'add_reads')) validateReadList(value.add_reads, '$.add_reads', issues);
  if (present(value, 'add_writes')) validateWriteList(value.add_writes, '$.add_writes', issues, { sorted: form === 'stored' });
  if (Array.isArray(value.add_reads) && Array.isArray(value.add_writes) && value.add_reads.length === 0 && value.add_writes.length === 0) {
    issue(issues, '$.add_reads', 'invalid_value', 'a scope request asks for at least one entry in add_reads or add_writes');
  }
  if (present(value, 'reason')) checkText(value.reason, '$.reason', issues);
  if (present(value, 'blocking')) checkBoolean(value.blocking, '$.blocking', issues);
  return validationResult(issues);
}

export function validateScopeResolution(value, options = {}) {
  const form = resolveForm(options, ['stored', 'input']);
  const issues = [];
  if (!validateClosedObject(value, form === 'stored' ? SCOPE_RESOLUTION_KEYS : SCOPE_RESOLUTION_INPUT_KEYS, '$', issues)) {
    return validationResult(issues);
  }
  if (present(value, 'schema')) checkSchemaValue(value.schema, SCOPE_RESOLUTION_SCHEMA, '$.schema', issues);
  const outcomeOk = present(value, 'outcome') && checkEnum(value.outcome, SCOPE_OUTCOMES, '$.outcome', issues);
  const rejected = outcomeOk && value.outcome === 'rejected';
  if (form === 'stored') {
    if (present(value, 'id')) checkUlid(value.id, '$.id', issues);
    if (present(value, 'hash')) checkSha(value.hash, '$.hash', issues);
    if (present(value, 'ts')) checkTimestamp(value.ts, '$.ts', issues);
    if (present(value, 'type')) checkLiteral(value.type, 'resolution', '$.type', issues);
    if (present(value, 'granted_by') && checkEnum(value.granted_by, SCOPE_GRANTED_BY, '$.granted_by', issues)
      && rejected && value.granted_by !== 'leader') {
      issue(issues, '$.granted_by', 'invalid_value', 'only the Leader rejects a request; the envelope can only approve');
    }
    if (present(value, 'road_snapshot_after')) {
      const after = value.road_snapshot_after;
      if (outcomeOk && rejected && after !== null) {
        issue(issues, '$.road_snapshot_after', 'invalid_value', 'a rejected request leaves the Road unchanged');
      } else if (outcomeOk && !rejected && after === null) {
        issue(issues, '$.road_snapshot_after', 'invalid_value', 'an approved request records the Road snapshot after the change');
      } else {
        checkSha(after, '$.road_snapshot_after', issues, { nullable: true });
      }
    }
    if (present(value, 'operation') && value.operation !== null) validateOperationRef(value.operation, '$.operation', issues);
  }
  if (present(value, 'request')) checkUlid(value.request, '$.request', issues);
  if (present(value, 'reason')) {
    if (rejected && value.reason === null) issue(issues, '$.reason', 'invalid_value', 'a rejection states why');
    else checkText(value.reason, '$.reason', issues, { nullable: true });
  }
  return validationResult(issues);
}

// The yield record (A1 2.4, P2-W12): a Worker that cannot finish a Road in its class leaves this in the Road's scope ledger and the Road
// `needs_split` until its contract changes. It is internal to the ledger (not a registered artifact kind): the CLI writes it, nothing
// authors it, and `road_hash` is the Road's content hash at that moment, so a later change of the Road is what clears the flag.
export const SCOPE_YIELD_SCHEMA = 'akrs.scope-yield/v1';
export const SCOPE_YIELD_KEYS = Object.freeze(['id', 'hash', 'ts', 'type', 'road', 'holder', 'reason', 'road_hash']);
export const SCOPE_YIELD_SPEC = deepFreeze({ keys: [...SCOPE_YIELD_KEYS], arrays: {}, objects: {} });

export function validateScopeYield(value) {
  const issues = [];
  if (!validateClosedObject(value, SCOPE_YIELD_KEYS, '$', issues)) return validationResult(issues);
  if (present(value, 'id')) checkUlid(value.id, '$.id', issues);
  if (present(value, 'hash')) checkSha(value.hash, '$.hash', issues);
  if (present(value, 'ts')) checkTimestamp(value.ts, '$.ts', issues);
  if (present(value, 'type')) checkLiteral(value.type, 'yield', '$.type', issues);
  if (present(value, 'road')) checkId(value.road, '$.road', issues);
  if (present(value, 'holder')) checkId(value.holder, '$.holder', issues);
  if (present(value, 'reason')) checkText(value.reason, '$.reason', issues);
  if (present(value, 'road_hash')) checkSha(value.road_hash, '$.road_hash', issues);
  return validationResult(issues);
}
