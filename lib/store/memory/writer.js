// The Memory writer: the one flow behind `memory add`. Read the input channel, judge the document against the closed
// schema (usage errors), then hand the complete proposed change set to the transaction coordinator, which re-judges it
// against the workflow under the repository lock (findings), appends the record (and deletes the consumed draft) in
// one transaction, journals it, and answers an exact duplicate with a noop that offers --again.
import { createPacket } from '../../core/packet.js';
import { createDefaultProviders } from '../../core/providers.js';
import { compareStrings, isUlid } from '../../schemas/common.js';
import { MEMORY_INPUT_SCHEMA } from '../../schemas/memory.js';
import { buildReplayPacket, readOp, resolveFromJournal } from '../journal/index.js';
import { createPathService } from '../path-service.js';
import { readAuthoringInput } from '../roads/input.js';
import { draftPath } from '../roads/paths.js';
import { channelFindings } from '../roads/proposal.js';
import { usageFinding, withNextCommands } from '../roads/writers.js';
import { commandSnapshot } from '../snapshots/index.js';
import { runTransactionalMutation } from '../transactions/index.js';
import { MEMORY_NEXT_COMMAND_BUILDERS } from './next-commands.js';
import {
  PREVIEW_RECORD_ID, normalizeMemoryDocument, validateMemoryDocument, validateMemoryProposal,
} from './proposal.js';

const COMMAND = 'memory-add';
const NO_TARGET = Object.freeze({ road: null, plan: null });
const builder = MEMORY_NEXT_COMMAND_BUILDERS[COMMAND];

const sameBytes = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;

function recordData(check, { dryRun }) {
  const { record, hash, line, document } = check;
  return {
    id: dryRun ? null : record.id,
    topic: document.topic,
    label: record.label,
    path: check.path,
    line,
    hash: dryRun ? null : hash,
    meta_state: 'declared',
  };
}

