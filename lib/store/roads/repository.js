// Road repository: where Roads live, how they are read back (`declared` or `unverified`, never silently accepted)
// and how an agent-authored INPUT document becomes the canonical stored file. Reads only; the one write path is
// the transaction coordinator (writers.js).
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { compareStrings, isId } from '../../schemas/common.js';
import { ROAD_INPUT_KEYS, ROAD_SPEC, validateRoad } from '../../schemas/road.js';
import { canonicalizeJson, normalizeInput, parseStrictJson, storedSpec, verifyMeta, withMeta } from '../canonical/index.js';
import { createPathService } from '../path-service.js';
import { inRepository } from './paths.js';
import { GENERATOR, PLAN_DIRECTORY, ROAD_DIRECTORY } from './policy.js';

export class RoadStoreError extends Error {
  constructor(code, path, message, issues = []) {
    super(message);
    this.name = 'RoadStoreError';
    this.code = code;
    this.path = path;
    this.issues = issues;
  }
}

const JSON_EXTENSION = '.json';

// `workflowRoot` for the schema validators is the repository-relative workflow directory ('' means the workflow IS
// the repository, where the validators fall back to their default).
export const workflowOption = (pathService) => (pathService.workflow_relative_path === ''
  ? {}
  : { workflowRoot: pathService.workflow_relative_path });

const idOf = (path) => basename(path).slice(0, -JSON_EXTENSION.length);
const byIdThenPath = (left, right) => compareStrings(left.id, right.id) || compareStrings(left.path, right.path);

// Every roads/**/*.json, nested plan folders included. The file base name is the Road ID; duplicates are all listed.
export async function listRoadFiles({ repositoryRoot, workflowRoot }) {
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const prefix = service.workflow_relative_path === '' ? '' : `${service.workflow_relative_path}/`;
  const files = await service.walkWorkflowFiles(ROAD_DIRECTORY);
  return files.filter((path) => path.endsWith(JSON_EXTENSION)).map((path) => ({
    id: idOf(path), path, workflow_path: path.slice(prefix.length),
  })).sort(byIdThenPath);
}

// One global ID namespace: Roads (anywhere under roads/) and Plans (plans/<id>.json).
export async function collectIdentities({ repositoryRoot, workflowRoot }) {
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const roads = (await listRoadFiles({ repositoryRoot, workflowRoot })).map(({ id, path }) => ({ id, kind: 'road', path }));
  const plansPrefix = inRepository(service.workflow_relative_path, `${PLAN_DIRECTORY}/`);
  const plans = (await service.walkWorkflowFiles(PLAN_DIRECTORY))
    .filter((path) => path.endsWith(JSON_EXTENSION) && !path.slice(plansPrefix.length).includes('/'))
    .map((path) => ({ id: idOf(path), kind: 'plan', path }));
  return [...plans, ...roads].sort(byIdThenPath);
}

async function readJsonFile(service, path) {
  const resolved = await service.resolveRepositoryPath(path);
  const bytes = await readFile(resolved.filesystem_path);
  const normalized = normalizeInput(bytes);
  if (!normalized.ok) throw new RoadStoreError('unreadable', path, `${path}: ${normalized.issues[0].message}`, normalized.issues);
  const parsed = parseStrictJson(normalized.text);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    const issues = parsed.ok ? [{ path: '$', code: 'invalid_type', message: 'must be an object' }] : parsed.issues;
    throw new RoadStoreError('unreadable', path, `${path}: ${issues[0].message}`, issues);
  }
  return parsed.value;
}

// { road, meta_state: 'declared' | 'unverified', path, issues } or null. `declared` needs the stored schema to hold,
// the ID to equal the file name and the content hash to verify; anything else is `unverified` and `issues` says why.
export async function readRoad({ repositoryRoot, workflowRoot, id }) {
  if (!isId(id)) throw new TypeError('id must be a valid ID');
  const matches = (await listRoadFiles({ repositoryRoot, workflowRoot })).filter((file) => file.id === id);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new RoadStoreError('ambiguous', null, `Road ${id} exists in more than one file: ${matches.map(({ path }) => path).join(', ')}`);
  }
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const [{ path }] = matches;
  const road = await readJsonFile(service, path);
  const issues = validateRoad(road, { form: 'stored', ...workflowOption(service) }).issues.map((entry) => ({ ...entry }));
  if (road.id !== id) issues.push({ path: '$.id', code: 'invalid_value', message: 'must equal the file name' });
  const declared = issues.length === 0 && verifyMeta(road, { spec: ROAD_SPEC }) === 'declared';
  return { road, meta_state: declared ? 'declared' : 'unverified', path, issues };
}

// The dependency graph's nodes, read leniently (only `deps` is needed, so a hand-edited or non-canonical Road still
// contributes its edges). A file that cannot give a dependency list is a `problem`: the graph is incomplete there.
export async function readRoadGraph({ repositoryRoot, workflowRoot }) {
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const nodes = [];
  const problems = [];
  for (const { id, path } of await listRoadFiles({ repositoryRoot, workflowRoot })) {
    try {
      const value = await readJsonFile(service, path);
      if (!Array.isArray(value.deps) || value.deps.some((dependency) => typeof dependency !== 'string')) {
        problems.push({ path, reason: 'deps is not a list of Road IDs' });
      } else {
        nodes.push({ id, path, deps: [...value.deps] });
      }
    } catch (error) {
      if (!(error instanceof RoadStoreError)) throw error;
      problems.push({ path, reason: error.message });
    }
  }
  return { nodes, problems };
}

const need = (value, message) => {
  if (!value) throw new TypeError(message);
};

// INPUT document -> stored object: the CLI fills `status` (QUEUED) and `meta`, nothing else; set arrays come back
// code point sorted, ordered arrays untouched. The input must already be valid (callers validate first).
export function buildStoredRoad(input, { generator = GENERATOR, workflowRoot } = {}) {
  need(input !== null && typeof input === 'object' && !Array.isArray(input), 'a Road document is required');
  for (const key of Object.keys(input)) need(ROAD_INPUT_KEYS.includes(key), `unknown or CLI-owned Road key: ${key}`);
  const verdict = validateRoad(input, { form: 'input', ...(workflowRoot === undefined ? {} : { workflowRoot }) });
  need(verdict.ok, `Road input is invalid: ${verdict.issues.map(({ path, message }) => `${path} ${message}`).join('; ')}`);
  const ordered = Object.fromEntries(ROAD_SPEC.keys.map((key) => [key, key === 'status' ? 'QUEUED' : input[key]]));
  const stamped = withMeta(ordered, { schema: input.schema, generator, spec: ROAD_SPEC });
  const text = canonicalizeJson(stamped, storedSpec(ROAD_SPEC));
  return parseStrictJson(text).value;
}

export function renderRoad(stored, { workflowRoot } = {}) {
  const verdict = validateRoad(stored, { form: 'stored', ...(workflowRoot === undefined ? {} : { workflowRoot }) });
  need(verdict.ok, `stored Road is invalid: ${verdict.issues.map(({ path, message }) => `${path} ${message}`).join('; ')}`);
  return canonicalizeJson(stored, storedSpec(ROAD_SPEC));
}
