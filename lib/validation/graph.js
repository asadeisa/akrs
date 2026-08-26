import { compareStrings } from '../schemas/common.js';
import { compareFindings } from '../schemas/finding.js';

function roadOrder(left, right) {
  return compareStrings(left.file, right.file);
}

function finding({ code, severity = 'error', message, file, line = null, detail }) {
  return { code, severity, message, file, line, detail };
}

export function registerRoadIdentities(roads) {
  const ordered = [...roads].sort(roadOrder);
  const groups = new Map();
  for (const road of ordered) {
    if (!groups.has(road.id)) groups.set(road.id, []);
    groups.get(road.id).push(road);
  }

  const findings = [];
  for (const [id, matches] of [...groups].sort(([left], [right]) => compareStrings(left, right))) {
    if (matches.length < 2) continue;
    const conflictingFiles = matches.map(({ file }) => file).sort();
    for (const road of matches) {
      findings.push(finding({
        code: 'AKRS-R001',
        message: `Duplicate Road identity "${id}".`,
        file: road.file,
        line: road.line ?? null,
        detail: { road_id: id, conflicting_files: conflictingFiles },
      }));
    }
  }
  findings.sort(compareFindings);
  if (findings.length > 0) return { ok: false, by_id: null, findings };
  return { ok: true, by_id: new Map(ordered.map((road) => [road.id, road])), findings: [] };
}

export function analyzeDependencyReferences(roads, byId) {
  const findings = [];
  const ordered = [...roads].sort(roadOrder);
  for (const road of ordered) {
    for (const dependency of [...road.deps].sort()) {
      if (byId.has(dependency)) continue;
      findings.push(finding({
        code: 'AKRS-R005',
        message: `Road dependency "${dependency}" does not exist.`,
        file: road.file,
        line: road.line ?? null,
        detail: { road_id: road.id, dependency, status: road.status ?? 'UNKNOWN' },
      }));
    }
  }
  findings.sort(compareFindings);
  return { examined_count: ordered.length, findings };
}

function stronglyConnectedComponents(roads, byId) {
  const adjacency = new Map([...byId.keys()].sort().map((id) => [
    id,
    [...new Set(byId.get(id).deps.filter((dependency) => byId.has(dependency)))].sort(),
  ]));
  const indexById = new Map();
  const lowLink = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  let index = 0;

  function visit(id) {
    indexById.set(id, index);
    lowLink.set(id, index);
    index += 1;
    stack.push(id);
    onStack.add(id);

    for (const dependency of adjacency.get(id)) {
      if (!indexById.has(dependency)) {
        visit(dependency);
        lowLink.set(id, Math.min(lowLink.get(id), lowLink.get(dependency)));
      } else if (onStack.has(dependency)) {
        lowLink.set(id, Math.min(lowLink.get(id), indexById.get(dependency)));
      }
    }

    if (lowLink.get(id) === indexById.get(id)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== id);
      component.sort();
      if (component.length > 1 || adjacency.get(id).includes(id)) components.push(component);
    }
  }

  for (const id of adjacency.keys()) if (!indexById.has(id)) visit(id);
  return { adjacency, components: components.sort((left, right) => compareStrings(left[0], right[0])) };
}

function cyclePath(component, adjacency) {
  if (component.length === 1) return [component[0], component[0]];
  const allowed = new Set(component);
  const start = component[0];

  function search(current, path, seen) {
    for (const next of adjacency.get(current).filter((id) => allowed.has(id))) {
      if (next === start) return [...path, start];
      if (seen.has(next)) continue;
      const result = search(next, [...path, next], new Set([...seen, next]));
      if (result) return result;
    }
    return null;
  }
  return search(start, [start], new Set([start])) ?? [...component, start];
}

export function analyzeDependencyCycles(roads, byId) {
  const { adjacency, components } = stronglyConnectedComponents(roads, byId);
  const findings = components.map((component) => {
    const cycle = cyclePath(component, adjacency);
    const road = byId.get(cycle[0]);
    return finding({
      code: 'AKRS-R006',
      message: `Road dependency cycle: ${cycle.join(' -> ')}.`,
      file: road.file,
      line: road.line ?? null,
      detail: { cycle },
    });
  }).sort(compareFindings);
  return { examined_count: roads.length, findings };
}

export function analyzeDependencyReadiness(roads, byId) {
  const active = roads
    .filter((road) => road.status === 'ACTIVE' && road.deps.length > 0)
    .sort(roadOrder);
  const findings = [];
  for (const road of active) {
    for (const dependency of [...road.deps].sort()) {
      const target = byId.get(dependency);
      if (target?.status === 'DONE') continue;
      findings.push(finding({
        code: 'AKRS-R007',
        message: `ACTIVE Road dependency "${dependency}" is not DONE.`,
        file: road.file,
        line: road.line ?? null,
        detail: {
          road_id: road.id,
          dependency,
          dependency_status: target?.status ?? 'MISSING',
        },
      }));
    }
  }
  findings.sort(compareFindings);
  return { examined_count: active.length, findings };
}
