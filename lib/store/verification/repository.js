// Tester source reader API (the internal projection Phase-2 `test-details` builds on): the contract through the
// canonical codec and the handoff ledger through the JSONL codec. Reads only.
import { readFile, stat } from 'node:fs/promises';
import { HANDOFF_SPEC, validateHandoff } from '../../schemas/handoff-result.js';
import { toJsonPointer } from '../../schemas/primitives.js';
import { VERIFICATION_SPEC, validateVerification } from '../../schemas/verification.js';
import { decodeJsonl, normalizeInput, parseStrictJson, verifyMeta } from '../canonical/index.js';
import { PathSafetyError, createPathService } from '../path-service.js';
import { listRoadFiles, readRoad, workflowOption, RoadStoreError } from '../roads/repository.js';
import { contractPath, handoffPath } from './paths.js';

const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const decode = (bytes) => {
  if (bytes.includes(0)) return null;
  try {
    return DECODER.decode(bytes).replace(/^﻿/, '');
  } catch {
    return null;
  }
};

// { path, workflow_path, exists, bytes|null, problem|null } for one workflow-relative file.
async function locate(service, workflowPath) {
  const base = { path: null, workflow_path: workflowPath, exists: false, text: null, problem: null };
  let resolved;
  try {
    resolved = await service.resolveWorkflowPath(workflowPath);
  } catch (error) {
    if (!(error instanceof PathSafetyError)) throw error;
    return { ...base, problem: 'unsafe' };
  }
  const path = resolved.actual_relative_path;
  if (!resolved.case_matches) return { ...base, path, problem: 'unsafe' };
  if (!resolved.exists) return { ...base, path };
  if (!(await stat(resolved.filesystem_path)).isFile()) return { ...base, path, exists: true, problem: 'not_file' };
  const text = decode(await readFile(resolved.filesystem_path));
  return text === null ? { ...base, path, exists: true, problem: 'not_text' } : { ...base, path, exists: true, text };
}

// { path, exists, contract|null, text, meta_state: 'declared'|'unverified'|null, issues, problem }
export async function readContract({ repositoryRoot, workflowRoot, key }) {
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const file = await locate(service, contractPath(key));
  const result = { path: file.path, workflow_path: file.workflow_path, exists: file.exists, text: file.text, contract: null, meta_state: null, issues: [], problem: file.problem };
  if (file.text === null) return result;
  const normalized = normalizeInput(Buffer.from(file.text));
  const parsed = normalized.ok ? parseStrictJson(normalized.text) : normalized;
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return { ...result, meta_state: 'unverified', problem: 'invalid_json', issues: [{ path: '$', code: 'invalid_json', message: 'the contract is not a JSON object' }] };
  }
  const contract = parsed.value;
  const issues = validateVerification(contract, { form: 'stored', ...workflowOption(service) }).issues.map((entry) => ({ ...entry }));
  if (contract.plan !== key) issues.push({ path: '$.plan', code: 'invalid_value', message: 'must equal the directory name' });
  const declared = issues.length === 0 && verifyMeta(contract, { spec: VERIFICATION_SPEC }) === 'declared';
  return { ...result, contract, meta_state: declared ? 'declared' : 'unverified', issues };
}

// { path, exists, text, records: [{ value, line, state }], issues, problem } of <key>/handoff.jsonl.
export async function readHandoffs({ repositoryRoot, workflowRoot, key }) {
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const file = await locate(service, handoffPath(key));
  const base = { path: file.path, workflow_path: file.workflow_path, exists: file.exists, text: file.text ?? '', records: [], issues: [], problem: file.problem };
  if (file.text === null) return base;
  const decoded = decodeJsonl(file.text, () => HANDOFF_SPEC);
  const issues = decoded.issues.filter(({ code }) => code !== 'unverified_record').map((entry) => ({ ...entry }));
  const records = [];
  for (const { value, line, state } of decoded.records) {
    const verdict = validateHandoff(value, { form: 'stored' });
    if (!verdict.ok) {
      issues.push({ path: '$', line, code: 'invalid_record', message: verdict.issues.map(({ path, message }) => `${toJsonPointer(path) || '/'} ${message}`).join('; ') });
      continue;
    }
    records.push({ value, line, state });
  }
  let problem = issues.length > 0 ? 'invalid_record' : null;
  if (file.text !== '' && !file.text.endsWith('\n')) {
    problem = 'no_final_newline';
    issues.push({ path: '$', code: 'no_final_newline', message: 'the handoff ledger does not end with a newline' });
  }
  return { ...base, records, issues, problem };
}

// The internal projection of one key: { key, contract, handoffs }.
export async function readVerification({ repositoryRoot, workflowRoot, key }) {
  return {
    key,
    contract: await readContract({ repositoryRoot, workflowRoot, key }),
    handoffs: await readHandoffs({ repositoryRoot, workflowRoot, key }),
  };
}

// Every Road with its Plan: [{ id, plan, status, meta_state, path }] (unreadable Roads are left out).
export async function readRoadPlans({ repositoryRoot, workflowRoot }) {
  const roads = [];
  for (const { id } of await listRoadFiles({ repositoryRoot, workflowRoot })) {
    try {
      const found = await readRoad({ repositoryRoot, workflowRoot, id });
      if (found !== null) roads.push({ id, plan: found.road.plan ?? null, status: found.road.status, meta_state: found.meta_state, path: found.path });
    } catch (error) {
      if (!(error instanceof RoadStoreError)) throw error;
    }
  }
  return roads;
}
