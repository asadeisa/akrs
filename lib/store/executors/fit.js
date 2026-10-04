// Route fit: load of a Road against its class profile, the verdict and deterministic split suggestions. evaluateFit and
// the suggestion cut are pure; roadFit gathers the load from the repository (reads only).
import { compareStrings } from '../../schemas/common.js';
import { readRoad, readRoadGraph } from '../roads/repository.js';
import { projectReadWindows } from '../roads/read-windows.js';
import { estimateTokens } from './estimator.js';
import { resolveProfile } from './profiles.js';
import { readExecutors } from './repository.js';

const dirOf = (path) => path.split('/').slice(0, -1).join('/');

// The directory a write belongs to: file -> its directory; dir -> itself; glob -> its literal directory prefix.
export function writeDirectory(write) {
  if (write.class === 'dir') return write.path;
  if (write.class === 'glob') {
    const literal = [];
    for (const segment of write.path.split('/')) {
      if (/[*?]/.test(segment)) break;
      literal.push(segment);
    }
    return literal.join('/');
  }
  return dirOf(write.path);
}

export function loadOf({ road, read_tokens: readTokens, depth }) {
  const writes = road.writes ?? [];
  return {
    writes: writes.length,
    write_classes: [...new Set(writes.map(({ class: kind }) => kind))].sort(compareStrings),
    write_dirs: new Set(writes.map(writeDirectory)).size,
    read_tokens: readTokens,
    dependency_depth: depth,
  };
}

// -> { load, violations: [{ knob, limit, actual }], verdict, complexity }
export function evaluateFit({ road, profile, read_tokens: readTokens, depth }) {
  const load = loadOf({ road, read_tokens: readTokens, depth });
  const violations = [];
  const add = (knob, limit, actual) => violations.push({ knob, limit, actual });
  if (load.writes > profile.max_writes) add('max_writes', profile.max_writes, load.writes);
  if (load.write_dirs > profile.max_write_dirs) add('max_write_dirs', profile.max_write_dirs, load.write_dirs);
  const outside = load.write_classes.filter((kind) => !profile.write_classes.includes(kind));
  if (outside.length > 0) add('write_classes', profile.write_classes.join(','), outside.join(','));
  if (profile.steps_required && (road.steps ?? []).length === 0) add('steps_required', 1, 0);
  if (profile.check_required && (road.checks ?? []).length === 0) add('check_required', 1, 0);
  const overBudget = load.read_tokens > profile.read_budget_tokens;
  if (overBudget) add('read_budget_tokens', profile.read_budget_tokens, load.read_tokens);
  violations.sort((left, right) => compareStrings(left.knob, right.knob));
  let verdict = 'fits';
  if (violations.some(({ knob }) => knob !== 'read_budget_tokens')) verdict = 'split_required';
  else if (overBudget) verdict = 'reads_over_budget';
  return { load, violations, verdict, complexity: road.complexity ?? null };
}

// Deterministic split suggestions (policy.suggestions). `reads` is [{ read, tokens }] in the Road's order.
export function splitSuggestions({ road, profile, reads }) {
  const sorted = [...(road.writes ?? [])].sort((a, b) => compareStrings(writeDirectory(a), writeDirectory(b)) || compareStrings(a.path, b.path));
  const writeGroups = [];
  let current = null;
  for (const write of sorted) {
    const directory = writeDirectory(write);
    if (current === null || current.writes.length >= profile.max_writes || (!current.dirs.has(directory) && current.dirs.size >= profile.max_write_dirs)) {
      current = { writes: [], dirs: new Set() };
      writeGroups.push(current);
    }
    current.writes.push(write);
    current.dirs.add(directory);
  }
  const readGroups = [];
  let bucket = null;
  for (const entry of reads) {
    if (bucket === null || (bucket.tokens + entry.tokens > profile.read_budget_tokens && bucket.reads.length > 0)) {
      bucket = { reads: [], tokens: 0 };
      readGroups.push(bucket);
    }
    bucket.reads.push(entry.read);
    bucket.tokens += entry.tokens;
  }
  const count = Math.max(writeGroups.length, readGroups.length, 1);
  return Array.from({ length: count }, (_, index) => ({
    name: `${road.id}-split-${index + 1}`,
    writes: writeGroups[index]?.writes ?? [],
    reads: readGroups[index]?.reads ?? [],
    read_tokens: readGroups[index]?.tokens ?? 0,
  }));
}

// The Road INPUT draft of one suggestion group.
export function suggestionDraft(road, group) {
  const { status: _status, meta: _meta, ...rest } = road;
  return { ...rest, id: group.name, task: null, writes: group.writes, reads: group.reads, oversize_reason: null };
}

// Estimated read tokens per declared read (windows only; globs, dirs, missing and binary files cost 0).
export async function readTokensOf({ repositoryRoot, workflowRoot, road }) {
  const windows = await projectReadWindows({ repositoryRoot, workflowRoot, road, includeText: true });
  return windows.map((entry, index) => ({ read: road.reads[index], tokens: typeof entry.text === 'string' ? estimateTokens(entry.text) : 0 }));
}

async function dependencyDepth({ repositoryRoot, workflowRoot, road }) {
  const graph = await readRoadGraph({ repositoryRoot, workflowRoot });
  const deps = new Map(graph.nodes.map(({ id, deps: list }) => [id, list]));
  if (road.id !== undefined) deps.set(road.id, road.deps ?? []);
  const memo = new Map();
  const depthOf = (id, trail) => {
    if (memo.has(id)) return memo.get(id);
    if (trail.has(id)) return 0;
    trail.add(id);
    const best = (deps.get(id) ?? []).reduce((max, dependency) => Math.max(max, 1 + depthOf(dependency, trail)), 0);
    trail.delete(id);
    memo.set(id, best);
    return best;
  };
  return depthOf(road.id, new Set());
}

// options: { repositoryRoot, workflowRoot, id?, document?, class? } -> { problem } | { fit }
export async function roadFit({ repositoryRoot, workflowRoot, id, document, class: requested }) {
  let road = document ?? null;
  if (road === null) {
    const found = await readRoad({ repositoryRoot, workflowRoot, id });
    if (found === null) return { problem: 'road_missing' };
    if (found.meta_state !== 'declared') return { problem: 'road_unverified' };
    road = found.road;
  }
  const cls = requested ?? road.executor_class ?? null;
  if (cls === null) return { problem: 'class_missing' };
  const executors = await readExecutors({ repositoryRoot, workflowRoot });
  const profile = resolveProfile(cls, executors.class_overrides);
  const reads = await readTokensOf({ repositoryRoot, workflowRoot, road });
  const depth = await dependencyDepth({ repositoryRoot, workflowRoot, road });
  const evaluated = evaluateFit({ road, profile, read_tokens: reads.reduce((sum, { tokens }) => sum + tokens, 0), depth });
  const suggestions = evaluated.verdict === 'fits' ? [] : splitSuggestions({ road, profile, reads });
  return {
    fit: {
      road: road.id ?? null, class: cls, profile, ...evaluated, suggestions, leader_class: executors.leader_class, unclassified: executors.unclassified,
    },
    road,
  };
}