// options: { repositoryRoot, workflowRoot, channel: { inputPath } | { stdin }, requestId?, dryRun?, again?,
//   expectedSnapshot?, providers?, knownCommands, rootArgs?, root?, boundary?, lockOptions?, hooks? }
// Returns the journal outcome ({ outcome, packet, ... }): committed | replayed | dry_run | rejected | stale | conflict |
// recovery_required | lock_blocked | failed.
export async function addMemory(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('options are required');
  const {
    repositoryRoot, workflowRoot, channel, requestId, dryRun = false, again = false, expectedSnapshot,
    providers = createDefaultProviders(), knownCommands, boundary, lockOptions, hooks = {}, rootArgs = [],
  } = options;
  if (channel === null || typeof channel !== 'object') throw new TypeError('channel is required');
  const root = options.root ?? repositoryRoot;
  const snapshotOptions = { repositoryRoot, workflowRoot };
  const suppliedId = requestId !== undefined && isUlid(requestId) ? requestId : null;

  const retryCommands = (file) => builder({ phase: 'rejected', file, rootArgs });
  const packetOf = ({ status, data, findings, next, snapshot = null, id = suppliedId }) => createPacket({
    command: COMMAND,
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
      const replay = await resolveMissingDraft(options, input, root);
      if (replay !== null) return { outcome: 'replayed', packet: replay };
    }
    return rejected(packetOf({
      status: 'error',
      data: { kind: 'usage', reason: 'invalid_input', schema: MEMORY_INPUT_SCHEMA, missing_inputs: [] },
      findings: channelFindings(MEMORY_INPUT_SCHEMA, input.issues, input.file),
      next: retryCommands(null),
    }));
  }

  const schema = validateMemoryDocument(input.document, { file: input.file });
  if (!schema.ok) {
    return rejected(packetOf({
      status: 'error',
      data: { kind: schema.kind, reason: schema.reason, schema: schema.schema, missing_inputs: schema.missing_inputs },
      findings: schema.findings,
      next: retryCommands(input.file),
    }));
  }
  // The journal request is the normalized document, so the LF and CRLF spellings of one text are one request.
  const document = normalizeMemoryDocument(input.document);

  // ---- the transaction -----------------------------------------------------------------------------------------
  const state = { check: null };
  const currentSnapshot = async () => (await commandSnapshot(COMMAND, snapshotOptions)).snapshot;
  const duplicateCommands = builder({ phase: 'duplicate', file: input.file, rootArgs });

  async function render(context) {
    const preview = context.request_id === null || context.request_id === undefined;
    const check = await validateMemoryProposal({
      repositoryRoot,
      workflowRoot,
      document,
      file: input.file,
      newId: () => (preview ? PREVIEW_RECORD_ID : providers.runId()),
    });
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
      const reread = await readAuthoringInput({ repositoryRoot, workflowRoot, channel });
      if (!reread.ok || !sameBytes(reread.bytes, input.bytes)) {
        return {
          rejection: {
            packet: packetOf({
              status: 'error',
              data: { kind: 'usage', reason: 'input_changed', schema: MEMORY_INPUT_SCHEMA, missing_inputs: [] },
              findings: channelFindings(MEMORY_INPUT_SCHEMA, [{
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
    const operations = [check.operation];
    if (input.draft !== null) operations.push({ type: 'delete', path: draftPath(input.draftName) });
    return {
      operations,
      packet: {
        status: 'ok',
        data: { kind: 'memory_add', dry_run: false, record: recordData(check, { dryRun: false }), draft: input.draft },
        findings: check.warnings,
        nextCommands: builder({ phase: 'created', rootArgs }),
      },
    };
  }

  const result = await runTransactionalMutation({
    repositoryRoot,
    workflowRoot,
    root,
    command: COMMAND,
    target: NO_TARGET,
    input: document,
    requestId,
    dedupe: 'append',
    again,
    dryRun,
    expectedSnapshot,
    draft: input.draft,
    providers,
    knownCommands,
    boundary,
    lockOptions,
    currentSnapshot,
    render,
    replayNextCommands: duplicateCommands,
  });

  if (result.outcome === 'dry_run') {
    const { check } = state;
    const data = {
      kind: 'memory_add',
      dry_run: true,
      record: recordData(check, { dryRun: true }),
      draft: input.draft,
      would_change: result.plan.map(({ path }) => path).sort(compareStrings),
      proposed: {
        label: check.record.label,
        decided_by: check.record.decided_by,
        owner_plan: check.record.owner_plan,
        text: check.record.text,
        pointers: check.record.pointers,
      },
    };
    return {
      ...result,
      packet: packetOf({
        status: 'ok', data, findings: check.warnings, next: builder({ phase: 'created', rootArgs }), snapshot: await currentSnapshot(), id: null,
      }),
    };
  }
  return { ...result, packet: withNextCommands(result.packet, retryCommands(input.file), knownCommands) };
}

// A retry whose draft was consumed by the original run: resolved through the journal before any usage error. An append
// replays whether or not the workflow moved on since (appends are snapshot-free duplicates, A1 3.2).
async function resolveMissingDraft(options, input, root) {
  const { repositoryRoot, workflowRoot, requestId, providers = createDefaultProviders(), knownCommands } = options;
  let record = null;
  if (requestId !== undefined) {
    const op = await readOp({ repositoryRoot, workflowRoot, requestId });
    if (op.status !== 'none' && op.committed !== null && op.committed.command === COMMAND && op.committed.draft === input.file) {
      record = op.committed;
    }
  } else {
    const found = await resolveFromJournal({
      repositoryRoot, workflowRoot, command: COMMAND, target: NO_TARGET, draftPath: input.file,
    });
    if (found.status === 'committed') record = found.record;
  }
  if (record === null) return null;
  const current = (await commandSnapshot(COMMAND, { repositoryRoot, workflowRoot })).snapshot;
  return buildReplayPacket({ record, root, currentSnapshot: current, providers, knownCommands });
}
