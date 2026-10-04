// Road update: the one validation and write path behind `road update` (full replacement and --patch) and the Road
// half of `scope approve` and of an envelope grant. `proposeReplacement` judges a complete update-form document
// against the CURRENT Road and the rest of the workflow; `updateRoad` is the command flow around it.
import { createPacket } from '../../core/packet.js';
import { compareStrings } from '../../schemas/common.js';
import { compareFindings, validateFinding } from '../../schemas/finding.js';
import { findingsForSchemaIssues } from '../../schemas/index.js';
import { pathOverlap } from '../../schemas/glob.js';
import { ROAD_SCHEMA, ROAD_SPEC, validateRoad } from '../../schemas/road.js';
import { analyzeDependencyCycles } from '../../validation/graph.js';
import { classFitCheck } from '../executors/check.js';
import { canonicalizeJson, storedSpec, withMeta, parseStrictJson } from '../canonical/index.js';
import { runMutationFlow, inputRejection, resolveMissingDraft } from '../mutation-flow.js';
import { createPathService } from '../path-service.js';
import { CHANGE_FINDING_CODE } from '../scope/policy.js';
import { readScope } from '../scope/repository.js';
import { commandSnapshot } from '../snapshots/index.js';
import { readAuthoringInput } from './input.js';
import { SCOPE_NEXT_COMMAND_BUILDERS } from '../scope/next-commands.js';
import { applyPatch, removalsBetween, validatePatchDocument } from './patch.js';
import { GENERATOR } from './policy.js';
import { declaredPathFindings, readWindowFindings } from './proposal.js';
import { RoadStoreError, listRoadFiles, readRoad, readRoadGraph, renderRoad, workflowOption } from './repository.js';
import { usageFinding } from './writers.js';
import { projectReadWindows } from './read-windows.js';
import { channelFindings } from './proposal.js';

const COMMAND = 'road-update';
const sorted = (findings) => {
  for (const entry of findings) {
    const verdict = validateFinding(entry);
    if (!verdict.ok) throw new TypeError(`change finding is invalid: ${JSON.stringify(verdict.issues)}`);
  }
  return [...findings].sort(compareFindings);
};

// The refusal of a guard: AKRS-R014 with a closed detail shape.
export function guardFinding({ reason, subject, message, pointer = null, expected = null, actual = null, file = null }) {
  return {
    code: CHANGE_FINDING_CODE,
    severity: 'error',
    message,
    file,
    line: null,
    detail: { reason, subject, pointer, expected, actual },
  };
}
export const sortedFindings = sorted;

// The update form of a stored Road: everything except the CLI-owned `meta`.
export function updateFormOf(stored) {
  const { meta: _meta, ...rest } = stored;
  return structuredClone(rest);
}

// update-form document -> stored object (status preserved, `meta` stamped).
export function buildUpdatedRoad(document, { generator = GENERATOR, workflowRoot } = {}) {
  const verdict = validateRoad(document, { form: 'update', ...(workflowRoot === undefined ? {} : { workflowRoot }) });
  if (!verdict.ok) throw new TypeError(`Road update is invalid: ${verdict.issues.map(({ path, message }) => `${path} ${message}`).join('; ')}`);
  const ordered = Object.fromEntries(ROAD_SPEC.keys.map((key) => [key, document[key]]));
  const stamped = withMeta(ordered, { schema: document.schema, generator, spec: ROAD_SPEC });
  return parseStrictJson(canonicalizeJson(stamped, storedSpec(ROAD_SPEC))).value;
}

const writePatterns = (writes) => writes.flatMap(({ path, class: pathClass }) => {
  if (pathClass === 'dir') return [{ path, pattern: `${path}/**` }];
  if (pathClass === 'ephemeral') return [{ path, pattern: path }, { path, pattern: `${path}/**` }];
  return [{ path, pattern: path }];
});

function collisionsOf(writes, others) {
  const found = new Map();
  for (const other of others) {
    for (const mine of writePatterns(writes)) {
      for (const theirs of writePatterns(other.writes)) {
        if (pathOverlap(mine.pattern, theirs.pattern) === 'disjoint') continue;
        const key = `${other.id}|${mine.path}|${theirs.path}`;
        if (!found.has(key)) found.set(key, { other: other.id, mine: mine.path, theirs: theirs.path });
      }
    }
  }
  return found;
}

