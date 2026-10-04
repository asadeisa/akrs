// Scope request, approval and rejection: the flows behind `scope request|approve|reject`. A request grants nothing; an
// approval is a guarded Road update plus the resolution record in ONE transaction; a rejection only records why.
// Appends go through the transaction coordinator like every workflow mutation.
import { createDefaultProviders } from '../../core/providers.js';
import { isUlid, isId } from '../../schemas/common.js';
import { findingsForSchemaIssues } from '../../schemas/index.js';
import {
  SCOPE_REQUEST_SCHEMA, SCOPE_REQUEST_SPEC, SCOPE_RESOLUTION_SPEC, validateScopeRequest, validateScopeResolution,
} from '../../schemas/scope.js';
import { contentHash, decodeJsonl, encodeJsonlRecord } from '../canonical/index.js';
import { createPacket } from '../../core/packet.js';
import { inputRejection, resolveMissingDraft, runMutationFlow } from '../mutation-flow.js';
import { readAuthoringInput } from '../roads/input.js';
import { guardFinding, loadRoadForChange, proposeReplacement, sortedFindings, updateFormOf } from '../roads/update.js';
import { usageFinding } from '../roads/writers.js';
import { readOp } from '../journal/index.js';
import { commandSnapshot } from '../snapshots/index.js';
import { evaluateEnvelope, mergeScopeDelta } from './envelope.js';
import { SCOPE_NEXT_COMMAND_BUILDERS } from './next-commands.js';
import { readAllRequests, readScope, scopePath } from './repository.js';

const PREVIEW_ID = '00000000000000000000000000';
const PREVIEW_RESOLUTION_ID = '00000000000000000000000001';
const sortWrites = (writes) => [...writes].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

function appendOperation(scope, workflowPath, lines) {
  const content = lines.join('');
  return scope.exists ? { type: 'append', path: workflowPath, content } : { type: 'create', path: workflowPath, content };
}

function ledgerRejection(scope, road) {
  return {
    rejection: {
      kind: 'findings', reason: 'proposal_rejected',
      findings: [guardFinding({
        reason: 'ledger_unusable', subject: road, file: scope.path, message: `The scope ledger ${scope.path ?? scope.workflow_path} cannot take a record (${scope.problem}).`,
        actual: scope.problem,
      })],
    },
  };
}

const check = (value, schema) => {
  const verdict = schema(value);
  if (!verdict.ok) throw new TypeError(`rendered scope record is invalid: ${JSON.stringify(verdict.issues)}`);
};

function renderRequest({ id, ts, document, snapshot }) {
  const record = {
    id, ts, type: 'request', road: document.road, snapshot,
    add_reads: document.add_reads.map((entry) => structuredClone(entry)), add_writes: sortWrites(document.add_writes.map((entry) => structuredClone(entry))),
    reason: document.reason, blocking: document.blocking,
  };
  const line = encodeJsonlRecord(record, SCOPE_REQUEST_SPEC);
  const decoded = decodeJsonl(line, () => SCOPE_REQUEST_SPEC).records[0].value;
  check(decoded, (value) => validateScopeRequest(value, { form: 'stored' }));
  return { line, record: decoded };
}

function renderResolution({ id, ts, request, outcome, grantedBy, reason, roadHash }) {
  const record = {
    id, ts, type: 'resolution', request, outcome, granted_by: grantedBy, reason, road_snapshot_after: roadHash, operation: null,
  };
  const line = encodeJsonlRecord(record, SCOPE_RESOLUTION_SPEC);
  const decoded = decodeJsonl(line, () => SCOPE_RESOLUTION_SPEC).records[0].value;
  check(decoded, (value) => validateScopeResolution(value, { form: 'stored' }));
  return { line, record: decoded };
}

