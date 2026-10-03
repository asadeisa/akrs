// Road and Task writers: the one flow behind `road new` and `task new`. Read the input channel, judge the document
// against the closed schema (usage errors), then hand the complete proposed change set to the transaction
// coordinator, which re-judges it against the workflow under the repository lock (findings), writes it atomically
// together with the draft deletion, journals it, and replays an identical retry as a noop.
import { createPacket } from '../../core/packet.js';
import { createDefaultProviders } from '../../core/providers.js';
import { compareStrings, isId, isUlid } from '../../schemas/common.js';
import { validatePacket } from '../../schemas/packet.js';
import { ROAD_SCHEMA, TASK_SCHEMA } from '../../schemas/road.js';
import { buildReplayPacket, readOp, resolveFromJournal } from '../journal/index.js';
import { commandSnapshot } from '../snapshots/index.js';
import { createPathService } from '../path-service.js';
import { runTransactionalMutation } from '../transactions/index.js';
import { readAuthoringInput } from './input.js';
import { AUTHORING_NEXT_COMMAND_BUILDERS } from './next-commands.js';
import { draftPath } from './paths.js';
import {
  channelFindings, validateRoadDocument, validateRoadProposal, validateTaskDocument, validateTaskProposal,
} from './proposal.js';

const NO_TARGET = Object.freeze({ road: null, plan: null });

const KINDS = Object.freeze({
  road: {
    command: 'road-new',
    schema: ROAD_SCHEMA,
    template: 'road',
    document: (document, context) => validateRoadDocument(document, context),
    proposal: validateRoadProposal,
    snapshot: (options) => commandSnapshot('road-new', options),
    data: (check, draft) => ({
      kind: 'road_new',
      dry_run: false,
      road: {
        id: check.stored.id, plan: check.stored.plan, task: check.stored.task, status: check.stored.status, path: check.path, meta_state: 'declared',
      },
      draft,
    }),
    proposed: (check) => check.stored,
    created: (check) => ({ task: check.stored.task }),
  },
  task: {
    command: 'task-new',
    schema: TASK_SCHEMA,
    template: 'task',
    document: (document, context) => validateTaskDocument(document, context),
    proposal: validateTaskProposal,
    snapshot: (options, document) => commandSnapshot('task-new', { ...options, target: { road: document.road } }),
    data: (check, draft) => ({
      kind: 'task_new',
      dry_run: false,
      task: {
        id: check.document.id, plan: check.document.plan, road: check.document.road, path: check.path, meta_state: 'declared',
      },
      draft,
    }),
    proposed: (check) => check.text,
    created: () => ({ task: null }),
  },
});

const sameBytes = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;

export function usageFinding(message, detail = { reason: message }) {
  return { code: 'AKRS-C001', severity: 'error', message, file: null, line: null, detail };
}

