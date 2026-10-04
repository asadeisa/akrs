// The core of `road-details`: ONE packet source over the canonical Phase-1 readers, projected by role. It reads and
// computes only; it never writes (not even a lease), never parses Task prose, and never shortens a packet to fit.
//
// buildRoadDetails(options) -> { problem } | { status, data, findings, nextCommands, snapshot }
//   options: { repositoryRoot, workflowRoot, id, role?, includeReads?, noIncludeReads?, full?, reuse?, maxTokens?, env?, rootArgs? }
// buildFreshRoadPacket(options) is the same builder under the name P1-W07 grants and P2-W12 stale deltas embed:
//   -> { status, data, findings, snapshot }
import { isId, compareStrings } from '../../schemas/common.js';
import { pathOverlap } from '../../schemas/glob.js';
import {
  DEPENDENCY_STATUSES, RESOLVED_READ_STATUSES, ROAD_DETAILS_SCHEMA, validateRoadDetails,
} from '../../schemas/road-details.js';
import { estimateTokens, resolveProfile, readExecutors, roadFit } from '../executors/index.js';
import { LEASE_CONTRACT_PROJECTION, commandSnapshot, computeSnapshot } from '../snapshots/index.js';
import { checkLease, readLease, resolveHolder } from '../leases/index.js';
import { createPathService } from '../path-service.js';
import { ENVELOPE_GRANT_CAP } from '../scope/policy.js';
import { readScope } from '../scope/index.js';
import { inRepository, taskPath } from '../roads/paths.js';
import { projectReadWindows } from '../roads/read-windows.js';
import { RoadStoreError, listRoadFiles, readRoadAt } from '../roads/repository.js';
import { auditRoad } from '../git/index.js';
import { ROAD_DETAILS_NEXT_COMMAND_BUILDERS } from './next-commands.js';
import { patternOf, projectCollisions, projectConventions, projectRecent, stalePackets } from './relations.js';
import { scanReuse } from './reuse-scan.js';

export { ROAD_DETAILS_NEXT_COMMAND_BUILDERS };
export const ROAD_DETAILS_FINDING_CODES = Object.freeze({ blocked: 'AKRS-R020', refused: 'AKRS-R021', consumed: 'AKRS-R022' });

const builder = ROAD_DETAILS_NEXT_COMMAND_BUILDERS['road-details'];
const sortedCodePoints = (values) => [...values].sort(compareStrings);
const blockedFinding = (road, reason, extra = {}) => ({
  code: ROAD_DETAILS_FINDING_CODES.blocked,
  severity: 'error',
  message: extra.message ?? `road-details for ${road} is blocked: ${reason}.`,
  file: extra.file ?? null,
  line: null,
  detail: { road, reason, subject: extra.subject ?? null, index: extra.index ?? null, status: extra.status ?? null },
});

// Every Road file, read leniently: its ID, lifecycle status, verification state and ephemeral write patterns. A file that
// cannot give a Road object is skipped (validate reports it); the packet only needs what the Road itself declares.
async function surveyRoads({ repositoryRoot, workflowRoot }) {
  const survey = new Map();
  for (const file of await listRoadFiles({ repositoryRoot, workflowRoot })) {
    try {
      const { road, meta_state: metaState } = await readRoadAt({ repositoryRoot, workflowRoot, path: file.path, id: file.id });
      const entry = survey.get(file.id) ?? { status: null, meta_state: metaState, ephemerals: [], deps: [], writes: [], reads: [], files: 0 };
      entry.files += 1;
      entry.status = typeof road.status === 'string' ? road.status : null;
      entry.deps = Array.isArray(road.deps) ? road.deps.filter((dependency) => typeof dependency === 'string') : [];
      entry.writes = (Array.isArray(road.writes) ? road.writes : []).filter((write) => typeof write?.path === 'string').map(({ path, class: pathClass }) => ({ path, class: pathClass }));
      entry.reads = (Array.isArray(road.reads) ? road.reads : []).filter((read) => typeof read?.path === 'string').map(({ path }) => ({ path }));
      entry.ephemerals = (Array.isArray(road.writes) ? road.writes : []).filter((write) => write?.class === 'ephemeral' && typeof write.path === 'string').map(({ path }) => path);
      survey.set(file.id, entry);
    } catch (error) {
      if (!(error instanceof RoadStoreError)) throw error;
    }
  }
  return survey;
}

