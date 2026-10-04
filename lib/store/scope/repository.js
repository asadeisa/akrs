// Scope ledger reader/locator: scope/<road>.jsonl read through the P1-W01 JSONL codec. A request is pending until a
// resolution names it. Reads only; writing is the transaction coordinator's job.
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { compareStrings, isId } from '../../schemas/common.js';
import {
  SCOPE_REQUEST_SPEC, SCOPE_RESOLUTION_SPEC, validateScopeRequest, validateScopeResolution,
} from '../../schemas/scope.js';
import { decodeJsonl } from '../canonical/index.js';
import { PathSafetyError, createPathService } from '../path-service.js';
import { SCOPE_DIRECTORY } from './policy.js';

const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const JSONL = '.jsonl';

export const scopePath = (road) => {
  if (!isId(road)) throw new TypeError('road must be a valid ID');
  return `${SCOPE_DIRECTORY}/${road}${JSONL}`;
};

const specOf = (value) => {
  if (value?.type === 'request') return SCOPE_REQUEST_SPEC;
  if (value?.type === 'resolution') return SCOPE_RESOLUTION_SPEC;
  return null;
};

// text -> { issues, records: [{ value, line, state }] }; records that break their closed schema become issues.
export function parseScopeText(text) {
  const decoded = decodeJsonl(text, specOf);
  const issues = decoded.issues.filter(({ code }) => code !== 'unverified_record').map((entry) => ({ ...entry }));
  const records = [];
  for (const { value, line, state } of decoded.records) {
    const verdict = value.type === 'request' ? validateScopeRequest(value, { form: 'stored' }) : validateScopeResolution(value, { form: 'stored' });
    if (!verdict.ok) {
      issues.push({ path: '$', line, code: 'invalid_record', message: verdict.issues.map(({ path, message }) => `${path} ${message}`).join('; ') });
      continue;
    }
    records.push({ value, line, state });
  }
  return { issues, records };
}

// Requests with their derived state, from the parsed records of ONE Road's ledger.
export function deriveRequests(records) {
  const resolutions = new Map();
  for (const { value } of records) if (value.type === 'resolution' && !resolutions.has(value.request)) resolutions.set(value.request, value);
  return records.filter(({ value }) => value.type === 'request').map(({ value, line, state }) => {
    const resolution = resolutions.get(value.id) ?? null;
    return {
      ...value, line, meta_state: state, state: resolution === null ? 'pending' : resolution.outcome, resolution,
    };
  });
}

// { path, workflow_path, exists, text, records, requests, issues, problem } for one Road. `problem` is null when the
// ledger can take a new record (absent, or readable with a final newline).
export async function readScope({ repositoryRoot, workflowRoot, road }) {
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const workflowPath = scopePath(road);
  const base = {
    path: null, workflow_path: workflowPath, exists: false, text: '', records: [], requests: [], issues: [], problem: null,
  };
  let resolved;
  try {
    resolved = await service.resolveWorkflowPath(workflowPath);
  } catch (error) {
    if (!(error instanceof PathSafetyError)) throw error;
    return { ...base, problem: 'unsafe', issues: [{ path: '$', code: 'unsafe', message: error.message }] };
  }
  const path = resolved.actual_relative_path;
  if (!resolved.case_matches) return { ...base, path, problem: 'unsafe', issues: [{ path: '$', code: 'unsafe', message: `${path} differs in case` }] };
  if (!resolved.exists) return { ...base, path };
  if (!(await stat(resolved.filesystem_path)).isFile()) {
    return { ...base, path, exists: true, problem: 'not_file', issues: [{ path: '$', code: 'not_file', message: `${path} is not a regular file` }] };
  }
  const bytes = await readFile(resolved.filesystem_path);
  let text = null;
  if (!bytes.includes(0)) {
    try {
      text = DECODER.decode(bytes).replace(/^﻿/, '');
    } catch {
      text = null;
    }
  }
  if (text === null) {
    return { ...base, path, exists: true, problem: 'not_text', issues: [{ path: '$', code: 'not_text', message: `${path} is not UTF-8 text` }] };
  }
  const parsed = parseScopeText(text);
  let problem = parsed.issues.length > 0 ? 'invalid_record' : null;
  const issues = [...parsed.issues];
  if (text !== '' && !text.endsWith('\n')) {
    problem = 'no_final_newline';
    issues.push({ path: '$', code: 'no_final_newline', message: `${path} does not end with a newline` });
  }
  return {
    ...base, path, exists: true, text, records: parsed.records, requests: deriveRequests(parsed.records), issues, problem,
  };
}

// Every Road that has a scope ledger: [{ road, path, workflow_path }] sorted by Road.
export async function listScopeFiles({ repositoryRoot, workflowRoot }) {
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const prefix = service.workflow_relative_path === '' ? '' : `${service.workflow_relative_path}/`;
  const directory = `${prefix}${SCOPE_DIRECTORY}/`;
  return (await service.walkWorkflowFiles(SCOPE_DIRECTORY))
    .filter((path) => path.startsWith(directory) && path.endsWith(JSONL) && !path.slice(directory.length).includes('/'))
    .map((path) => ({ road: basename(path).slice(0, -JSONL.length), path, workflow_path: path.slice(prefix.length) }))
    .filter(({ road }) => isId(road))
    .sort((left, right) => compareStrings(left.road, right.road));
}

// Every request of every Road (or one Road), with its state: sorted by Road, then ledger order.
export async function readAllRequests({ repositoryRoot, workflowRoot, road = null }) {
  const files = road === null ? await listScopeFiles({ repositoryRoot, workflowRoot }) : [{ road }];
  const requests = [];
  const issues = [];
  for (const { road: id } of files) {
    const scope = await readScope({ repositoryRoot, workflowRoot, road: id });
    for (const request of scope.requests) requests.push({ ...request, path: scope.path });
    for (const issue of scope.issues) issues.push({ file: scope.path, ...issue });
  }
  return { requests, issues };
}
