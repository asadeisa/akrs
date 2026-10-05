// `yield <road> --reason "…"` (A1 2.4): the Worker's one-call exit from a Road that is too big mid-work. In ONE transaction it records a yield
// record in the Road's scope ledger (the Road `needs_split` until the Leader changes it, and the Leader's `boot` asks about it); right after
// the commit, under the same lock, it releases the lease (and with it the guard allowlist). It never waits on a stale lease.
import { createDefaultProviders } from '../../core/providers.js';
import { isId } from '../../schemas/common.js';
import { SCOPE_YIELD_SPEC, validateScopeYield } from '../../schemas/scope.js';
import { decodeJsonl, encodeJsonlRecord } from '../canonical/index.js';
import { heldByAnother, readLease, releaseLease } from '../leases/index.js';
import { readRoadOnce } from '../lifecycle/index.js';
import { runMutationFlow } from '../mutation-flow.js';
import { guardFinding } from '../roads/update.js';
import { scopePath, readScope } from '../scope/index.js';
import { intentFinding, packetFactory, resolveWorker, unresolvedMessage } from './common.js';
import { INTENT_NEXT_COMMAND_BUILDERS } from './next-commands.js';
import { YIELD_SCHEMA } from './policy.js';

const builder = INTENT_NEXT_COMMAND_BUILDERS.yield;
const PREVIEW_ID = '00000000000000000000000000';

