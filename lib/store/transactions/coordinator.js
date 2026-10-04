// The shared mutation coordinator (F9): every workflow writer renders its complete proposed change set and hands it
// to runTransactionalMutation, which drives the journal (lock, recovery, replay, validation) and the transaction
// engine (stage, prepare, apply, commit marker, journal commit, cleanup). Domain outcomes are returned exactly as
// runJournaledMutation returns them; programming errors and I/O failures throw.
import { createPacket } from '../../core/packet.js';
import { createDefaultProviders } from '../../core/providers.js';
import { compareStrings, isUlid } from '../../schemas/common.js';
import { settleRecovery, runJournaledMutation, normalizeTarget } from '../journal/index.js';
import { readOpFile } from '../journal/storage.js';
import { locateOps } from '../ops-files.js';
import { commandSnapshot } from '../snapshots/index.js';
import {
  applyOperations,
  createTransactionContext,
  fire,
  listTransactionIds,
  recoverOne,
  recoveryFinding,
  removeTransaction,
  stageTransaction,
  writeCommitMarker,
  writePacketFile,
} from './engine.js';
import { ChangeSetError, describePlan, planOperations } from './plan.js';
import { TRANSACTION_FINDING_CODES } from './policy.js';

export { ChangeSetError } from './plan.js';
export { TransactionConflictError } from './engine.js';

const PACKET_SPEC_KEYS = ['status', 'data', 'findings', 'changed', 'nextCommands', 'next_commands'];
const JOURNAL_BOUNDARIES = Object.freeze({
  after_prepared: 'journal_prepared',
  after_apply: 'commit_marker',
  after_committed: 'journal_committed',
  after_index: 'journal_indexed',
});

function checkBoundary(boundary) {
  if (boundary !== undefined && boundary !== null && typeof boundary !== 'function') throw new TypeError('boundary must be a function');
  return boundary ?? null;
}

// ---- recovery hooks ----------------------------------------------------------------------------------------
// recover/sweep for runJournaledMutation (and settleRecovery). Used by the coordinator, and by every other
// journal caller that must not start beside an unrecovered transaction (the lease-only commands).
export function createTransactionRecovery({ repositoryRoot, workflowRoot, boundary = null } = {}) {
  if (typeof workflowRoot !== 'string' || workflowRoot.length === 0) throw new TypeError('workflowRoot is required');
  checkBoundary(boundary);
  const settled = new Map(); // transaction -> outcome already decided by the journal-owned path
  const report = new Map();
  const locate = () => locateOps({ repositoryRoot, workflowRoot });
  const note = (transaction, requestId, outcome) => {
    if (!report.has(transaction)) report.set(transaction, { transaction, request_id: requestId, outcome });
  };

  async function recover({ request_id: requestId, transaction, record }) {
    const ctx = createTransactionContext({ location: await locate(), requestId, command: record.command, boundary });
    const result = await recoverOne(ctx, transaction, { owned: true, expectedRequestId: requestId });
    if (result.outcome === 'rolled_back') {
      settled.set(transaction, 'rolled_back');
      note(transaction, requestId, 'rolled_back');
      return { status: 'rolled_back' };
    }
    if (result.outcome === 'rolled_forward') {
      settled.set(transaction, 'rolled_forward');
      note(transaction, requestId, 'rolled_forward');
      return { status: 'committed', packet: result.packet };
    }
    note(transaction, requestId, 'blocked');
    return { status: 'blocked', findings: [result.finding] };
  }

  async function sweep() {
    const location = await locate();
    const base = createTransactionContext({ location, boundary });
    for (const id of await listTransactionIds(base)) {
      const removeScratch = async (outcome, requestId) => {
        await removeTransaction(base, id);
        await fire({ ...base, id, requestId }, 'recovery_cleanup', { outcome });
      };
      if (settled.has(id)) {
        await removeScratch(settled.get(id), null);
        continue;
      }
      const result = await recoverOne(base, id, { owned: false });
      if (result.outcome === 'gone') continue;
      if (result.outcome === 'blocked') {
        note(id, result.request_id, 'blocked');
        return { findings: [result.finding] };
      }
      if (result.outcome === 'committed_orphan') {
        const op = await readOpFile(location, result.request_id);
        if (op?.committed?.transaction !== id) {
          const finding = recoveryFinding({
            transaction: id, requestId: result.request_id, reason: 'committed_without_journal', path: `.ops/tx/${id}/manifest.json`,
          });
          note(id, result.request_id, 'blocked');
          return { findings: [finding] };
        }
        await removeScratch('cleaned', result.request_id);
        note(id, result.request_id, 'cleaned');
        continue;
      }
      await removeScratch(result.outcome, result.request_id);
      note(id, result.request_id, result.outcome);
    }
    return null;
  }

  return Object.freeze({ recover, sweep, report: () => [...report.values()] });
}