export async function runAuthoring(kind, options) {
  if (options === null || typeof options !== 'object') throw new TypeError('options are required');
  const spec = KINDS[kind];
  const {
    repositoryRoot, workflowRoot, channel, requestId, dryRun = false, expectedSnapshot, providers = createDefaultProviders(),
    knownCommands, boundary, lockOptions, hooks = {}, rootArgs = [],
  } = options;
  if (channel === null || typeof channel !== 'object') throw new TypeError('channel is required');
  const root = options.root ?? repositoryRoot;
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const workflowRelative = service.workflow_relative_path;
  const snapshotOptions = { repositoryRoot, workflowRoot };
  const suppliedId = requestId !== undefined && isUlid(requestId) ? requestId : null;

  const builder = AUTHORING_NEXT_COMMAND_BUILDERS[spec.command];
  const retryCommands = (file) => builder({ phase: 'rejected', template: spec.template, file, rootArgs });
  const createdCommands = (check) => builder({ phase: 'created', rootArgs, ...spec.created(check) });
  const packetOf = ({ status, data, findings, next, snapshot = null, id = suppliedId }) => createPacket({
    command: spec.command,
    requestId: id,
    status,
    root,
    snapshot: { before: snapshot, after: snapshot },
    data,
    findings,
    nextCommands: next,
    providers,
    knownCommands,
  });
  const rejected = (packet) => ({ outcome: 'rejected', packet });

  if (requestId !== undefined && !isUlid(requestId)) {
    return rejected(packetOf({
      status: 'error',
      data: { kind: 'usage', reason: 'invalid_request_id' },
      findings: [usageFinding('request_id must be a 26-character ULID')],
      next: [],
      id: null,
    }));
  }

  // ---- the input channel ---------------------------------------------------------------------------------------
  const input = await readAuthoringInput({ repositoryRoot, workflowRoot, channel });
  await hooks.afterInputRead?.(input);
  if (!input.ok) {
    if (input.missing && input.draft !== null && !dryRun) {
      const replay = await resolveMissingDraft(spec, options, input, root, snapshotOptions);
      if (replay !== null) return { outcome: 'replayed', packet: replay };
    }
    return rejected(packetOf({
      status: 'error',
      data: { kind: 'usage', reason: 'invalid_input', schema: spec.schema, missing_inputs: [] },
      findings: channelFindings(spec.schema, input.issues, input.file),
      next: retryCommands(null),
    }));
  }
  const { document } = input;

  const schema = spec.document(document, { workflowRelative, file: input.file });
  if (!schema.ok) {
    return rejected(packetOf({
      status: 'error',
      data: { kind: schema.kind, reason: schema.reason, schema: schema.schema, missing_inputs: schema.missing_inputs },
      findings: schema.findings,
      next: retryCommands(input.file),
    }));
  }

  // ---- the transaction -----------------------------------------------------------------------------------------
  const state = { check: null };
  const currentSnapshot = async () => (await spec.snapshot(snapshotOptions, document)).snapshot;

  async function render(context) {
    const check = await spec.proposal({ repositoryRoot, workflowRoot, document, file: input.file });
    if (!check.ok) {
      return {
        rejection: {
          packet: packetOf({
            status: 'error',
            data: { kind: check.kind, reason: check.reason, schema: check.schema, missing_inputs: check.missing_inputs },
            findings: check.findings,
            next: retryCommands(input.file),
            snapshot: context.current_snapshot ?? null,
            id: context.request_id ?? null,
          }),
        },
      };
    }
    if (input.draft !== null) {
      const again = await readAuthoringInput({ repositoryRoot, workflowRoot, channel });
      if (!again.ok || !sameBytes(again.bytes, input.bytes)) {
        return {
          rejection: {
            packet: packetOf({
              status: 'error',
              data: { kind: 'usage', reason: 'input_changed', schema: spec.schema, missing_inputs: [] },
              findings: channelFindings(spec.schema, [{
                path: '$', code: 'input_changed', message: `${input.file} changed while it was being processed; nothing was written`,
              }], input.file),
              next: retryCommands(input.file),
              snapshot: context.current_snapshot ?? null,
              id: context.request_id ?? null,
            }),
          },
        };
      }
    }
    state.check = check;
    const operations = [{ type: 'create', path: check.workflowPath, content: check.text }];
    if (input.draft !== null) operations.push({ type: 'delete', path: draftPath(input.draftName) });
    return {
      operations,
      packet: {
        status: check.warnings.length > 0 ? 'warning' : 'ok',
        data: spec.data(check, input.draft),
        findings: check.warnings,
        nextCommands: createdCommands(check),
      },
    };
  }

  const result = await runTransactionalMutation({
    repositoryRoot,
    workflowRoot,
    root,
    command: spec.command,
    target: NO_TARGET,
    input: document,
    requestId,
    dryRun,
    expectedSnapshot,
    draft: input.draft,
    providers,
    knownCommands,
    boundary,
    lockOptions,
    currentSnapshot,
    render,
  });

  if (result.outcome === 'dry_run') {
    const { check } = state;
    const snapshot = await currentSnapshot();
    const data = {
      ...spec.data(check, input.draft),
      dry_run: true,
      would_change: result.plan.map(({ path }) => path).sort(compareStrings),
      proposed: spec.proposed(check),
    };
    return {
      ...result,
      packet: packetOf({ status: 'ok', data, findings: check.warnings, next: createdCommands(check), snapshot, id: null }),
    };
  }
  return { ...result, packet: withNextCommands(result.packet, retryCommands(input.file), knownCommands) };
}

// Journal-built packets (stale, conflict, lock, recovery) carry no next commands; a non-ok packet must offer a
// runnable one (AX4), so the retry is added without touching anything else in the packet.
export function withNextCommands(packet, commands, knownCommands) {
  if (!['error', 'blocked'].includes(packet.status) || packet.next_commands.length > 0) return packet;
  const next = { ...packet, next_commands: commands };
  const verdict = validatePacket(next, { knownCommands });
  if (!verdict.ok) throw new TypeError(`next commands are invalid: ${JSON.stringify(verdict.issues)}`);
  return next;
}

// A retry whose draft was consumed by the original run: resolved through the journal before any usage error.
async function resolveMissingDraft(spec, options, input, root, snapshotOptions) {
  const { repositoryRoot, workflowRoot, requestId, providers = createDefaultProviders(), knownCommands } = options;
  let record = null;
  if (requestId !== undefined) {
    const op = await readOp({ repositoryRoot, workflowRoot, requestId });
    if (op.status !== 'none' && op.committed !== null && op.committed.command === spec.command && op.committed.draft === input.file) {
      record = op.committed;
    }
  } else {
    const found = await resolveFromJournal({
      repositoryRoot, workflowRoot, command: spec.command, target: NO_TARGET, draftPath: input.file,
    });
    if (found.status === 'committed') record = found.record;
  }
  if (record === null) return null;
  const roadId = record.packet?.data?.task?.road;
  const probe = spec.template === 'task' ? { road: isId(roadId) ? roadId : null } : {};
  if (spec.template === 'task' && probe.road === null) return null;
  const current = (await spec.snapshot(snapshotOptions, probe)).snapshot;
  if (requestId === undefined && (record.after === null || record.after !== current)) return null;
  return buildReplayPacket({ record, root, currentSnapshot: current, providers, knownCommands });
}

export const createRoad = (options) => runAuthoring('road', options);
export const createTask = (options) => runAuthoring('task', options);