const cycleThrough = (survey, id) => {
  const trail = [];
  const visit = (current) => {
    if (current === id && trail.length > 0) return [...trail];
    if (trail.includes(current)) return null;
    trail.push(current);
    for (const dependency of sortedCodePoints(survey.get(current)?.deps ?? [])) {
      const found = visit(dependency);
      if (found !== null) return found;
    }
    trail.pop();
    return null;
  };
  return visit(id);
};

const blockedShape = (id, role, blockers) => ({
  kind: 'road_details_blocked', packet_version: ROAD_DETAILS_SCHEMA, role, road: id, blockers,
});

function packetTokens(data) {
  const measured = { ...data, budget: { ...data.budget, packet_tokens: 0, max_tokens: null } };
  return estimateTokens(JSON.stringify(measured));
}

async function leaseOf({ repositoryRoot, workflowRoot, id, role, env, executors }) {
  const stored = (await readLease({ repositoryRoot, workflowRoot, kind: 'road', target: id }))?.lease ?? null;
  const resolved = role === 'worker' ? resolveHolder({ env, executors, role: 'worker' }) : null;
  const caller = resolved?.status === 'resolved' ? resolved.holder : null;
  if (stored === null) return { holder: null, caller, state: 'none' };
  const holder = stored.holder;
  if (role === 'worker' && caller === null) return { holder, caller, state: 'unknown' };
  if (role === 'worker' && caller !== holder) return { holder, caller, state: 'other' };
  const current = await computeSnapshot({ repositoryRoot, workflowRoot, projections: LEASE_CONTRACT_PROJECTION, target: { road: id } });
  return { holder, caller, state: checkLease({ lease: stored, current }).state === 'fresh' ? 'fresh' : 'stale' };
}

