// Closure ledger reader API: every segment of akrs/log/ parsed with the same codec the writer uses. A record is
// `declared` (its hash matches) or `unverified`; a line that is not a valid closure is reported as an issue and never
// becomes a record. The reader never writes.
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { CLOSURE_SPEC, validateClosure } from '../../schemas/closure.js';
import { toJsonPointer } from '../../schemas/primitives.js';
import { decodeJsonl } from '../canonical/index.js';
import { PathSafetyError, createPathService } from '../path-service.js';
import { segmentNumber } from './paths.js';
import { LOG_DIRECTORY } from './policy.js';

const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function decodeLogBytes(bytes) {
  if (bytes.includes(0)) return null;
  try {
    return DECODER.decode(bytes).replace(/^﻿/, '');
  } catch {
    return null;
  }
}

// text -> { ok, issues, records } ; record = { value, line, state, hash }. Records that break the closed schema are
// dropped and reported as `invalid_record` issues.
export function parseLogText(text) {
  const decoded = decodeJsonl(text, () => CLOSURE_SPEC);
  const issues = decoded.issues.filter(({ code }) => code !== 'unverified_record').map((entry) => ({ ...entry }));
  const records = [];
  for (const { value, line, state } of decoded.records) {
    const verdict = validateClosure(value);
    if (!verdict.ok) {
      for (const { path, message } of verdict.issues) {
        issues.push({ path: '$', line, code: 'invalid_record', message: `${message} (at ${toJsonPointer(path) || '/'})` });
      }
      continue;
    }
    records.push({ value, line, state, hash: value.hash });
  }
  return { ok: issues.length === 0, issues, records };
}

// Every NNNN.jsonl directly inside log/, numerically ordered: [{ number, name, path, workflow_path }].
export async function listLogSegments({ repositoryRoot, workflowRoot }) {
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const prefix = service.workflow_relative_path === '' ? '' : `${service.workflow_relative_path}/`;
  const directory = `${prefix}${LOG_DIRECTORY}/`;
  return (await service.walkWorkflowFiles(LOG_DIRECTORY))
    .filter((path) => path.startsWith(directory) && !path.slice(directory.length).includes('/'))
    .map((path) => ({ number: segmentNumber(basename(path)), name: basename(path), path, workflow_path: path.slice(prefix.length) }))
    .filter(({ number }) => number !== null)
    .sort((left, right) => left.number - right.number);
}

async function readSegment(service, entry) {
  const base = { ...entry, text: '', records: [] };
  const problem = (reason, message) => ({
    ...base, ok: false, problem: reason, issues: [{ path: '$', code: reason, message }],
  });
  let resolved;
  try {
    resolved = await service.resolveRepositoryPath(entry.path);
  } catch (error) {
    if (!(error instanceof PathSafetyError)) throw error;
    return problem('unsafe', error.message);
  }
  if (!resolved.case_matches) return problem('unsafe', `${entry.path} differs in case from the file system entry`);
  if (!(await stat(resolved.filesystem_path)).isFile()) return problem('not_file', `${entry.path} is not a regular file`);
  const text = decodeLogBytes(await readFile(resolved.filesystem_path));
  if (text === null) return problem('not_text', `${entry.path} is not UTF-8 text`);
  const parsed = parseLogText(text);
  const endsCleanly = text === '' || text.endsWith('\n');
  const issues = endsCleanly
    ? parsed.issues
    : [...parsed.issues, { path: '$', code: 'no_final_newline', message: `${entry.path} does not end with a newline` }];
  const unreadable = parsed.issues.length > 0 ? 'invalid_record' : null;
  return {
    ...base,
    text,
    records: parsed.records,
    ok: issues.length === 0 && parsed.records.every(({ state }) => state === 'declared'),
    problem: endsCleanly ? unreadable : 'no_final_newline',
    issues,
  };
}

// Everything: { workflow_prefix, segments, records, issues, unverified }.
//   segments  [{ number, name, path, workflow_path, text, records, ok, problem, issues }] numerically ordered
//   records   chronological ledger order: { segment, path, line, id, ts, kind, subject, outcome, deviations, operation, hash,
//             meta_state }
//   issues    segment-level issues with their file; `unverified` the records whose hash does not match.
export async function readLog({ repositoryRoot, workflowRoot }) {
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const segments = [];
  for (const entry of await listLogSegments({ repositoryRoot, workflowRoot })) segments.push(await readSegment(service, entry));
  const records = segments.flatMap((segment) => segment.records.map(({ value, line, state }) => ({
    segment: segment.number,
    path: segment.path,
    line,
    id: value.id,
    ts: value.ts,
    kind: value.kind,
    subject: value.subject,
    outcome: value.outcome,
    deviations: value.deviations,
    operation: value.operation,
    hash: value.hash,
    meta_state: state,
  })));
  return {
    workflow_prefix: service.workflow_relative_path === '' ? '' : `${service.workflow_relative_path}/`,
    segments,
    records,
    unverified: records.filter(({ meta_state: state }) => state !== 'declared'),
    issues: segments.flatMap((segment) => segment.issues.map((entry) => ({ file: segment.path, ...entry }))),
  };
}
