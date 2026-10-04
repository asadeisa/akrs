// P2-W02: the deterministic relation projections of a Road packet, derived only from canonical readers (the Road survey,
// the closure ledger, Memory). Nothing here writes, guesses semantic equivalence or reads Task prose.
import { compareStrings } from '../../schemas/common.js';
import { pathOverlap } from '../../schemas/glob.js';
import { readLog } from '../log/index.js';
import { readMemory } from '../memory/index.js';

export const RECENT_LIMIT = 5;

// A `dir` write (or a read that names a folder with a trailing slash) is passed as `d/**`, the form pathOverlap decides.
const patternOf = (path, pathClass = null) => (pathClass === 'dir' || path.endsWith('/') ? `${path.replace(/\/+$/, '')}/**` : path);
const COLLISION_ORDER = Object.freeze({ write_write: 0, my_write_their_read: 1, their_write_my_read: 2 });

// mine: { id, writes: [{ path, class }], reads: [{ path }] }; survey: Map(id -> { status, writes, reads }).
// A finished Road no longer changes anything, so it never collides.
export function projectCollisions({ id, writes, reads, survey }) {
  const found = [];
  for (const [other, entry] of survey) {
    if (other === id || entry.status === 'DONE' || entry.status === null) continue;
    const add = (kind, mine, theirs, left, right) => {
      const state = pathOverlap(left, right);
      if (state !== 'disjoint') found.push({ road: other, road_status: entry.status, kind, state, mine, theirs });
    };
    for (const mine of writes) {
      for (const theirs of entry.writes) add('write_write', mine.path, theirs.path, patternOf(mine.path, mine.class), patternOf(theirs.path, theirs.class));
      for (const theirs of entry.reads) add('my_write_their_read', mine.path, theirs.path, patternOf(mine.path, mine.class), patternOf(theirs.path));
    }
    for (const theirs of entry.writes) {
      for (const mine of reads) add('their_write_my_read', mine.path, theirs.path, patternOf(mine.path), patternOf(theirs.path, theirs.class));
    }
  }
  return found.sort((left, right) => compareStrings(left.road, right.road)
    || COLLISION_ORDER[left.kind] - COLLISION_ORDER[right.kind]
    || compareStrings(left.mine, right.mine) || compareStrings(left.theirs, right.theirs));
}

// The newest closures of the Road's dependencies and of the Roads it collides with; never the whole ledger.
export async function projectRecent({ repositoryRoot, workflowRoot, deps, collidingRoads }) {
  const relation = new Map();
  for (const road of collidingRoads) relation.set(road, 'collision');
  for (const road of deps) relation.set(road, 'dependency');
  if (relation.size === 0) return [];
  const log = await readLog({ repositoryRoot, workflowRoot });
  return log.records
    .filter((record) => record.meta_state === 'declared' && record.kind === 'road' && relation.has(record.subject))
    .sort((left, right) => compareStrings(right.ts, left.ts) || compareStrings(right.id, left.id))
    .slice(0, RECENT_LIMIT)
    .map((record) => ({
      id: record.id, ts: record.ts, kind: record.kind, subject: record.subject, outcome: record.outcome, deviations: record.deviations, relation: relation.get(record.subject),
    }));
}

// Decided Memory facts whose pointers touch a path the Road reads or writes. Assumptions and Unknowns are not conventions.
export async function projectConventions({ repositoryRoot, workflowRoot, paths }) {
  if (paths.length === 0) return [];
  const memory = await readMemory({ repositoryRoot, workflowRoot });
  return memory.facts
    .filter((record) => record.label === 'Decided'
      && record.pointers.some((pointer) => paths.some((path) => pathOverlap(patternOf(pointer.path), path) !== 'disjoint')))
    .sort((left, right) => compareStrings(left.id, right.id))
    .map((record) => ({
      id: record.id, topic: record.topic, label: record.label, decided_by: record.decided_by, text: record.text,
      pointers: record.pointers.map((pointer) => ({ path: pointer.path, lines: pointer.lines === null ? null : [...pointer.lines] })),
    }));
}

export const stalePackets = ({ id, lease }) => (lease.state === 'stale' && lease.holder !== null ? [{ kind: 'road_lease', road: id, holder: lease.holder }] : []);
export { patternOf };