// ---- scope request -----------------------------------------------------------------------------------------------
// options: { repositoryRoot, workflowRoot, channel, requestId?, dryRun?, expectedSnapshot?, providers?, knownCommands, rootArgs?, ... }
export async function requestScope(options) {
  const {
    repositoryRoot, workflowRoot, channel, requestId, dryRun = false, expectedSnapshot, providers = createDefaultProviders(),
    knownCommands, boundary, lockOptions, rootArgs = [],
  } = options;
  const root = options.root ?? repositoryRoot;
  const command = 'scope-request';
  const builder = SCOPE_NEXT_COMMAND_BUILDERS[command];
  const flowBase = { command, repositoryRoot, workflowRoot, root, providers, knownCommands };
  const retry = (file) => () => builder({ phase: 'rejected', file: file ?? null, rootArgs });

  const input = await readAuthoringInput({ repositoryRoot, workflowRoot, channel });
  if (!input.ok) {
    if (input.missing && input.draft !== null && !dryRun) {
      const replay = await resolveMissingDraft({
        ...flowBase, input, requestId,
        snapshotFor: async (record) => {
          const road = record.packet?.data?.request?.road;
          return isId(road) ? (await commandSnapshot(command, { repositoryRoot, workflowRoot, target: { road } })).snapshot : null;
        },
      });
      if (replay !== null) return { outcome: 'replayed', packet: replay };
    }
    return inputRejection({ ...flowBase, schema: SCOPE_REQUEST_SCHEMA, input, next: retry(null)(), requestId });
  }
  const { document } = input;
  const issues = validateScopeRequest(document, { form: 'input' }).issues;
  if (issues.length > 0) {
    return {
      outcome: 'rejected',
      packet: createPacket({
        command, requestId: null, status: 'error', root, snapshot: { before: null, after: null },
        data: { kind: 'usage', reason: 'invalid_input', schema: SCOPE_REQUEST_SCHEMA, missing_inputs: [] },
        findings: findingsForSchemaIssues(SCOPE_REQUEST_SCHEMA, issues, { file: input.file }),
        nextCommands: retry(input.file)(), providers, knownCommands,
      }),
    };
  }

  const render = async (context) => {
    const loaded = await loadRoadForChange({ repositoryRoot, workflowRoot, id: document.road, file: input.file });
    if (loaded.findings !== undefined) return { rejection: { kind: 'findings', reason: 'proposal_rejected', findings: loaded.findings } };
    const { found } = loaded;
    const scope = await readScope({ repositoryRoot, workflowRoot, road: document.road });
    if (scope.problem !== null) return ledgerRejection(scope, document.road);
    const current = updateFormOf(found.road);
    const merged = mergeScopeDelta(current, document);
    if (merged.added === 0) {
      return {
        rejection: {
          kind: 'findings', reason: 'proposal_rejected',
          findings: [guardFinding({ reason: 'nothing_to_add', subject: document.road, file: input.file, message: 'The Road already declares every read and write that was asked for.' })],
        },
      };
    }
    const id = context.preview ? PREVIEW_ID : providers.runId();
    const ts = providers.now();
    const requestRecord = renderRequest({ id, ts, document, snapshot: context.current_snapshot });
    const workflowPath = scopePath(document.road);
    const data = {
      kind: 'scope_request',
      dry_run: false,
      request: { id: context.preview ? null : id, road: document.road, blocking: document.blocking, state: 'pending', path: scope.path ?? workflowPath, hash: context.preview ? null : requestRecord.record.hash },
      envelope: { granted: false, reasons: [] },
    };

    const grants = scope.records.filter(({ value }) => value.type === 'resolution' && value.granted_by === 'envelope').length;
    const verdict = evaluateEnvelope({ road: found.road, request: document, grants });
    if (verdict.eligible) {
      const replacement = await proposeReplacement({
        repositoryRoot, workflowRoot, current: found, document: merged.document, reasonGiven: true, removals: [], file: input.file,
      });
      if (replacement.ok) {
        const resolution = renderResolution({
          id: context.preview ? PREVIEW_RESOLUTION_ID : providers.runId(), ts, request: id, outcome: 'approved', grantedBy: 'envelope',
          reason: null, roadHash: contentHash(replacement.text),
        });
        return {
          operations: [
            { type: 'replace', path: replacement.workflowPath, content: replacement.text },
            appendOperation(scope, workflowPath, [requestRecord.line, resolution.line]),
          ],
          status: 'ok',
          data: {
            ...data,
            request: { ...data.request, state: 'approved' },
            envelope: { granted: true, reasons: [] },
            resolution: { id: context.preview ? null : resolution.record.id, outcome: 'approved', granted_by: 'envelope', road_snapshot_after: resolution.record.road_snapshot_after },
            diff: replacement.diff,
            budget: replacement.budget,
          },
          nextCommands: builder({ phase: 'granted', rootArgs }),
          proposed: { request: requestRecord.record, resolution: resolution.record, road: replacement.stored },
        };
      }
      verdict.eligible = false;
      verdict.reasons = ['refused_by_guard'];
    }
    return {
      operations: [appendOperation(scope, workflowPath, [requestRecord.line])],
      // (decision) a committed packet is ok or warning (a blocked packet is a refusal that wrote nothing), so a blocking
      // request is a `warning` whose data tells the Worker to stop.
      status: document.blocking ? 'warning' : 'ok',
      data: { ...data, worker: document.blocking ? 'stop' : 'continue', envelope: { granted: false, reasons: verdict.reasons } },
      nextCommands: builder({ phase: 'requested', road: document.road, rootArgs }),
      proposed: { request: requestRecord.record },
    };
  };

  return runMutationFlow({
    ...flowBase,
    snapshotTarget: { road: document.road },
    requestInput: document,
    requestId,
    dryRun,
    expectedSnapshot,
    schema: SCOPE_REQUEST_SCHEMA,
    input,
    channel,
    boundary,
    lockOptions,
    retryCommands: retry(input.file),
    render,
  });
}

