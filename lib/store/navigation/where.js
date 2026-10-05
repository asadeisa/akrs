// `where <path>` (P2-W09): four deterministic relations, labelled provisional. No file content is read and nothing is guessed.
import { compareStrings } from '../../schemas/common.js';
import { WHERE_SCHEMA } from './policy.js';
import { matchOf, strongest } from './paths.js';

const VIA_RANK = { writer: 0, reader: 1, plan: 2 };

export function buildWhereData(model, path) {
  const writers = [];
  const readers = [];
  for (const road of model.roads) {
    const writes = road.writes.map((write) => ({ write, match: matchOf(write.path, write.class, path) })).filter(({ match }) => match !== null);
    if (writes.length > 0) {
      const first = writes[0];
      writers.push({ road: road.id, status: road.status, match: strongest(writes.map(({ match }) => match)), pattern: first.write.path, action: first.write.action });
    }
    const reads = road.reads.map((read) => ({ read, match: matchOf(read.path, null, path) })).filter(({ match }) => match !== null);
    if (reads.length > 0) {
      readers.push({
        road: road.id, status: road.status, match: strongest(reads.map(({ match }) => match)), pattern: reads[0].read.path,
        windows: reads.map(({ read }) => ({ lines: read.lines, why: read.why })),
      });
    }
  }
  const scopeRequests = [];
  for (const request of model.requests) {
    for (const via of ['add_reads', 'add_writes']) {
      const matches = (request[via] ?? []).map((entry) => matchOf(entry.path, entry.class ?? null, path)).filter((match) => match !== null);
      if (matches.length > 0) scopeRequests.push({ id: request.id, road: request.road, state: request.state, blocking: request.blocking === true, via, match: strongest(matches) });
    }
  }
  const touching = new Map();
  for (const entry of readers) touching.set(entry.road, 'reader');
  for (const entry of writers) touching.set(entry.road, 'writer');
  const planOf = new Map(model.roads.map(({ id, plan }) => [id, plan]));
  const relevant = new Map();
  for (const [road, via] of touching) {
    relevant.set(`road:${road}`, via);
    const plan = planOf.get(road);
    if (plan !== null && plan !== undefined && !relevant.has(`plan:${plan}`)) relevant.set(`plan:${plan}`, 'plan');
  }
  const closures = model.closures
    .filter((record) => relevant.has(`${record.kind}:${record.subject}`))
    .map((record) => ({ id: record.id, kind: record.kind, subject: record.subject, outcome: record.outcome, ts: record.ts, via: relevant.get(`${record.kind}:${record.subject}`) }))
    .sort((left, right) => compareStrings(left.ts, right.ts) || compareStrings(left.id, right.id) || VIA_RANK[left.via] - VIA_RANK[right.via]);
  const sorted = (list, keys) => list.sort((left, right) => keys.reduce((order, key) => order || compareStrings(String(left[key]), String(right[key])), 0));
  return {
    kind: 'where',
    packet_version: WHERE_SCHEMA,
    path,
    provisional: true,
    relations: {
      closures,
      readers: sorted(readers, ['road']),
      scope_requests: sorted(scopeRequests, ['road', 'id', 'via']),
      writers: sorted(writers, ['road']),
    },
  };
}

// The Roads that touch a path (writers and readers), for `graph --touches`.
export function touchingRoads(model, path) {
  const data = buildWhereData(model, path);
  return new Set([...data.relations.writers.map(({ road }) => road), ...data.relations.readers.map(({ road }) => road)]);
}