async function otherActiveRoads({ repositoryRoot, workflowRoot, excludeId }) {
  const roads = [];
  for (const { id } of await listRoadFiles({ repositoryRoot, workflowRoot })) {
    if (id === excludeId) continue;
    try {
      const found = await readRoad({ repositoryRoot, workflowRoot, id });
      if (found !== null && found.road.status === 'ACTIVE' && Array.isArray(found.road.writes)) roads.push({ id, writes: found.road.writes });
    } catch (error) {
      if (!(error instanceof RoadStoreError)) throw error;
    }
  }
  return roads;
}

const FIELDS = ROAD_SPEC.keys;
function diffOf(before, after) {
  return FIELDS.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .map((field) => ({ field, before: before[field] ?? null, after: after[field] ?? null }));
}

// Judge a complete update-form `document` against the current Road. `current` is { road, path, meta_state }.
// removals: [{ kind, key }] the update performs; `reasonGiven` says every removal carries a reason.
// Returns { ok: false, kind, reason, findings } or { ok: true, stored, text, workflowPath, path, diff, relations, budget, warnings }.
export async function proposeReplacement({ repositoryRoot, workflowRoot, current, document, reasonGiven, removals, file = null }) {
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const relative = service.workflow_relative_path;
  const options = workflowOption(service);
  const id = current.road.id;
  const schemaIssues = validateRoad(document, { form: 'update', ...options }).issues;
  if (schemaIssues.length > 0) {
    return { ok: false, kind: 'findings', reason: 'proposal_rejected', findings: sorted(findingsForSchemaIssues(ROAD_SCHEMA, schemaIssues, { file })) };
  }
  const findings = [];
  const guard = (args) => findings.push(guardFinding({ ...args, file }));
  if (document.id !== id) guard({ reason: 'id_changed', subject: id, pointer: '/id', expected: id, actual: document.id, message: `The Road ID cannot change (it is ${id}); relocation is road move (at /id).` });
  if (document.status !== current.road.status) {
    guard({ reason: 'status_changed', subject: id, pointer: '/status', expected: current.road.status, actual: document.status, message: `The status cannot change through an update (it is ${current.road.status}); lifecycle commands own it (at /status).` });
  }
  if (document.plan !== current.road.plan) {
    guard({ reason: 'plan_changed', subject: id, pointer: '/plan', expected: current.road.plan, actual: document.plan, message: 'The Plan cannot change through an update; use road move (at /plan).' });
  }
  if (!reasonGiven) {
    for (const removal of removals) {
      guard({ reason: 'removal_reason_missing', subject: removal.key, pointer: `/${removal.kind}s`, message: `Removing the ${removal.kind} ${removal.key} needs a reason (--reason).` });
    }
  }

  // dependencies and cycles through the replaced node
  const graph = await readRoadGraph({ repositoryRoot, workflowRoot });
  const known = new Set(graph.nodes.map((node) => node.id));
  document.deps.forEach((dependency, index) => {
    if (known.has(dependency)) return;
    findings.push({
      code: 'AKRS-R005', severity: 'error', message: `Road dependency "${dependency}" does not exist (at /deps/${index}).`, file, line: null,
      detail: { road_id: id, dependency, status: current.road.status },
    });
  });
  const roads = graph.nodes.filter((node) => node.id !== id)
    .map((node) => ({ id: node.id, file: node.path, line: null, deps: node.deps, status: null }));
  roads.push({ id, file: current.path, line: null, deps: [...document.deps], status: current.road.status });
  for (const cycle of analyzeDependencyCycles(roads, new Map(roads.map((road) => [road.id, road]))).findings) {
    if (!cycle.detail.cycle.includes(id)) continue;
    findings.push({
      code: 'AKRS-R006', severity: 'error', message: `Road dependency cycle: ${cycle.detail.cycle.join(' -> ')} (at /deps).`, file, line: null,
      detail: { cycle: cycle.detail.cycle },
    });
  }
  findings.push(...await declaredPathFindings(service, document, file));
  findings.push(...await readWindowFindings({ repositoryRoot, workflowRoot }, document, file));

  // write collisions this update introduces with other ACTIVE Roads
  const others = await otherActiveRoads({ repositoryRoot, workflowRoot, excludeId: id });
  const before = collisionsOf(current.road.writes, others);
  for (const [key, hit] of collisionsOf(document.writes, others)) {
    if (before.has(key)) continue;
    const index = document.writes.findIndex(({ path }) => path === hit.mine);
    guard({
      reason: 'write_collision', subject: hit.other, pointer: `/writes/${index}/path`, expected: hit.theirs, actual: hit.mine,
      message: `The write ${hit.mine} collides with ${hit.theirs} of the ACTIVE Road ${hit.other} (at /writes/${index}/path).`,
    });
  }
  // Class limits (P1-W15): reported, never blocking, except an oversize_reason the Leader class may not use.
  const classCheck = await classFitCheck({ repositoryRoot, workflowRoot, document, file });
  if (classCheck.refusal !== null) findings.push(classCheck.refusal);
  if (findings.length > 0) return { ok: false, kind: 'findings', reason: 'proposal_rejected', findings: sorted(findings) };

  const stored = buildUpdatedRoad(document, options);
  const text = renderRoad(stored, options);
  const unchanged = renderRoad(current.road, options);
  if (text === unchanged) {
    return {
      ok: false, kind: 'findings', reason: 'proposal_rejected',
      findings: [guardFinding({ reason: 'no_change', subject: id, message: `The proposed Road is identical to the stored one; nothing would change.`, file })],
    };
  }
  const windows = await projectReadWindows({ repositoryRoot, workflowRoot, road: document });
  const scope = await readScope({ repositoryRoot, workflowRoot, road: id });
  const prefix = relative === '' ? '' : `${relative}/`;
  return {
    ok: true,
    stored,
    text,
    path: current.path,
    workflowPath: current.path.slice(prefix.length),
    diff: diffOf(current.road, stored),
    relations: {
      dependencies: [...document.deps].sort(compareStrings),
      dependents: graph.nodes.filter((node) => node.deps.includes(id)).map((node) => node.id).sort(compareStrings),
      task: document.task,
      pending_scope_requests: scope.requests.filter(({ state }) => state === 'pending').length,
    },
    budget: {
      reads: document.reads.length,
      read_lines: windows.reduce((sum, window) => sum + (window.lines === null ? (window.line_count ?? 0) : window.lines[1] - window.lines[0] + 1), 0),
      writes: document.writes.length,
      checks: document.checks.length,
      steps: document.steps.length,
    },
    warnings: classCheck.findings,
  };
}