// ---- approve / reject --------------------------------------------------------------------------------------------
const targetFinding = (reason, target, message, extra = {}) => guardFinding({ reason, subject: target, message, ...extra });

// target -> { request } or { findings }: a request ID, or a Road ID with exactly one pending request.
export function chooseRequest(requests, target) {
  if (isUlid(target)) {
    const request = requests.find(({ id }) => id === target);
    if (request === undefined) return { findings: [targetFinding('request_missing', target, `No scope request ${target} exists.`)] };
    if (request.state !== 'pending') return { findings: [targetFinding('request_resolved', target, `The scope request ${target} is already ${request.state}.`, { actual: request.state })] };
    return { request };
  }
  const pending = requests.filter(({ road, state }) => road === target && state === 'pending');
  if (pending.length === 0) return { findings: [targetFinding('no_pending', target, `The Road ${target} has no pending scope request.`)] };
  if (pending.length > 1) {
    return {
      findings: [targetFinding('request_ambiguous', target, `The Road ${target} has ${pending.length} pending scope requests; name one: ${pending.map(({ id }) => id).join(', ')}.`, { actual: pending.map(({ id }) => id).join(',') })],
    };
  }
  return { request: pending[0] };
}

// options: { repositoryRoot, workflowRoot, mode: 'approve' | 'reject', target, reason?, requestId?, dryRun?, expectedSnapshot?, ... }
export async function resolveScope(options) {
  const {
    repositoryRoot, workflowRoot, mode, target, reason = null, requestId, dryRun = false, expectedSnapshot,
    providers = createDefaultProviders(), knownCommands, boundary, lockOptions, rootArgs = [],
  } = options;
  const root = options.root ?? repositoryRoot;
  const command = `scope-${mode}`;
  const builder = SCOPE_NEXT_COMMAND_BUILDERS[command];
  const flowBase = { command, repositoryRoot, workflowRoot, root, providers, knownCommands };
  const retry = () => builder({ phase: 'rejected', rootArgs });
  const refuse = (findings, kind = 'findings') => ({
    outcome: 'rejected',
    packet: createPacket({
      command, requestId: null, status: 'error', root, snapshot: { before: null, after: null },
      data: { kind, reason: kind === 'usage' ? 'invalid_input' : 'proposal_rejected', schema: SCOPE_REQUEST_SCHEMA, missing_inputs: [] },
      findings, nextCommands: retry(), providers, knownCommands,
    }),
  });
  if (mode === 'reject' && (typeof reason !== 'string' || reason.trim() === '')) {
    return refuse([usageFinding('scope reject needs --reason: a rejection states why')], 'usage');
  }

  // the Road is needed before the lock (the snapshot is Road-scoped), so look the request up once without it
  const peek = chooseRequest((await readAllRequests({ repositoryRoot, workflowRoot })).requests, target);
  let roadId;
  if (peek.findings === undefined) {
    roadId = peek.request.road;
  } else {
    // A retry of an operation that already committed (a crash after the commit, a lost reply) finds nothing pending any
    // more. With the same request ID the journal decides: it replays the recorded packet or reports the conflict.
    const prior = requestId !== undefined && isUlid(requestId) ? await readOp({ repositoryRoot, workflowRoot, requestId }) : null;
    const priorRoad = prior?.committed?.command === command ? prior.committed.target?.road : null;
    if (!isId(priorRoad)) return refuse(sortedFindings(peek.findings));
    roadId = priorRoad;
  }

  const render = async (context) => {
    const all = await readAllRequests({ repositoryRoot, workflowRoot, road: roadId });
    const chosen = chooseRequest(all.requests, isUlid(target) ? target : roadId);
    if (chosen.findings !== undefined) return { rejection: { kind: 'findings', reason: 'proposal_rejected', findings: sortedFindings(chosen.findings) } };
    const { request } = chosen;
    const scope = await readScope({ repositoryRoot, workflowRoot, road: roadId });
    if (scope.problem !== null) return ledgerRejection(scope, roadId);
    const ts = providers.now();
    const workflowPath = scopePath(roadId);
    const resolutionId = context.preview ? PREVIEW_RESOLUTION_ID : providers.runId();
    const summary = { id: request.id, road: roadId, state: mode === 'approve' ? 'approved' : 'rejected', path: scope.path };

    if (mode === 'reject') {
      const resolution = renderResolution({
        id: resolutionId, ts, request: request.id, outcome: 'rejected', grantedBy: 'leader', reason, roadHash: null,
      });
      return {
        operations: [appendOperation(scope, workflowPath, [resolution.line])],
        data: { kind: 'scope_reject', dry_run: false, request: summary, resolution: { id: context.preview ? null : resolutionId, outcome: 'rejected', granted_by: 'leader', reason } },
        nextCommands: builder({ phase: 'resolved', rootArgs }),
        proposed: { resolution: resolution.record },
      };
    }

    const loaded = await loadRoadForChange({ repositoryRoot, workflowRoot, id: roadId });
    if (loaded.findings !== undefined) return { rejection: { kind: 'findings', reason: 'proposal_rejected', findings: loaded.findings } };
    const { found } = loaded;
    const merged = mergeScopeDelta(updateFormOf(found.road), request);
    if (merged.added === 0) {
      return {
        rejection: {
          kind: 'findings', reason: 'proposal_rejected',
          findings: [guardFinding({ reason: 'nothing_to_add', subject: roadId, message: 'The Road already declares every read and write that was asked for.' })],
        },
      };
    }
    const replacement = await proposeReplacement({
      repositoryRoot, workflowRoot, current: found, document: merged.document, reasonGiven: true, removals: [],
    });
    if (!replacement.ok) return { rejection: { kind: replacement.kind, reason: replacement.reason, findings: replacement.findings } };
    const resolution = renderResolution({
      id: resolutionId, ts, request: request.id, outcome: 'approved', grantedBy: 'leader', reason: reason ?? null, roadHash: contentHash(replacement.text),
    });
    return {
      operations: [
        { type: 'replace', path: replacement.workflowPath, content: replacement.text },
        appendOperation(scope, workflowPath, [resolution.line]),
      ],
      data: {
        kind: 'scope_approve',
        dry_run: false,
        request: summary,
        resolution: { id: context.preview ? null : resolutionId, outcome: 'approved', granted_by: 'leader', reason: reason ?? null, road_snapshot_after: resolution.record.road_snapshot_after },
        road: { id: roadId, path: found.path },
        diff: replacement.diff,
        relations: replacement.relations,
        budget: replacement.budget,
      },
      nextCommands: builder({ phase: 'resolved', rootArgs }),
      proposed: { resolution: resolution.record, road: replacement.stored },
    };
  };

  return runMutationFlow({
    ...flowBase,
    target: { road: roadId, plan: null },
    snapshotTarget: { road: roadId },
    requestInput: { target, reason },
    requestId,
    dryRun,
    expectedSnapshot,
    schema: SCOPE_REQUEST_SCHEMA,
    boundary,
    lockOptions,
    retryCommands: retry,
    render,
  });
}