export async function buildRoadDetails(options) {
  const {
    repositoryRoot, workflowRoot, id, role = 'worker', includeReads = false, noIncludeReads = false, full = false, reuse = false, maxTokens = null,
    env = process.env, rootArgs = [],
  } = options;
  if (!isId(id)) throw new TypeError('id must be a valid ID');
  if (role !== 'worker' && role !== 'leader') throw new TypeError('role must be worker or leader');
  const base = { repositoryRoot, workflowRoot };
  const blockedOnly = (blockers, findings, snapshot = null) => ({
    status: 'blocked', data: blockedShape(id, role, blockers), findings, nextCommands: builder({ phase: 'blocked', rootArgs }), snapshot,
  });

  const files = (await listRoadFiles(base)).filter((file) => file.id === id);
  if (files.length === 0) return { problem: 'road_missing' };
  if (files.length > 1) {
    return blockedOnly([{ reason: 'road_ambiguous', subject: files.map(({ path }) => path).join(', ') }], [blockedFinding(id, 'road_ambiguous', {
      subject: files.map(({ path }) => path).join(', '), message: `Road ${id} exists in more than one file: ${files.map(({ path }) => path).join(', ')}.`,
    })]);
  }
  let found;
  try {
    found = await readRoadAt({ ...base, path: files[0].path, id });
  } catch (error) {
    if (!(error instanceof RoadStoreError)) throw error;
    return blockedOnly([{ reason: 'road_unverified', subject: files[0].path }], [blockedFinding(id, 'road_unverified', { subject: files[0].path, file: files[0].path, message: error.message })]);
  }
  const { road } = found;
  if (found.issues.length > 0) {
    return blockedOnly([{ reason: 'road_unverified', subject: found.path }], [blockedFinding(id, 'road_unverified', {
      subject: found.path, file: found.path, message: `${found.path} does not satisfy its closed schema: ${found.issues[0].path} ${found.issues[0].message}.`,
    })]);
  }

  const service = await createPathService(base);
  const executors = await readExecutors(base);
  const snapshotResult = await commandSnapshot('road-details', { ...base, target: { road: id } });
  const snapshot = snapshotResult.status === 'ok' ? snapshotResult.snapshot : null;
  const survey = await surveyRoads(base);
  const classProfile = road.executor_class === null ? null : resolveProfile(road.executor_class, executors.class_overrides);
  const findings = [];
  const blockers = [];
  const block = (reason, extra = {}) => {
    blockers.push({ reason, subject: extra.subject ?? null });
    findings.push(blockedFinding(id, reason, extra));
  };
  if (found.meta_state !== 'declared') block('road_unverified', { subject: found.path, file: found.path, message: `${found.path} no longer matches its recorded content hash: it was edited outside the CLI.` });
  if (snapshot === null) block('snapshot_unstable', { message: 'The workflow changed while the snapshot was read; ask again.' });
  if (executors.exists && executors.meta_state !== 'declared') block('executors_unusable', { subject: executors.path, file: executors.path, message: 'executors.json does not verify, so the class profile cannot be applied.' });

  // reads: declared order, each resolved against the repository now
  const windows = await projectReadWindows({ ...base, road, includeText: true });
  const texts = [];
  const reads = windows.map((window, index) => {
    const declared = road.reads[index];
    let { status } = window;
    let declaredBy = null;
    if (status === 'missing') {
      declaredBy = sortedCodePoints([...survey].filter(([other, entry]) => other !== id && entry.ephemerals.some((pattern) => pathOverlap(window.path, pattern) === 'overlap')).map(([other]) => other))[0] ?? null;
      if (declaredBy !== null) status = 'consumed';
    }
    const text = typeof window.text === 'string' ? window.text : null;
    texts.push(text);
    return {
      index, path: window.path, window: declared.lines === null ? null : { lines: [...declared.lines] }, kind: window.kind, status,
      bytes: text === null ? null : Buffer.byteLength(text, 'utf8'), line_count: window.line_count, why: window.why, declared_by: declaredBy, text: null,
    };
  });
  const readTokens = texts.reduce((sum, text) => sum + (text === null ? 0 : estimateTokens(text)), 0);

  // delivery: the class decides, the flags override, the Leader view points unless asked
  let deliveryReads;
  let deliveryReason;
  if (role === 'leader') {
    const inline = full || includeReads;
    deliveryReads = inline ? 'inlined' : 'pointers';
    deliveryReason = inline ? 'explicit_flag' : 'leader_view';
  } else if (includeReads || noIncludeReads) {
    deliveryReads = includeReads ? 'inlined' : 'pointers';
    deliveryReason = 'explicit_flag';
  } else if (road.executor_class === 'weak') {
    deliveryReads = 'inlined';
    deliveryReason = 'class_profile';
  } else if (road.executor_class === 'medium') {
    const within = readTokens <= classProfile.read_budget_tokens;
    deliveryReads = within ? 'inlined' : 'pointers';
    deliveryReason = within ? 'class_profile' : 'read_budget_exceeded';
  } else {
    deliveryReads = 'pointers';
    deliveryReason = 'class_profile';
  }
  const detailed = role === 'worker' || full;
  for (const [index, entry] of reads.entries()) {
    if (deliveryReads === 'inlined' && entry.status === 'ok' && texts[index] !== null) entry.text = texts[index];
    if (!detailed) entry.line_count = null;
  }

  const unresolved = [];
  for (const entry of reads) {
    if (RESOLVED_READ_STATUSES.includes(entry.status)) continue;
    unresolved.push({ index: entry.index, path: entry.path, window: entry.window, status: entry.status, declared_by: entry.declared_by });
    if (entry.status === 'consumed') {
      findings.push({
        code: ROAD_DETAILS_FINDING_CODES.consumed, severity: 'warning',
        message: `The declared read ${entry.path} is an ephemeral that ${entry.declared_by} already consumed; it is not missing.`, file: null, line: null,
        detail: { road: id, reason: 'consumed', index: entry.index, path: entry.path, declared_by: entry.declared_by },
      });
    } else {
      blockers.push({ reason: 'read_unresolved', subject: entry.path });
      findings.push(blockedFinding(id, 'read_unresolved', {
        subject: entry.path, index: entry.index, status: entry.status, message: `The declared read ${entry.path} is unresolved (${entry.status}).`,
      }));
    }
  }
  const resolvedCount = reads.length - unresolved.length;

  // dependencies
  const deps = road.deps.map((dependency) => {
    const entry = survey.get(dependency);
    let status = 'missing';
    if (entry !== undefined) status = entry.meta_state !== 'declared' ? 'unverified' : (DEPENDENCY_STATUSES.includes(entry.status) ? entry.status : 'unverified');
    return { id: dependency, status };
  });
  for (const dependency of deps) if (dependency.status === 'missing') block('dependency_missing', { subject: dependency.id, message: `The dependency ${dependency.id} does not exist.` });

  // task identity: the file's existence only
  let task = null;
  if (road.task !== null) {
    const resolved = await service.resolveWorkflowPath(taskPath(road.task));
    task = { id: road.task, path: inRepository(service.workflow_relative_path, taskPath(road.task)), exists: resolved.exists && resolved.case_matches };
  }

  const writes = [];
  for (const write of road.writes) {
    let exists = null;
    if (write.class !== 'glob') {
      try {
        const resolved = await service.resolveRepositoryPath(write.path);
        exists = resolved.exists;
      } catch {
        exists = null;
      }
    }
    writes.push({ path: write.path, class: write.class, action: write.action, exists });
  }

  const scope = await readScope({ ...base, road: id });
  const scopeRequests = scope.requests.map((request) => ({
    id: request.id, state: request.state, blocking: request.blocking, ts: request.ts, reason: request.reason,
    add_reads: request.add_reads, add_writes: request.add_writes,
    resolution: request.resolution === null ? null : { outcome: request.resolution.outcome, granted_by: request.resolution.granted_by, reason: request.resolution.reason ?? null },
  }));

  const collisions = projectCollisions({ id, writes: road.writes, reads: road.reads, survey });
  const relatedPaths = [...road.reads.map(({ path }) => patternOf(path)), ...road.writes.map(({ path, class: pathClass }) => patternOf(path, pathClass))];
  const readBytes = reads.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
  const data = {
    kind: 'road_details',
    packet_version: ROAD_DETAILS_SCHEMA,
    role,
    road: { id, plan: road.plan, task: road.task, status: road.status, contract: found.meta_state, executor_class: road.executor_class, path: found.path },
    task,
    reads,
    writes,
    forbidden: [...road.forbidden],
    deps,
    checks: road.checks.map((check) => ({ name: check.name, argv: [...check.argv], timeout_ms: check.timeout_ms })),
    acceptance: [...road.acceptance],
    boundaries: [...road.boundaries],
    steps: [...road.steps],
    reuse: reuse ? await scanReuse({ repositoryRoot, workflowRelative: service.workflow_relative_path, writes: road.writes }) : [],
    conventions: await projectConventions({ ...base, paths: relatedPaths }),
    collisions,
    recent: await projectRecent({ ...base, deps: road.deps, collidingRoads: [...new Set(collisions.map(({ road: other }) => other))] }),
    scope_requests: scopeRequests,
    delivery: { class: road.executor_class, reads: deliveryReads, reason: deliveryReason, read_budget_tokens: classProfile?.read_budget_tokens ?? null },
    lease: await leaseOf({ ...base, id, role, env, executors: executors.executors }),
    budget: { read_files: reads.filter((entry) => entry.bytes !== null).length, read_bytes: readBytes, estimated_tokens: readTokens, packet_tokens: 0, max_tokens: null },
    coverage: { declared: reads.length, resolved: resolvedCount, reads: `${resolvedCount}/${reads.length}`, unresolved },
  };

  if (role === 'leader') {
    const fitResult = road.executor_class === null ? { problem: 'class_missing' } : await roadFit({ ...base, id });
    const fit = fitResult.fit === undefined ? null : fitResult.fit;
    const readiness = [...blockers];
    for (const dependency of deps) if (dependency.status !== 'DONE' && dependency.status !== 'missing') readiness.push({ reason: 'dependency_not_done', subject: dependency.id });
    const cycle = cycleThrough(survey, id);
    if (cycle !== null) readiness.push({ reason: 'dependency_cycle', subject: [...cycle, id].join(' -> ') });
    if (road.executor_class === null) readiness.push({ reason: 'executor_class_missing', subject: null });
    if (fit !== null && fit.verdict !== 'fits') readiness.push({ reason: 'class_fit', subject: fit.verdict });
    if (road.executor_class !== null && !executors.executors.some((executor) => executor.role === 'worker' && executor.class === road.executor_class)) {
      readiness.push({ reason: 'no_executor_for_class', subject: road.executor_class });
    }
    data.readiness = { ready: readiness.length === 0, blockers: readiness };
    data.class_fit = fit === null ? null : { verdict: fit.verdict, class: fit.class, violations: fit.violations };
    data.needs_split = fit !== null && fit.verdict === 'split_required';
    const audited = await auditRoad({ ...base, road: id });
    data.audit = audited.audit === undefined
      ? { posture: null, status: 'unavailable', reason: audited.problem, counts: null }
      : { posture: audited.audit.posture, status: audited.audit.status, reason: audited.audit.reason, counts: audited.audit.counts };
    data.stale = stalePackets({ id, lease: data.lease });
    data.envelope = {
      policy: road.scope_policy === null ? null : { auto_reads: [...road.scope_policy.auto_reads], auto_writes: [...road.scope_policy.auto_writes] },
      grants: scope.records.filter(({ value }) => value.type === 'resolution' && value.granted_by === 'envelope').length,
      grant_cap: ENVELOPE_GRANT_CAP,
    };
  }

  data.budget.packet_tokens = packetTokens(data);
  if (maxTokens !== null && data.budget.packet_tokens > maxTokens) {
    const refused = {
      kind: 'road_details_refused', packet_version: ROAD_DETAILS_SCHEMA, role, road: id,
      budget: { ...data.budget, max_tokens: maxTokens }, refusal: { max_tokens: maxTokens, packet_tokens: data.budget.packet_tokens },
    };
    return {
      status: 'blocked', data: refused, snapshot,
      findings: [{
        code: ROAD_DETAILS_FINDING_CODES.refused, severity: 'error',
        message: `The complete ${role} packet for ${id} is about ${data.budget.packet_tokens} tokens, over --max-tokens ${maxTokens}; nothing was shortened.`, file: null, line: null,
        detail: { road: id, role, max_tokens: maxTokens, packet_tokens: data.budget.packet_tokens },
      }],
      nextCommands: builder({ phase: 'refused', id, role, rootArgs }),
    };
  }
  data.budget.max_tokens = maxTokens;

  const blocked = findings.some(({ code }) => code === ROAD_DETAILS_FINDING_CODES.blocked);
  const status = blocked ? 'blocked' : (findings.length > 0 ? 'warning' : 'ok');
  const pending = scopeRequests.some(({ state }) => state === 'pending');
  return {
    status, data, snapshot, findings,
    nextCommands: blocked ? builder({ phase: 'blocked', rootArgs }) : builder({ phase: 'ready', id, role, pending, rootArgs }),
  };
}

// The "fresh packet" builder: the complete packet for an agent that has to re-read after a stale snapshot.
export async function buildFreshRoadPacket(options) {
  const result = await buildRoadDetails(options);
  if (result.problem !== undefined) return result;
  return { status: result.status, data: result.data, findings: result.findings, snapshot: result.snapshot };
}

export { validateRoadDetails };