const roadRef = (found, status) => ({ id: found.road.id, path: found.path, status, meta_state: found.meta_state });

// Reads the Road for a change: { found } or { findings } (road_missing | road_unverified).
export async function loadRoadForChange({ repositoryRoot, workflowRoot, id, file = null, allowActive = true }) {
  let found;
  try {
    found = await readRoad({ repositoryRoot, workflowRoot, id });
  } catch (error) {
    if (!(error instanceof RoadStoreError)) throw error;
    return { findings: [guardFinding({ reason: 'road_unverified', subject: id, message: `The Road ${id} cannot be read (${error.message}).`, file })] };
  }
  if (found === null) return { findings: [guardFinding({ reason: 'road_missing', subject: id, message: `No Road ${id} exists.`, file })] };
  if (found.meta_state !== 'declared') {
    return { findings: [guardFinding({ reason: 'road_unverified', subject: id, message: `The Road ${found.path} does not verify (hand-edited or invalid), so it is not changed.`, file: found.path })] };
  }
  if (found.road.status === 'DONE') return { findings: [guardFinding({ reason: 'road_done', subject: id, message: `The Road ${id} is DONE; reopen it before changing it.`, file: found.path })] };
  if (!allowActive && found.road.status === 'ACTIVE') {
    return { findings: [guardFinding({ reason: 'road_active', subject: id, message: `The Road ${id} is ACTIVE and may be held by a Worker.`, file: found.path })] };
  }
  return { found };
}

