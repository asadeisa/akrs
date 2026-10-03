// Closure record (Q19): one JSONL line per Road/Plan closure; full injected `ts`, no telemetry, optional
// operation reference (Q23). `id` is a ULID and `hash` is computed by the JSONL codec.
import {
  checkEnum, checkId, checkSha, checkText, checkTimestamp, checkUlid, deepFreeze, present, validateClosedObject,
  validateOperationRef,
} from './artifact-kit.js';
import { validationResult } from './validation.js';

export const CLOSURE_SCHEMA = 'akrs.closure/v1';
export const CLOSURE_KEYS = Object.freeze(['id', 'hash', 'ts', 'kind', 'subject', 'outcome', 'deviations', 'operation']);
export const CLOSURE_KINDS = Object.freeze(['road', 'plan']);
export const CLOSURE_OUTCOMES = Object.freeze(['DONE', 'BLOCKED']);

export const CLOSURE_SPEC = deepFreeze({
  keys: [...CLOSURE_KEYS],
  arrays: {},
  objects: { operation: { keys: ['request', 'run'], arrays: {}, objects: {} } },
});

export function validateClosure(value) {
  const issues = [];
  if (!validateClosedObject(value, CLOSURE_KEYS, '$', issues)) return validationResult(issues);
  if (present(value, 'id')) checkUlid(value.id, '$.id', issues);
  if (present(value, 'hash')) checkSha(value.hash, '$.hash', issues);
  if (present(value, 'ts')) checkTimestamp(value.ts, '$.ts', issues);
  if (present(value, 'kind')) checkEnum(value.kind, CLOSURE_KINDS, '$.kind', issues);
  if (present(value, 'subject')) checkId(value.subject, '$.subject', issues);
  if (present(value, 'outcome')) checkEnum(value.outcome, CLOSURE_OUTCOMES, '$.outcome', issues);
  if (present(value, 'deviations')) checkText(value.deviations, '$.deviations', issues, { nullable: true });
  if (present(value, 'operation') && value.operation !== null) validateOperationRef(value.operation, '$.operation', issues);
  return validationResult(issues);
}
