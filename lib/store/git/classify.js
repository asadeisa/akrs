// Classify git changes against one Road's declarations. Pure: no git, no file system.
import { compareStrings } from '../../schemas/common.js';
import { pathOverlap } from '../../schemas/glob.js';
import {
  AGENT_ADAPTER_DIRECTORIES, AGENT_ADAPTER_FILES, AUDIT_CATEGORIES, CACHE_NAMESPACES, DRAFT_NAMESPACES, EVIDENCE_PATTERN, TEST_DIRECTORIES,
  TEST_FILE_PATTERN, WORKFLOW_DIRECTORIES, WORKFLOW_FILES,
} from './policy.js';

const under = (path, directory) => path === directory || path.startsWith(`${directory}/`);

// The part of a repository path inside the workflow, or null.
function workflowPart(path, workflowRelative) {
  if (workflowRelative !== '') return path.startsWith(`${workflowRelative}/`) ? path.slice(workflowRelative.length + 1) : null;
  const top = path.split('/')[0];
  const known = [...WORKFLOW_DIRECTORIES, ...WORKFLOW_FILES, ...DRAFT_NAMESPACES, ...CACHE_NAMESPACES];
  return known.includes(top) ? path : null;
}

const isAdapter = (path) => AGENT_ADAPTER_FILES.includes(path) || AGENT_ADAPTER_DIRECTORIES.some((directory) => under(path, directory));
const isTest = (path) => {
  const segments = path.split('/');
  return segments.slice(0, -1).some((segment) => TEST_DIRECTORIES.includes(segment)) || TEST_FILE_PATTERN.test(segments.at(-1));
};
const matches = (path, pattern) => pathOverlap(path, pattern) === 'overlap';

// Does a declared write cover this path? -> the declared path or null.
function declaredBy(path, writes) {
  for (const write of writes) {
    if (write.class === 'glob' ? matches(path, write.path) : (write.class === 'dir' ? under(path, write.path) : write.path === path)) return write.path;
  }
  return null;
}

// options: { changes: [{ path, staged, unstaged, untracked }], road: { writes, forbidden }, workflowRelative, preExisting: [] }
// -> { categories: { <AUDIT_CATEGORIES>: [] } }
export function classifyChanges({ changes, road, workflowRelative, preExisting = [] }) {
  const categories = Object.fromEntries(AUDIT_CATEGORIES.map((name) => [name, []]));
  const baseline = new Set(preExisting);
  const writes = road.writes ?? [];
  const forbidden = road.forbidden ?? [];
  const caseIndex = new Map(writes.filter(({ class: kind }) => kind === 'file').map(({ path }) => [path.toLowerCase(), path]));
  for (const change of changes) {
    const { path } = change;
    const inside = workflowPart(path, workflowRelative);
    let category;
    if (inside !== null && DRAFT_NAMESPACES.some((name) => under(inside, name))) category = 'workflow_draft';
    else if (inside !== null && CACHE_NAMESPACES.some((name) => under(inside, name))) category = 'workflow_cache';
    else if (baseline.has(path)) category = 'pre_existing';
    else if (isAdapter(path)) category = 'agent_adapter';
    else if (inside !== null && EVIDENCE_PATTERN.test(inside)) category = 'evidence';
    else if (inside !== null) category = 'workflow';
    else if (declaredBy(path, writes) !== null) category = 'declared';
    else if (isTest(path)) category = 'test';
    else category = 'undeclared';
    const entry = { ...change };
    if (category === 'undeclared') {
      const declaredAs = caseIndex.get(path.toLowerCase()) ?? null;
      entry.forbidden = forbidden.some((pattern) => matches(path, pattern));
      entry.case_mismatch = declaredAs !== null && declaredAs !== path;
      entry.declared_as = entry.case_mismatch ? declaredAs : null;
    }
    categories[category].push(entry);
  }
  const changed = new Set(changes.map(({ path }) => path));
  categories.missing_declared = writes
    .filter(({ class: kind, path }) => kind === 'file' && !changed.has(path))
    .map(({ path, action }) => ({ path, action }));
  for (const list of Object.values(categories)) list.sort((left, right) => compareStrings(left.path, right.path));
  return { categories };
}