// options: { repositoryRoot, workflowRoot, id, channel, patch?, reason?, requestId?, dryRun?, expectedSnapshot?, providers?,
//   knownCommands, rootArgs?, root?, boundary?, lockOptions? }
export async function updateRoad(options) {
  const {
    repositoryRoot, workflowRoot, id, channel, patch = false, reason = null, requestId, dryRun = false, expectedSnapshot,
    providers, knownCommands, boundary, lockOptions, rootArgs = [],
  } = options;
  const root = options.root ?? repositoryRoot;
  const builder = SCOPE_NEXT_COMMAND_BUILDERS[COMMAND];
  const target = { road: id, plan: null };
  const retry = (file) => () => builder({ phase: 'rejected', id, file: file ?? null, patch, rootArgs });
  const schemaName = patch ? 'akrs.road-patch/v1' : ROAD_SCHEMA;
  const flowBase = { command: COMMAND, repositoryRoot, workflowRoot, root, providers, knownCommands };

  const input = await readAuthoringInput({ repositoryRoot, workflowRoot, channel });
  if (!input.ok) {
    if (input.missing && input.draft !== null && !dryRun) {
      const replay = await resolveMissingDraft({
        ...flowBase, target, input, requestId,
        snapshotFor: async () => (await commandSnapshot(COMMAND, { repositoryRoot, workflowRoot, target })).snapshot,
      });
      if (replay !== null) return { outcome: 'replayed', packet: replay };
    }
    return inputRejection({ ...flowBase, schema: schemaName, input, next: retry(null)(), requestId });
  }
  const { document } = input;
  const usage = (issues, message) => ({
    outcome: 'rejected',
    packet: usagePacketOf({ ...flowBase, schema: schemaName, findings: issues, message, next: retry(input.file)(), file: input.file }),
  });

  let patchIssues = [];
  if (patch) patchIssues = validatePatchDocument(document);
  else {
    const service = await createPathService({ repositoryRoot, workflowRoot });
    patchIssues = validateRoad(document, { form: 'update', ...workflowOption(service) }).issues;
  }
  if (patchIssues.length > 0) {
    const findings = patch
      ? channelFindings(schemaName, patchIssues, input.file)
      : findingsForSchemaIssues(ROAD_SCHEMA, patchIssues, { file: input.file });
    return usage(findings);
  }
  if (!patch && !dryRun && expectedSnapshot === undefined) {
    return usage([usageFinding('road update replaces the whole Road, so it needs --if-snapshot <snapshot> (the snapshot the Road had when you read it); use --patch to change single entries without one')]);
  }

  const render = async () => {
    const loaded = await loadRoadForChange({ repositoryRoot, workflowRoot, id, file: input.file });
    if (loaded.findings !== undefined) return { rejection: { kind: 'findings', reason: 'proposal_rejected', findings: loaded.findings } };
    const { found } = loaded;
    let proposed = document;
    let removals;
    let reasonGiven;
    if (patch) {
      const applied = applyPatch(updateFormOf(found.road), document.ops);
      if (applied.problems.length > 0) {
        return {
          rejection: {
            kind: 'findings', reason: 'proposal_rejected',
            findings: sorted(applied.problems.map((problem) => guardFinding({ ...problem, file: input.file }))),
          },
        };
      }
      proposed = applied.document;
      removals = applied.removals;
      reasonGiven = true;
    } else {
      removals = removalsBetween(found.road, document);
      reasonGiven = typeof reason === 'string' && reason.trim() !== '';
    }
    const check = await proposeReplacement({ repositoryRoot, workflowRoot, current: found, document: proposed, reasonGiven, removals, file: input.file });
    if (!check.ok) return { rejection: { kind: check.kind, reason: check.reason, findings: check.findings } };
    return {
      operations: [{ type: 'replace', path: check.workflowPath, content: check.text }],
      data: {
        kind: 'road_update',
        dry_run: false,
        road: roadRef(found, check.stored.status),
        diff: check.diff,
        relations: check.relations,
        budget: check.budget,
      },
      findings: check.warnings,
      nextCommands: builder({ phase: 'updated', rootArgs }),
      proposed: check.stored,
    };
  };

  const result = await runMutationFlow({
    ...flowBase,
    target,
    snapshotTarget: { road: id },
    requestInput: { id, mode: patch ? 'patch' : 'full', document, reason: patch ? null : reason },
    requestId,
    dryRun,
    expectedSnapshot,
    schema: schemaName,
    input,
    channel,
    boundary,
    lockOptions,
    retryCommands: retry(input.file),
    render,
  });
  return result;
}

// A usage-error packet for the updater (document or flag problems found before the lock).
function usagePacketOf({ command, root, providers, knownCommands, schema, findings, message, next }) {
  return createPacket({
    command,
    requestId: null,
    status: 'error',
    root,
    snapshot: { before: null, after: null },
    data: { kind: 'usage', reason: 'invalid_input', schema, missing_inputs: [], ...(message === undefined ? {} : { message }) },
    findings,
    nextCommands: next,
    providers,
    knownCommands,
  });
}
