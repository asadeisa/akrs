// The closure ledger writer: the one flow behind `log append`. Judge the flags against the closed closure schema
// (usage errors), then hand the complete proposed change set to the transaction coordinator, which re-judges it
// against the ledger under the repository lock (findings: unusable segment, duplicate closure), appends the record
// (or creates the next segment when the active one is full) in one transaction and journals it.
import { createPacket } from '../../core/packet.js';
import { createDefaultProviders } from '../../core/providers.js';
import { CLOSURE_SCHEMA } from '../../schemas/closure.js';
import { compareStrings, isUlid } from '../../schemas/common.js';
import { usageFinding, withNextCommands } from '../roads/writers.js';
import { commandSnapshot } from '../snapshots/index.js';
import { runTransactionalMutation } from '../transactions/index.js';
import { LOG_NEXT_COMMAND_BUILDERS } from './next-commands.js';
import { PREVIEW_CLOSURE_ID, validateLogDocument, validateLogProposal } from './proposal.js';

const COMMAND = 'log-append';
const NO_TARGET = Object.freeze({ road: null, plan: null });
const builder = LOG_NEXT_COMMAND_BUILDERS[COMMAND];

function recordData(check, { dryRun }) {
  const { record, segment, line } = check;
  return {
    id: dryRun ? null : record.id,
    kind: record.kind,
    subject: record.subject,
    outcome: record.outcome,
    deviations: record.deviations,
    segment: segment.path,
    line,
    rotated: segment.rotated,
    hash: dryRun ? null : record.hash,
    meta_state: 'declared',
  };
}

// options: { repositoryRoot, workflowRoot, document: { kind, subject, outcome, deviations }, requestId?, dryRun?,
//   expectedSnapshot?, providers?, knownCommands, rootArgs?, root?, boundary?, lockOptions? }
// Returns the journal outcome ({ outcome, packet, ... }): committed | replayed | dry_run | rejected | stale | conflict |
// recovery_required | lock_blocked | failed.
export async function appendClosure(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('options are required');
  const {
    repositoryRoot, workflowRoot, document, requestId, dryRun = false, expectedSnapshot,
    providers = createDefaultProviders(), knownCommands, boundary, lockOptions, rootArgs = [],
  } = options;
  if (document === null || typeof document !== 'object') throw new TypeError('document is required');
  const root = options.root ?? repositoryRoot;
  const suppliedId = requestId !== undefined && isUlid(requestId) ? requestId : null;
  const retryCommands = () => builder({ phase: 'rejected', document, rootArgs });
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
  const schema = validateLogDocument(document);
  if (!schema.ok) {
    return rejected(packetOf({
      status: 'error',
      data: { kind: 'usage', reason: 'invalid_input', schema: schema.schema, missing_inputs: [] },
      findings: schema.issues.map(({ path, message }) => usageFinding(`${path}: ${message}`, { reason: `${path}: ${message}` })),
      next: builder({ phase: 'rejected', document: null, rootArgs }),
    }));
  }

  const state = { check: null };
  const currentSnapshot = async () => (await commandSnapshot(COMMAND, { repositoryRoot, workflowRoot })).snapshot;

  async function render(context) {
    const preview = context.request_id === null || context.request_id === undefined;
    const check = await validateLogProposal({
      repositoryRoot,
      workflowRoot,
      document,
      newId: () => (preview ? PREVIEW_CLOSURE_ID : providers.runId()),
      now: () => providers.now(),
    });
    if (!check.ok) {
      return {
        rejection: {
          packet: packetOf({
            status: 'error',
            data: { kind: check.kind, reason: check.reason, schema: check.schema, missing_inputs: [] },
            findings: check.findings,
            next: retryCommands(),
            snapshot: context.current_snapshot ?? null,
            id: context.request_id ?? null,
          }),
        },
      };
    }
    state.check = check;
    return {
      operations: [check.operation],
      packet: {
        status: 'ok',
        data: { kind: 'log_append', dry_run: false, record: recordData(check, { dryRun: false }) },
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
    input: { schema: CLOSURE_SCHEMA, ...document },
    requestId,
    dedupe: 'append',
    again: false,
    dryRun,
    expectedSnapshot,
    draft: null,
    providers,
    knownCommands,
    boundary,
    lockOptions,
    currentSnapshot,
    render,
    replayNextCommands: builder({ phase: 'created', rootArgs }),
  });

  if (result.outcome === 'dry_run') {
    const { check } = state;
    const data = {
      kind: 'log_append',
      dry_run: true,
      record: recordData(check, { dryRun: true }),
      would_change: result.plan.map(({ path }) => path).sort(compareStrings),
      proposed: { kind: check.record.kind, subject: check.record.subject, outcome: check.record.outcome, deviations: check.record.deviations },
    };
    return {
      ...result,
      packet: packetOf({
        status: 'ok', data, findings: check.warnings, next: builder({ phase: 'created', rootArgs }), snapshot: await currentSnapshot(), id: null,
      }),
    };
  }
  return { ...result, packet: withNextCommands(result.packet, retryCommands(), knownCommands) };
}
