// The run record and its evidence files (P2-W14): layout, the temp-file-and-rename write with the record LAST, the measured
// evidence refs, and the reader. A directory without run.json is an interrupted write and never a run.
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { compareStrings } from '../../schemas/common.js';
import { RUN_SCHEMA, RUN_SPEC, validateRun } from '../../schemas/verification.js';
import { canonicalizeJson, normalizeInput, parseStrictJson, storedSpec, verifyMeta, withMeta } from '../canonical/index.js';
import { GENERATOR } from '../roads/policy.js';
import { locate } from '../verification/repository.js';
import { createPathService } from '../path-service.js';

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const RECORD_FILE = 'run.json';

export function evidencePath(plan, runId, name) {
  if (typeof name !== 'string' || !FILE_NAME.test(name) || name.includes('..')) throw new TypeError(`invalid evidence file name: ${JSON.stringify(name)}`);
  return `verifications/${plan}/evidence/${runId}/${name}`;
}
const runDirectory = (plan, runId) => `verifications/${plan}/evidence/${runId}`;
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

// input: { id, plan, snapshot, contractHash, startedAt, endedAt, status, steps, evidence, workflowRoot, generator? } -> { stored, text }
export function buildRunRecord({ id, plan, snapshot, contractHash, startedAt, endedAt, status, steps, evidence, workflowRoot, generator = GENERATOR }) {
  const document = {
    schema: RUN_SCHEMA, id, plan, snapshot, contract_hash: contractHash, started_at: startedAt, ended_at: endedAt, status, steps, evidence,
  };
  const stamped = withMeta(document, { schema: RUN_SCHEMA, generator, spec: RUN_SPEC });
  const verdict = validateRun(stamped, { form: 'stored', workflowRoot });
  if (!verdict.ok) throw new TypeError(`run record is invalid: ${verdict.issues.map(({ path, message }) => `${path} ${message}`).join('; ')}`);
  const text = canonicalizeJson(stamped, storedSpec(RUN_SPEC));
  return { stored: parseStrictJson(text).value, text };
}

async function writeThenRename(absolute, bytes) {
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, absolute);
}

// artifacts: [{ type, name, data }]; makeRecord(refs) -> buildRunRecord input.
// -> { evidence: refs, record_path, changed, record }
export async function writeRunFiles({ service, plan, runId, artifacts, makeRecord }) {
  const directory = await service.resolveWorkflowPath(runDirectory(plan, runId));
  if (directory.exists) throw new Error(`run directory already exists: ${directory.relative_path}`);
  const sorted = [...artifacts].sort((left, right) => compareStrings(left.name, right.name));
  try {
    const refs = [];
    for (const artifact of sorted) {
      const target = await service.resolveWorkflowPath(evidencePath(plan, runId, artifact.name));
      const bytes = Buffer.from(artifact.data);
      await writeThenRename(target.filesystem_path, bytes);
      refs.push({ path: target.relative_path, type: artifact.type, bytes: bytes.length, sha256: sha(bytes) });
    }
    refs.sort((left, right) => compareStrings(left.path, right.path));
    const { stored, text } = buildRunRecord({ ...makeRecord(refs), workflowRoot: service.workflow_relative_path });
    const record = await service.resolveWorkflowPath(evidencePath(plan, runId, RECORD_FILE));
    await writeThenRename(record.filesystem_path, Buffer.from(text));
    return { evidence: refs, record_path: record.relative_path, changed: [...refs.map(({ path }) => path), record.relative_path].sort(compareStrings), record: stored };
  } catch (error) {
    await rm(directory.filesystem_path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    throw error;
  }
}

// -> { runs: [{ id, path, record }] newest first, problems: [{ id, reason: 'incomplete' | 'invalid_record' | 'unsafe', path }] }
export async function readRuns({ repositoryRoot, workflowRoot, key }) {
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const base = await service.resolveWorkflowPath(`verifications/${key}/evidence`);
  if (!base.exists) return { runs: [], problems: [] };
  let entries;
  try {
    entries = await readdir(base.filesystem_path, { withFileTypes: true });
  } catch {
    return { runs: [], problems: [] };
  }
  const runs = [];
  const problems = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory() && ULID.test(candidate.name)).sort((a, b) => compareStrings(a.name, b.name))) {
    const id = entry.name;
    const file = await locate(service, `${runDirectory(key, id)}/${RECORD_FILE}`);
    const path = file.path ?? join(base.relative_path, id, RECORD_FILE).replaceAll('\\', '/');
    if (file.problem === 'unsafe') {
      problems.push({ id, reason: 'unsafe', path });
    } else if (!file.exists) {
      problems.push({ id, reason: 'incomplete', path });
    } else {
      const normalized = file.text === null ? { ok: false } : normalizeInput(Buffer.from(file.text));
      const parsed = normalized.ok ? parseStrictJson(normalized.text) : { ok: false };
      const valid = parsed.ok && validateRun(parsed.value, { form: 'stored', workflowRoot: service.workflow_relative_path }).ok
        && verifyMeta(parsed.value, { spec: RUN_SPEC }) === 'declared' && parsed.value.id === id && parsed.value.plan === key;
      if (valid) runs.push({ id, path: file.path, record: parsed.value });
      else problems.push({ id, reason: 'invalid_record', path });
    }
  }
  return { runs: runs.sort((left, right) => compareStrings(right.id, left.id)), problems };
}