// Standalone recovery (no mutation): lock, settle every journal-owned transaction, sweep the rest.
export async function recoverTransactions({
  repositoryRoot, workflowRoot, providers = createDefaultProviders(), boundary = null, heldLock, lockOptions, knownCommands,
} = {}) {
  const recovery = createTransactionRecovery({ repositoryRoot, workflowRoot, boundary });
  const result = await settleRecovery({
    repositoryRoot, workflowRoot, providers, heldLock, lockOptions, knownCommands, recover: recovery.recover, sweep: recovery.sweep,
  });
  if (result.status === 'lock_blocked') return { status: 'lock_blocked', recovered: [], findings: [result.finding] };
  if (result.status === 'blocked') return { status: 'blocked', recovered: recovery.report(), findings: result.findings };
  return { status: 'ok', recovered: recovery.report(), findings: [] };
}

// ---- the coordinator -----------------------------------------------------------------------------------------
function checkRendered(rendered) {
  if (rendered === null || typeof rendered !== 'object') throw new TypeError('render must return { operations, packet } or { rejection }');
  if (rendered.rejection !== undefined) return rendered;
  if (!Array.isArray(rendered.operations) || rendered.operations.length === 0) {
    throw new TypeError('render must return a non-empty operations array');
  }
  const { packet } = rendered;
  if (packet === null || typeof packet !== 'object' || Array.isArray(packet)) throw new TypeError('render must return a packet object');
  for (const key of Object.keys(packet)) {
    if (!PACKET_SPEC_KEYS.includes(key)) throw new TypeError(`render packet has an unknown key: ${key}`);
  }
  if (packet.data === null || typeof packet.data !== 'object' || Array.isArray(packet.data)) {
    throw new TypeError('render packet.data must be an object');
  }
  if (packet.status !== undefined && !['ok', 'warning'].includes(packet.status)) {
    throw new TypeError('render packet.status must be ok or warning: an error or blocked result is a rejection, found before writing');
  }
  return rendered;
}

function defaultSnapshot({ command, target, repositoryRoot, workflowRoot }) {
  const normalized = normalizeTarget(target);
  return async () => {
    const wanted = {};
    for (const key of ['road', 'plan']) if (normalized[key] !== null) wanted[key] = normalized[key];
    return (await commandSnapshot(command, { repositoryRoot, workflowRoot, target: wanted })).snapshot;
  };
}

