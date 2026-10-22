// The projects registry (F21): <config root>/projects.json, its own lock, whole-file temp-file rename writes. Plain functions: they print
// nothing, take the clock and the lock options as inputs and never touch a project.
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRunId } from '../core/providers.js';
import { validateWorkflowPath } from '../schemas/common.js';
import { checkEach, checkLiteral, checkText, checkTimestamp, validateClosedObject } from '../schemas/artifact-kit.js';
import { issue, validationResult } from '../schemas/validation.js';
import { canonicalizeJson, compareCodePoints, normalizeInput, parseStrictJson } from '../store/canonical/index.js';
import { withRepositoryLock } from '../store/lock/index.js';
import { EMPTY_SNAPSHOT } from '../store/snapshots/projections.js';
import {
  MAX_NAME_LENGTH, MAX_PROJECTS, PROJECT_KEYS, REGISTRY_FILE, REGISTRY_KEYS, REGISTRY_MAX_BYTES, REGISTRY_SCHEMA,
} from './policy.js';

export const REGISTRY_SPEC = Object.freeze({
  keys: [...REGISTRY_KEYS],
  arrays: { projects: { kind: 'set', sortKey: 'root', item: { keys: [...PROJECT_KEYS], arrays: {}, objects: {} } } },
  objects: {},
});

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const CONTROL = /[\u0000-\u001f\u007f\\]/;

// ---- validation -------------------------------------------------------------------------------------------
export function isNormalizedRoot(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return false;
  if (CONTROL.test(value)) return false;
  const match = /^(?:[A-Za-z]:\/|\/)(.+)$/.exec(value);
  if (match === null) return false;
  return match[1].split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function validateRegistry(value) {
  const issues = [];
  if (!validateClosedObject(value, REGISTRY_KEYS, '$', issues)) return validationResult(issues);
  checkLiteral(value.schema, REGISTRY_SCHEMA, '$.schema', issues);
  if (!Array.isArray(value.projects)) {
    issue(issues, '$.projects', 'invalid_type', 'must be an array');
    return validationResult(issues);
  }
  if (value.projects.length > MAX_PROJECTS) issue(issues, '$.projects', 'invalid_value', `at most ${MAX_PROJECTS} projects are registered`);
  const seen = new Set();
  let previous = null;
  checkEach(value.projects, '$.projects', issues, (entry, at) => {
    if (!validateClosedObject(entry, PROJECT_KEYS, at, issues)) return;
    if (!isNormalizedRoot(entry.root)) {
      issue(issues, `${at}.root`, 'invalid_path', 'must be a normalized absolute path (forward slashes, no . or .. segment, no trailing slash)');
    } else {
      if (seen.has(entry.root)) issue(issues, `${at}.root`, 'duplicate_value', 'a root is registered once');
      seen.add(entry.root);
      if (previous !== null && compareCodePoints(previous, entry.root) >= 0) issue(issues, `${at}.root`, 'invalid_order', 'projects are listed in code point order of root');
      previous = entry.root;
    }
    for (const problem of validateWorkflowPath(entry.workflow, `${at}.workflow`).issues) issues.push(problem);
    checkText(entry.name, `${at}.name`, issues, { singleLine: true });
    if (typeof entry.name === 'string' && [...entry.name].length > MAX_NAME_LENGTH) issue(issues, `${at}.name`, 'invalid_value', `at most ${MAX_NAME_LENGTH} characters`);
    checkTimestamp(entry.added_at, `${at}.added_at`, issues);
  });
  return validationResult(issues);
}

export const renderRegistry = (projects) => canonicalizeJson({ schema: REGISTRY_SCHEMA, projects }, REGISTRY_SPEC);
export const registryPath = (configRoot) => join(configRoot, REGISTRY_FILE);

// ---- reading ----------------------------------------------------------------------------------------------
const absent = () => ({ state: 'absent', projects: [], issues: [], snapshot: EMPTY_SNAPSHOT, bytes: null });

// -> { state: 'absent' | 'valid' | 'invalid', projects, issues, snapshot, bytes }. Never throws for a bad file.
export async function readRegistry({ configRoot, retries = 4 }) {
  const file = registryPath(configRoot);
  const invalid = (issues, bytes = null) => ({ state: 'invalid', projects: [], issues, snapshot: bytes === null ? EMPTY_SNAPSHOT : sha256(bytes), bytes });
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return absent();
    return invalid([{ path: '$', code: 'unreadable', message: `projects.json cannot be inspected (${error?.code ?? 'error'})` }]);
  }
  if (!metadata.isFile()) return invalid([{ path: '$', code: 'not_a_file', message: 'projects.json is a link, a directory or not a regular file' }]);
  if (metadata.size > REGISTRY_MAX_BYTES) return invalid([{ path: '$', code: 'too_large', message: `projects.json is larger than ${REGISTRY_MAX_BYTES} bytes` }]);
  let bytes = null;
  for (let attempt = 0; bytes === null; attempt += 1) {
    try {
      bytes = await readFile(file);
    } catch (error) {
      if (error?.code === 'ENOENT') return absent();
      if (!BUSY.has(error?.code) || attempt >= retries) return invalid([{ path: '$', code: 'unreadable', message: `projects.json cannot be read (${error?.code ?? 'error'})` }]);
      await sleep(10 * 2 ** attempt);
    }
  }
  const normalized = normalizeInput(bytes);
  const parsed = normalized.ok ? parseStrictJson(normalized.text) : normalized;
  if (!parsed.ok) return invalid([{ path: '$', code: 'invalid_json', message: 'projects.json is not valid JSON' }], bytes);
  const verdict = validateRegistry(parsed.value);
  if (!verdict.ok) return invalid(verdict.issues.map((entry) => ({ ...entry })), bytes);
  return { state: 'valid', projects: parsed.value.projects.map((entry) => ({ ...entry })), issues: [], snapshot: sha256(bytes), bytes };
}

