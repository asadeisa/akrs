// The shared flow of the Phase 1 writers that take a Leader-authored or Worker-authored change (P1-W07): judge the
// request under the repository lock inside `render`, write the complete change set in one transaction together with
// the consumed draft, journal it, and answer a retry as a noop. `render` owns the domain rules; this module owns the
// packet plumbing, the dry run, the draft guard and the journal-resolved missing draft.
import { createPacket } from '../core/packet.js';
import { createDefaultProviders } from '../core/providers.js';
import { compareStrings, isUlid } from '../schemas/common.js';
import { buildReplayPacket, readOp, resolveFromJournal } from './journal/index.js';
import { readAuthoringInput } from './roads/input.js';
import { draftPath } from './roads/paths.js';
import { channelFindings } from './roads/proposal.js';
import { usageFinding, withNextCommands } from './roads/writers.js';
import { commandSnapshot } from './snapshots/index.js';
import { runTransactionalMutation } from './transactions/index.js';

const NO_TARGET = Object.freeze({ road: null, plan: null });
const sameBytes = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;

// options: { command, repositoryRoot, workflowRoot, root?, target?, snapshotTarget?, requestInput, requestId?, dryRun?,
//   again?, dedupe?, expectedSnapshot?, providers?, knownCommands, boundary?, lockOptions?, schema, input?, channel?,
//   retryCommands(), replayNextCommands?, render(context) }
// `input` is a successful readAuthoringInput result (drafts are consumed in the same transaction), `channel` its channel.
// render(context) -> { rejection: { kind, reason, findings, missing_inputs? } }
//                  | { operations, status?, data, findings?, nextCommands, proposed? }
export async function runMutationFlow(options) {
  const {
    command, repositoryRoot, workflowRoot, requestInput, requestId, dryRun = false, again = false, dedupe = 'projection',
    expectedSnapshot, providers = createDefaultProviders(), knownCommands, boundary, lockOptions, schema, input = null, channel = null,
    retryCommands, replayNextCommands, render,
  } = options;
  const root = options.root ?? repositoryRoot;
  const target = options.target ?? NO_TARGET;
  const suppliedId = requestId !== undefined && isUlid(requestId) ? requestId : null;
  const packetOf = ({ status, data, findings, next, snapshot = null, id = suppliedId }) => createPacket({
    command, requestId: id, status, root, snapshot: { before: snapshot, after: snapshot }, data, findings, nextCommands: next, providers, knownCommands,
  });
  const snapshotOf = async () => (await commandSnapshot(command, {
    repositoryRoot, workflowRoot, ...(options.snapshotTarget === undefined ? {} : { target: options.snapshotTarget }),
  })).snapshot;

  if (requestId !== undefined && !isUlid(requestId)) {
    return {
      outcome: 'rejected',
      packet: packetOf({
        status: 'error', data: { kind: 'usage', reason: 'invalid_request_id' },
        findings: [usageFinding('request_id must be a 26-character ULID')], next: [], id: null,
      }),
    };
  }
  const state = { rendered: null };
  const draft = input?.draft ?? null;

  async function guardedRender(context) {
    const preview = context.request_id === null || context.request_id === undefined;
    const rendered = await render({ ...context, preview });
    if (rendered.rejection !== undefined) {
      const { kind, reason, findings, missing_inputs: missing = [] } = rendered.rejection;
      return {
        rejection: {
          packet: packetOf({
            status: 'error', data: { kind, reason, schema, missing_inputs: missing }, findings, next: retryCommands(),
            snapshot: context.current_snapshot ?? null, id: context.request_id ?? null,
          }),
        },
      };
    }
    if (draft !== null) {
      const again2 = await readAuthoringInput({ repositoryRoot, workflowRoot, channel });
      if (!again2.ok || !sameBytes(again2.bytes, input.bytes)) {
        return {
          rejection: {
            packet: packetOf({
              status: 'error', data: { kind: 'usage', reason: 'input_changed', schema, missing_inputs: [] },
              findings: channelFindings(schema, [{
                path: '$', code: 'input_changed', message: `${input.file} changed while it was being processed; nothing was written`,
              }], input.file),
              next: retryCommands(), snapshot: context.current_snapshot ?? null, id: context.request_id ?? null,
            }),
          },
        };
      }
    }
    state.rendered = rendered;
    const operations = [...rendered.operations];
    if (draft !== null) operations.push({ type: 'delete', path: draftPath(input.draftName) });
    return {
      operations,
      packet: {
        status: rendered.status ?? 'ok',
        data: { ...rendered.data, draft },
        findings: rendered.findings ?? [],
        nextCommands: rendered.nextCommands,
      },
    };
  }

  const result = await runTransactionalMutation({
    repositoryRoot, workflowRoot, root, command, target, input: requestInput, requestId, dedupe, again, dryRun, expectedSnapshot,
    draft, providers, knownCommands, boundary, lockOptions, currentSnapshot: snapshotOf, render: guardedRender, replayNextCommands,
  });

  if (result.outcome === 'dry_run') {
    const { rendered } = state;
    const data = {
      ...rendered.data,
      draft,
      dry_run: true,
      would_change: result.plan.map(({ path }) => path).sort(compareStrings),
      proposed: rendered.proposed ?? null,
    };
    return {
      ...result,
      packet: packetOf({
        status: 'ok', data, findings: rendered.findings ?? [], next: rendered.nextCommands, snapshot: await snapshotOf(), id: null,
      }),
    };
  }
  return { ...result, packet: withNextCommands(result.packet, retryCommands(), knownCommands) };
}

// A usage packet for a document that could not be read or does not match its closed schema.
export function inputRejection({ command, root, providers, knownCommands, schema, input, next, requestId }) {
  return {
    outcome: 'rejected',
    packet: createPacket({
      command,
      requestId: requestId !== undefined && isUlid(requestId) ? requestId : null,
      status: 'error',
      root,
      snapshot: { before: null, after: null },
      data: { kind: 'usage', reason: 'invalid_input', schema, missing_inputs: [] },
      findings: channelFindings(schema, input.issues, input.file),
      nextCommands: next,
      providers,
      knownCommands,
    }),
  };
}

// A retry whose draft was consumed by the original run: resolved through the journal before any usage error.
// `snapshotFor(record)` gives the current snapshot of the recorded operation's scope.
export async function resolveMissingDraft({
  command, target = NO_TARGET, input, requestId, repositoryRoot, workflowRoot, root, providers = createDefaultProviders(), knownCommands,
  snapshotFor, requireUnchanged = false,
}) {
  let record = null;
  if (requestId !== undefined) {
    const op = await readOp({ repositoryRoot, workflowRoot, requestId });
    if (op.status !== 'none' && op.committed !== null && op.committed.command === command && op.committed.draft === input.file) record = op.committed;
  } else {
    const found = await resolveFromJournal({ repositoryRoot, workflowRoot, command, target, draftPath: input.file });
    if (found.status === 'committed') record = found.record;
  }
  if (record === null) return null;
  const current = await snapshotFor(record);
  if (current === null) return null;
  if (requestId === undefined && requireUnchanged && (record.after === null || record.after !== current)) return null;
  return buildReplayPacket({ record, root, currentSnapshot: current, providers, knownCommands });
}