// options: { repositoryRoot, workflowRoot, road, reason, executorFlag?, requestId?, dryRun?, env?, rootArgs?, providers?, knownCommands, boundary?, lockOptions?, root? }
// -> { problem: 'road_missing' } | { outcome, packet }
export async function yieldIntent(options) {
  const {
    repositoryRoot, workflowRoot, road: id, reason, executorFlag, requestId, dryRun = false, env = process.env, rootArgs = [],
    providers = createDefaultProviders(), knownCommands, boundary, lockOptions,
  } = options;
  if (!isId(id)) throw new TypeError('road must be a valid ID');
  const root = options.root ?? repositoryRoot;
  const base = { repositoryRoot, workflowRoot };
  const make = packetFactory({ command: 'yield', root, providers, knownCommands });
  const refused = ({ reason: why, holder = null, subject = null, message, findings = null, next }) => ({
    outcome: 'refused',
    packet: make({
      status: 'blocked', next,
      data: { kind: 'yield_blocked', packet_version: YIELD_SCHEMA, reason: why, road: id, holder, subject },
      findings: findings ?? [intentFinding({ road: id, intent: 'yield', reason: why, subject, message })],
    }),
  });

  // the reason is the Worker's own words: the record's schema decides what is acceptable
  const probe = validateScopeYield({
    id: PREVIEW_ID, hash: `sha256:${'0'.repeat(64)}`, ts: '2026-01-01T00:00:00.000Z', type: 'yield', road: id, holder: 'probe', reason, road_hash: `sha256:${'0'.repeat(64)}`,
  });
  const reasonIssues = probe.issues.filter(({ path }) => path === '$.reason');
  if (reasonIssues.length > 0) {
    return {
      outcome: 'rejected',
      packet: make({
        status: 'error', next: builder({ phase: 'rejected', road: id, rootArgs }),
        data: { kind: 'usage', reason: 'invalid_input', schema: YIELD_SCHEMA, missing_inputs: typeof reason === 'string' && reason !== '' ? [] : ['--reason'] },
        findings: [{ code: 'AKRS-C001', severity: 'error', message: `yield needs --reason "<why this Road is too big>": ${reasonIssues[0].message}`, file: null, line: null, detail: { reason: reasonIssues[0].message } }],
      }),
    };
  }

  const worker = await resolveWorker({ ...base, executorFlag, env });
  if (worker.status === 'executors_unusable') return refused({ reason: 'executors_unusable', subject: worker.path, message: 'executors.json does not verify, so the class of the executor is unknown.', next: [] });
  if (worker.status === 'unresolved') {
    return refused({
      reason: 'holder_unresolved', subject: worker.resolved.supplied, message: unresolvedMessage(worker.resolved),
      next: worker.resolved.choices.map((choice) => ({ command: 'yield', args: [id, '--executor', choice, '--reason', reason, ...rootArgs] })),
    });
  }
  const { holder } = worker;
  const read = await readRoadOnce({ ...base, id });
  if (read.problem === 'road_missing') return { problem: 'road_missing' };
  if (read.problem !== undefined) {
    return refused({
      reason: read.problem, holder, subject: read.subject ?? null,
      message: read.problem === 'road_ambiguous' ? `Road ${id} exists in more than one file: ${read.subject}.` : `The Road file ${read.subject} does not verify (hand-edited or invalid).`, next: [],
    });
  }
  const gate = async () => {
    const stored = await readLease({ ...base, kind: 'road', target: id });
    if (stored.status === 'none') return { problem: refused({ reason: 'lease_missing', holder, subject: id, message: `${holder} holds no lease on ${id}; there is nothing to yield.`, next: builder({ phase: 'rejected', road: id, executor: holder, rootArgs }) }) };
    if (stored.status === 'corrupt') return { problem: refused({ reason: 'lease_corrupt', holder, subject: stored.reason, message: `The lease of ${id} is unreadable (${stored.reason}); the Leader releases it.`, next: [] }) };
    if (stored.lease.holder !== holder) {
      return { problem: refused({ reason: 'lease_held', holder: stored.lease.holder, subject: stored.lease.holder, findings: [heldByAnother('road', id, stored.lease.holder, holder)], message: '', next: [{ command: 'next', args: ['--executor', holder, ...rootArgs] }] }) };
    }
    return { lease: stored.lease };
  };
  if (read.found.road.status !== 'ACTIVE') {
    return refused({ reason: 'not_active', holder, subject: read.found.road.status, message: `Road ${id} is ${read.found.road.status}; only an ACTIVE Road is yielded.`, next: builder({ phase: 'done', executor: holder, rootArgs }) });
  }
  const first = await gate();
  if (first.problem !== undefined) return first.problem;

  const state = { lock: null };
  const retry = () => builder({ phase: 'rejected', road: id, executor: holder, rootArgs });
  const render = async (context) => {
    state.lock = context.lock ?? null;
    const again = await readRoadOnce({ ...base, id });
    if (again.found === undefined) return { rejection: { kind: 'findings', reason: 'proposal_rejected', status: 'blocked', findings: [intentFinding({ road: id, intent: 'yield', reason: again.problem === 'road_missing' ? 'road_unverified' : again.problem, subject: again.subject ?? id, message: `Road ${id} cannot be read: ${again.problem}.` })] } };
    const held = await gate();
    if (held.problem !== undefined) return { rejection: { kind: 'findings', reason: 'proposal_rejected', status: 'blocked', findings: held.problem.packet.findings } };
    const scope = await readScope({ ...base, road: id });
    if (scope.problem !== null) {
      return { rejection: { kind: 'findings', reason: 'proposal_rejected', findings: [guardFinding({ reason: 'ledger_unusable', subject: id, file: scope.path, message: `The scope ledger ${scope.path ?? scope.workflow_path} cannot take a record (${scope.problem}).`, actual: scope.problem })] } };
    }
    const ulid = context.preview ? PREVIEW_ID : providers.runId();
    const line = encodeJsonlRecord({
      id: ulid, ts: providers.now(), type: 'yield', road: id, holder, reason, road_hash: again.found.road.meta.content_hash,
    }, SCOPE_YIELD_SPEC);
    const record = decodeJsonl(line, () => SCOPE_YIELD_SPEC).records[0].value;
    const verdict = validateScopeYield(record);
    if (!verdict.ok) throw new TypeError(`rendered yield is invalid: ${JSON.stringify(verdict.issues)}`);
    const path = scopePath(id);
    return {
      operations: [{ type: scope.exists ? 'append' : 'create', path, content: line }],
      data: {
        kind: 'yield',
        packet_version: YIELD_SCHEMA,
        dry_run: false,
        road: id,
        holder,
        reason,
        yielded: { id: context.preview ? null : ulid, hash: context.preview ? null : record.hash, path: scope.path ?? path },
        needs_split: true,
        lease: { holder, released: true },
        question_for_leader: { kind: 'yielded_road', subject: id, text: `${holder} yielded Road ${id}: ${reason}` },
      },
      nextCommands: builder({ phase: 'done', executor: holder, rootArgs }),
      proposed: record,
    };
  };
  const afterCommit = async () => {
    if (state.lock === null) return;
    await releaseLease({ ...base, kind: 'road', target: id, holder, heldLock: state.lock, providers });
  };

  // the escape hatch never waits on a stale lease and takes no expected snapshot: the Road, the lease and the ledger are re-read under the lock
  // (an append re-validates its complete proposed state), and nothing about the lease joins the request, so a retry replays whatever the lease did
  const result = await runMutationFlow({
    command: 'yield',
    repositoryRoot,
    workflowRoot,
    root,
    providers,
    knownCommands,
    target: { road: id, plan: null },
    snapshotTarget: { road: id },
    requestInput: { road: id, holder, reason },
    requestId,
    dryRun,
    schema: YIELD_SCHEMA,
    boundary,
    lockOptions,
    retryCommands: retry,
    render,
    afterCommit,
  });
  return { outcome: result.outcome, packet: result.packet };
}