// ---- writing ----------------------------------------------------------------------------------------------
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!BUSY.has(error?.code) || attempt >= 5) throw error;
      await sleep(10 * 2 ** attempt);
    }
  }
}

// Whole-file replace: temp file in the same directory (fsync), then rename over projects.json. Returns the new snapshot.
export async function writeRegistry({ configRoot, projects }) {
  const bytes = Buffer.from(renderRegistry(projects), 'utf8');
  const temporary = join(configRoot, `${REGISTRY_FILE}.tmp-${randomBytes(6).toString('hex')}`);
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temporary, registryPath(configRoot));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  if (process.platform !== 'win32') {
    try {
      const directory = await open(configRoot, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // a directory that cannot be synced still holds the renamed file
    }
  }
  return sha256(bytes);
}

// Runs `work(registry)` while holding the registry lock (never the lock of a project). `work` returns { projects?: the next list, ...result };
// a next list is written, anything else is not. A dry run reads only: no folder, no lock, no write.
async function transact({ configRoot, command, dryRun, lockOptions, work }) {
  if (dryRun) {
    const registry = await readRegistry({ configRoot });
    if (registry.state === 'invalid') return { status: 'invalid', registry };
    const outcome = await work(registry);
    const after = outcome.projects === undefined ? registry.snapshot : sha256(Buffer.from(renderRegistry(outcome.projects), 'utf8'));
    return { ...outcome, registry, before: registry.snapshot, after };
  }
  await mkdir(configRoot, { recursive: true });
  const runId = lockOptions?.runId ?? (() => createRunId(new Date(), randomBytes(10)));
  const locked = await withRepositoryLock({ ...(lockOptions ?? {}), runId, lockRoot: configRoot, command }, async () => {
    const registry = await readRegistry({ configRoot });
    if (registry.state === 'invalid') return { status: 'invalid', registry };
    const outcome = await work(registry);
    if (outcome.projects === undefined) return { ...outcome, registry, before: registry.snapshot, after: registry.snapshot };
    return { ...outcome, registry, before: registry.snapshot, after: await writeRegistry({ configRoot, projects: outcome.projects }) };
  });
  if (locked.status === 'ok') return locked.value;
  return { status: 'blocked', finding: locked.finding, lock: locked };
}

const byRoot = (left, right) => compareCodePoints(left.root, right.root);

// project: { root, workflow, name } (already inspected).
// -> { status: 'added' | 'updated' | 'noop' | 'full' | 'invalid' | 'blocked', project?, registry, before, after }
export function addProject({ configRoot, project, now, caseInsensitive = process.platform === 'win32', dryRun = false, lockOptions }) {
  const key = (root) => (caseInsensitive ? root.toLowerCase() : root);
  return transact({
    configRoot, command: 'projects-add', dryRun, lockOptions,
    work: async ({ projects }) => {
      const existing = projects.find((entry) => key(entry.root) === key(project.root));
      if (existing !== undefined) {
        if (existing.workflow === project.workflow && existing.name === project.name) return { status: 'noop', project: existing };
        const updated = { ...existing, workflow: project.workflow, name: project.name };
        return { status: 'updated', project: updated, projects: projects.map((entry) => (entry === existing ? updated : entry)).sort(byRoot) };
      }
      if (projects.length >= MAX_PROJECTS) return { status: 'full' };
      const added = { root: project.root, workflow: project.workflow, name: project.name, added_at: now() };
      return { status: 'added', project: added, projects: [...projects, added].sort(byRoot) };
    },
  });
}

// match: (project) => boolean.
// -> { status: 'removed' | 'not_found' | 'ambiguous' | 'invalid' | 'blocked', project?, candidates?, registry, before, after }
export function removeProject({ configRoot, match, dryRun = false, lockOptions }) {
  return transact({
    configRoot, command: 'projects-remove', dryRun, lockOptions,
    work: async ({ projects }) => {
      const found = projects.filter(match);
      if (found.length === 0) return { status: 'not_found' };
      if (found.length > 1) return { status: 'ambiguous', candidates: found };
      return { status: 'removed', project: found[0], projects: projects.filter((entry) => entry !== found[0]) };
    },
  });
}