export async function runTransactionalMutation(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('options are required');
  const { repositoryRoot, workflowRoot, command } = options;
  if (typeof workflowRoot !== 'string' || workflowRoot.length === 0) throw new TypeError('workflowRoot is required');
  if (typeof command !== 'string' || command.length === 0) throw new TypeError('command is required');
  if (typeof options.render !== 'function') throw new TypeError('render must be a function');
  const boundary = checkBoundary(options.boundary);
  const providers = options.providers ?? createDefaultProviders();
  const requestId = options.requestId ?? options.request_id;
  const root = options.root ?? repositoryRoot ?? workflowRoot;
  const currentSnapshot = options.currentSnapshot ?? defaultSnapshot({
    command, target: options.target, repositoryRoot, workflowRoot,
  });
  const recovery = createTransactionRecovery({ repositoryRoot, workflowRoot, boundary });

  const state = { plan: null, rendered: null, ctx: null, dir: null, manifest: null };
  const emit = (point, extra = {}) => boundary?.({
    point, index: null, request_id: null, transaction: state.ctx?.id ?? null, command, ...extra,
  });

  const usagePacket = (context, error) => createPacket({
    command,
    requestId: context.request_id ?? null,
    status: 'error',
    root,
    snapshot: { before: context.current_snapshot ?? null, after: context.current_snapshot ?? null },
    data: { kind: 'usage', reason: 'invalid_change_set' },
    findings: [{
      code: TRANSACTION_FINDING_CODES.invalid_change_set,
      severity: 'error',
      message: `The proposed change set was rejected: ${error.reason}`,
      file: null,
      line: null,
      detail: { path: error.path, reason: error.reason },
    }],
    providers,
    knownCommands: options.knownCommands,
  });

  // Render and prove the full proposed tree (under the lock, before anything is written).
  async function validate(context) {
    if (options.validate !== undefined) {
      const rejection = await options.validate(context);
      if (rejection !== null && rejection !== undefined) return rejection;
    }
    const rendered = checkRendered(await options.render({ ...context, transaction: null }));
    if (rendered.rejection !== undefined) return rendered.rejection;
    try {
      const location = await locateOps({ repositoryRoot, workflowRoot });
      state.plan = await planOperations({ repositoryRoot, workflowRoot, root: location.root, operations: rendered.operations });
    } catch (error) {
      if (error instanceof ChangeSetError) return { packet: usagePacket(context, error) };
      throw error;
    }
    state.rendered = rendered;
    return null;
  }

  async function beginTransaction(context) {
    const id = providers.runId();
    if (!isUlid(id)) throw new TypeError('providers.runId must return a ULID');
    const location = await locateOps({ repositoryRoot, workflowRoot });
    const ctx = createTransactionContext({ location, requestId: context.request_id, command, boundary, id });
    try {
      const staged = await stageTransaction(ctx, state.plan, { requestId: context.request_id, command, now: providers.now });
      state.dir = staged.dir;
      state.manifest = staged.manifest;
    } catch (error) {
      // nothing was applied before prepare: removing the scratch is the whole rollback
      await removeTransaction(ctx, id).catch(() => {});
      throw error;
    }
    state.ctx = ctx;
    return id;
  }

  const defaultChanged = (plan) => {
    const paths = new Set();
    for (const operation of plan.operations) {
      paths.add(operation.path);
      if (operation.to !== null) paths.add(operation.to);
    }
    return [...paths].sort(compareStrings);
  };

  // Applies the operations, then writes packet.json and the commit marker. A failure before the marker restores in
  // process through the recovery routine; if the marker turns out to be durable after all, nothing is undone.
  async function apply(context) {
    const { ctx, dir, plan, rendered } = state;
    let packet;
    try {
      const applied = await applyOperations(ctx, dir, plan, state.manifest);
      const after = await currentSnapshot();
      const spec = rendered.packet;
      packet = createPacket({
        command,
        requestId: context.request_id,
        status: spec.status ?? 'ok',
        root,
        snapshot: { before: context.current_snapshot, after },
        data: spec.data,
        findings: spec.findings ?? [],
        changed: spec.changed ?? defaultChanged(plan),
        nextCommands: spec.nextCommands ?? spec.next_commands ?? [],
        providers,
        knownCommands: options.knownCommands,
      });
      await writePacketFile(dir, packet);
      await fire(ctx, 'packet_written');
      await writeCommitMarker(dir, applied, providers.now());
    } catch (error) {
      let settled = null;
      try {
        settled = await recoverOne(ctx, ctx.id, { owned: true, expectedRequestId: context.request_id });
      } catch {
        settled = null;
      }
      if (settled?.outcome === 'rolled_forward') return settled.packet;
      if (settled?.outcome === 'rolled_back') await removeTransaction(ctx, ctx.id).catch(() => {});
      throw error;
    }
    return packet;
  }

  async function afterCommit(committed) {
    await cleanup(committed);
    await options.afterCommit?.(committed);
  }

  async function cleanup({ transaction }) {
    if (transaction === null || state.ctx === null) return;
    let boundaryError = null;
    const guarded = {
      ...state.ctx,
      async boundary(event) {
        try {
          await boundary?.(event);
        } catch (error) {
          boundaryError = error;
          throw error;
        }
      },
    };
    try {
      await removeTransaction(guarded, transaction, { cleanupBoundaries: true });
    } catch (error) {
      // a hook that throws is a crash; a real I/O failure only leaves scratch for the next sweep
      if (boundaryError !== null) throw boundaryError;
    }
  }

  const faults = {};
  for (const [journalPoint, point] of Object.entries(JOURNAL_BOUNDARIES)) {
    faults[journalPoint] = ({ request_id: id }) => emit(point, { request_id: id });
  }

  const result = await runJournaledMutation({
    repositoryRoot,
    workflowRoot,
    root,
    command,
    target: options.target,
    input: options.input,
    requestId,
    dedupe: options.dedupe,
    again: options.again,
    draft: options.draft,
    dryRun: options.dryRun,
    expectedSnapshot: options.expectedSnapshot,
    providers,
    knownCommands: options.knownCommands,
    currentSnapshot,
    authorize: options.authorize,
    validate,
    beginTransaction,
    apply,
    recover: recovery.recover,
    sweep: recovery.sweep,
    afterCommit,
    onRequestId: options.onRequestId,
    retention: options.retention,
    lockOptions: options.lockOptions,
    replayNextCommands: options.replayNextCommands,
    faults,
  });
  const extra = { transaction: state.ctx?.id ?? null };
  if (result.outcome === 'dry_run' && state.plan !== null) extra.plan = describePlan(state.plan);
  return Object.freeze({ ...result, ...extra });
}
