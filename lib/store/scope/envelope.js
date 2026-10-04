// The Leader-authored scope envelope (A1 5.2): which requests the CLI may grant by itself. Pure decisions; the
// grant itself is a recorded, guarded Road update done by the writer.
import { compareStrings } from '../../schemas/common.js';
import { inspectPath, pathOverlap } from '../../schemas/glob.js';
import { ENVELOPE_GRANT_CAP } from './policy.js';

const linesKey = (lines) => (lines === null || lines === undefined ? 'null' : `${lines[0]}-${lines[1]}`);
const inside = (patterns, path) => patterns.some((pattern) => pathOverlap(path, pattern) === 'overlap');
const literal = (path) => inspectPath(path).class === 'literal';

// The update-form Road plus the request delta: reads appended, writes merged (sorted by path); entries the Road already
// declares are skipped, so a request never duplicates a declaration. Returns { document, added }.
export function mergeScopeDelta(road, request) {
  const document = structuredClone(road);
  let added = 0;
  const known = new Set(document.reads.map((entry) => `${entry.path}|${linesKey(entry.lines)}`));
  for (const read of request.add_reads) {
    const key = `${read.path}|${linesKey(read.lines)}`;
    if (known.has(key)) continue;
    known.add(key);
    document.reads.push(structuredClone(read));
    added += 1;
  }
  const paths = new Set(document.writes.map(({ path }) => path));
  for (const write of request.add_writes) {
    if (paths.has(write.path)) continue;
    paths.add(write.path);
    document.writes.push(structuredClone(write));
    added += 1;
  }
  document.writes.sort((left, right) => compareStrings(left.path, right.path));
  return { document, added };
}

// road: the stored Road; request: the request fields (add_reads, add_writes); grants: envelope grants so far.
// Returns { eligible, reasons } with reasons from ENVELOPE_REASONS (a reason per rule that failed).
export function evaluateEnvelope({ road, request, grants }) {
  const policy = road.scope_policy;
  if (policy === null || policy === undefined) return { eligible: false, reasons: ['no_envelope'] };
  const reasons = new Set();
  if (grants >= ENVELOPE_GRANT_CAP) reasons.add('grant_cap');
  if (road.executor_class === 'weak' && request.add_writes.length > 0) reasons.add('weak_class_writes');
  for (const { path, class: pathClass } of request.add_writes) {
    if (pathClass !== 'file' || !literal(path) || !inside(policy.auto_writes, path)) reasons.add('outside_envelope');
  }
  for (const { path } of request.add_reads) {
    if (!literal(path) || !inside(policy.auto_reads, path)) reasons.add('outside_envelope');
  }
  const wanted = [...request.add_writes.map(({ path }) => path), ...request.add_reads.map(({ path }) => path)];
  if (wanted.some((path) => road.forbidden.some((pattern) => pathOverlap(path, pattern) !== 'disjoint'))) reasons.add('forbidden');
  return { eligible: reasons.size === 0, reasons: [...reasons].sort(compareStrings) };
}
