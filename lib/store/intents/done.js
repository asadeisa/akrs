// `done <road> --result --reach --expect` (A1 5.1): the Worker's finish in one call. It composes `road finish` (the declared checks and the
// audit UNLOCKED, then one transaction under the lock) with the handoff record the Tester reads, under the lease: the holder, a fresh
// contract and the baton are checked first, the handoff, the DONE status and the closure land together or not at all, and every blocker
// comes back with its fix. The Worker never types a snapshot, a hash or a request ID.
//
// The lease is the guard (a lease-implied expected snapshot): it is checked before the evidence runs and again under the lock, and it joins
// neither the journal request nor its replay key, so a retry after a crash replays as a noop whatever happened to the lease meanwhile.
import { createPacket } from '../../core/packet.js';
import { createDefaultProviders } from '../../core/providers.js';
import { isId } from '../../schemas/common.js';
import { HANDOFF_SCHEMA, validateHandoff } from '../../schemas/handoff-result.js';
import { findingsForSchemaIssues } from '../../schemas/index.js';
import { resolveProfile } from '../executors/index.js';
import { LEASE_FINDING_CODES, checkLease, heldByAnother, leaseStaleFinding, readLease } from '../leases/index.js';
import { readRoadOnce, transitionRoad } from '../lifecycle/index.js';
import { buildFreshRoadPacket } from '../road-details/index.js';
import { LEASE_CONTRACT_PROJECTION, commandSnapshot, computeSnapshot } from '../snapshots/index.js';
import { prepareHandoffRecord, testerGuard } from '../verification/index.js';
import { intentFinding, packetFactory, resolveWorker, unresolvedMessage } from './common.js';
import { INTENT_NEXT_COMMAND_BUILDERS } from './next-commands.js';
import { DONE_FLAGS, DONE_SCHEMA } from './policy.js';
import { readDoneFailures, recordDoneFailure } from './sidecars.js';

const builder = INTENT_NEXT_COMMAND_BUILDERS.done;
const PREVIEW_ID = '00000000000000000000000000';

// what a blocker is fixed with, by the reason road finish (or the baton) names
const FIXES = Object.freeze({
  checks_not_passed: 'Fix the failing check inside the declared writes and run done again; verify --road shows its output.',
  undeclared_change: 'Revert the file, or raise a scope request (scope request) and wait for the Leader before running done again.',
  scope_request_pending: 'Wait for the Leader to decide the pending blocking scope request, then run done again.',
  snapshot_unstable: 'The Road changed while done was preparing; run done again.',
  road_unverified: 'The Road file was edited outside the CLI; tell the Leader.',
  road_ambiguous: 'Tell the Leader: the Road exists in two files.',
  illegal_transition: 'Only an ACTIVE Road is finished; a DONE Road has nothing left to finish.',
  ledger_unusable: 'The handoff ledger cannot take a record; tell the Leader.',
});
const fixOf = (reason) => FIXES[reason] ?? 'Read the finding, fix its cause and run done again.';

// options: { repositoryRoot, workflowRoot, road, executorFlag?, baton?: { result, reach[], expect }, deviations?, preExisting?, requestId?, dryRun?,
//   expectedSnapshot? (an explicit one overrides the lease), env?, rootArgs?, providers?, knownCommands, boundary?, lockOptions?, signal?, clock?, root? }
// -> { problem: 'road_missing' } | { outcome, packet }
export async function doneIntent(options) {
  const {
    repositoryRoot, workflowRoot, road: id, executorFlag, baton, deviations = null, preExisting = [], requestId, dryRun = false, expectedSnapshot, env = process.env,
    rootArgs = [], providers = createDefaultProviders(), knownCommands, boundary, lockOptions, signal = null, clock,
  } = options;
  if (!isId(id)) throw new TypeError('road must be a valid ID');
  const root = options.root ?? repositoryRoot;
  const base = { repositoryRoot, workflowRoot };
  const make = packetFactory({ command: 'done', root, providers, knownCommands });
  const blockedData = (extra) => ({
    kind: 'done_blocked', packet_version: DONE_SCHEMA, reason: null, road: id, holder: null, subject: null, blockers: [], checks: null, audit: null, changed_files: [],
    attempts: null, delta: null, fresh: null, ...extra,
  });
  const refused = ({ reason, subject = null, message, holder = null, findings = null, next, snapshot = null, extra = {} }) => ({
    outcome: 'refused',
    packet: make({
      status: 'blocked', snapshot, next,
      data: blockedData({ reason, holder, subject, blockers: [{ reason, subject, fix: fixOf(reason) }], ...extra }),
      findings: findings ?? [intentFinding({ road: id, intent: 'done', reason, subject, message })],
    }),
  });

  // 1. the baton: three flat fields, validated by the handoff schema (the CLI fills Road, snapshot and readiness)
  const document = { schema: HANDOFF_SCHEMA, road: id, result: baton?.result, reach: baton?.reach, expect: baton?.expect };
  const issues = validateHandoff(document, { form: 'input' }).issues;
  if (issues.length > 0) {
    return {
      outcome: 'rejected',
      packet: make({
        status: 'error', next: builder({ phase: 'rejected', road: id, rootArgs }),
        data: { kind: 'usage', reason: 'invalid_input', schema: HANDOFF_SCHEMA, missing_inputs: [...DONE_FLAGS] },
        findings: findingsForSchemaIssues(HANDOFF_SCHEMA, issues, { file: null }),
      }),
    };
  }

  // 2. who is finishing, which Road, which lease
  const worker = await resolveWorker({ ...base, executorFlag, env });
  if (worker.status === 'executors_unusable') {
    return refused({ reason: 'executors_unusable', subject: worker.path, message: 'executors.json does not verify, so the class of the executor is unknown.', next: [] });
  }
  if (worker.status === 'unresolved') {
    return refused({
      reason: 'holder_unresolved', subject: worker.resolved.supplied, message: unresolvedMessage(worker.resolved),
      next: worker.resolved.choices.map((choice) => ({ command: 'work', args: [id, '--executor', choice, ...rootArgs] })), extra: { holder: null },
    });
  }
  const { holder, executors } = worker;
  const read = await readRoadOnce({ ...base, id });
  if (read.problem === 'road_missing') return { problem: 'road_missing' };
  if (read.problem !== undefined) {
    return refused({
      reason: read.problem, holder, subject: read.subject ?? null,
      message: read.problem === 'road_ambiguous' ? `Road ${id} exists in more than one file: ${read.subject}.` : `The Road file ${read.subject} does not verify (hand-edited or invalid).`,
      next: [],
    });
  }
  const { found } = read;
  // A DONE Road is not refused here: it may be the retry of a done that committed and was cut off before its answer, which the journal replays
  // as a noop; anything else about it is refused by road finish itself (illegal_transition).
  const finished = found.road.status === 'DONE';
  if (!finished && found.road.status !== 'ACTIVE') {
    return refused({ reason: 'not_active', holder, subject: found.road.status, message: `Road ${id} is ${found.road.status}; only an ACTIVE Road is finished.`, next: builder({ phase: 'stale', road: id, executor: holder, rootArgs }) });
  }
  const staleBlock = async (stale, lease) => {
    const fresh = await buildFreshRoadPacket({ ...base, id, role: 'worker', env, rootArgs, holder });
    return refused({
      reason: 'lease_stale', holder, subject: id, findings: [leaseStaleFinding(stale, lease)], message: '', snapshot: stale.snapshot,
      next: builder({ phase: 'stale', road: id, executor: holder, rootArgs }),
      extra: { delta: stale.delta, fresh: fresh.problem === undefined ? { status: fresh.status, data: fresh.data } : null },
    });
  };
  let lease = null;
  if (!finished) {
    const stored = await readLease({ ...base, kind: 'road', target: id });
    if (stored.status === 'none') {
      return refused({ reason: 'lease_missing', holder, subject: id, message: `${holder} holds no lease on ${id}; run work first.`, next: builder({ phase: 'stale', road: id, executor: holder, rootArgs }) });
    }
    if (stored.status === 'corrupt') {
      return refused({ reason: 'lease_corrupt', holder, subject: stored.reason, message: `The lease of ${id} is unreadable (${stored.reason}); the Leader releases it.`, next: builder({ phase: 'stale', road: id, executor: holder, rootArgs }) });
    }
    lease = stored.lease;
    if (lease.holder !== holder) {
      return refused({
        reason: 'lease_held', holder: lease.holder, subject: lease.holder, findings: [heldByAnother('road', id, lease.holder, holder)], message: '', next: [{ command: 'next', args: ['--executor', holder, ...rootArgs] }],
      });
    }
    const check = checkLease({ lease, current: await computeSnapshot({ ...base, projections: LEASE_CONTRACT_PROJECTION, target: { road: id } }) });
    if (check.state !== 'fresh') return staleBlock(check, lease);
  }

  // 3. road finish under the lease: the evidence unlocked, then the handoff, the status and the closure in one transaction
  const extend = async ({ context, found: inside }) => {
    // under the lock: still the holder, and the contract is still the one the lease was taken on
    const again = await readLease({ ...base, kind: 'road', target: id });
    if (again.status !== 'held' || again.lease.holder !== holder) {
      return { rejection: { kind: 'findings', reason: 'proposal_rejected', status: 'blocked', findings: [intentFinding({ road: id, intent: 'done', reason: 'lease_missing', subject: id, message: `${holder} no longer holds the lease on ${id}.` })] } };
    }
    const now = checkLease({ lease: again.lease, current: await computeSnapshot({ ...base, projections: LEASE_CONTRACT_PROJECTION, target: { road: id } }) });
    if (now.state !== 'fresh') return { rejection: { kind: 'findings', reason: 'proposal_rejected', status: 'blocked', findings: [leaseStaleFinding(now, again.lease)] } };
    const snapshot = (await commandSnapshot('test-handoff', { ...base, target: { road: id } })).snapshot;
    const prepared = await prepareHandoffRecord({
      ...base, key: inside.road.plan ?? id, document, snapshot, id: context.preview ? PREVIEW_ID : providers.runId(), ts: providers.now(),
    });
    if (prepared.problem !== undefined) return { rejection: { kind: 'findings', reason: 'proposal_rejected', status: 'blocked', findings: [testerGuard(prepared.problem)] } };
    return {
      operations: [prepared.operation],
      data: {
        kind: 'done', packet_version: DONE_SCHEMA, holder,
        handoff: { ...prepared.handoff, id: context.preview ? null : prepared.handoff.id, hash: context.preview ? null : prepared.handoff.hash },
      },
    };
  };
  const result = await transitionRoad({
    ...base,
    command: 'road-finish',
    as: 'done',
    nextBuilder: builder,
    id,
    deviations,
    preExisting,
    requestId,
    dryRun,
    expectedSnapshot,
    leaseGuard: true,
    providers,
    knownCommands,
    boundary,
    lockOptions,
    rootArgs,
    env,
    signal,
    clock,
    root,
    requestExtra: { holder, baton: { result: document.result, reach: document.reach, expect: document.expect } },
    extend,
  });
  const { packet } = result;
  if (packet.status === 'ok' || packet.status === 'warning' || packet.status === 'noop') return { outcome: result.outcome, packet };

  // a stale lease found under the lock (or an explicit snapshot that no longer matches) comes back as the delta and the fresh packet
  if (lease !== null && (result.outcome === 'stale' || packet.findings.some(({ code }) => code === LEASE_FINDING_CODES.stale))) {
    const changed = checkLease({ lease, current: await computeSnapshot({ ...base, projections: LEASE_CONTRACT_PROJECTION, target: { road: id } }) });
    if (changed.state !== 'fresh') return staleBlock(changed, lease);
  }

  // 4. a refusal: every blocker with its fix; a refusal after the evidence ran counts toward the class's yield limit
  const blockers = packet.findings
    .filter(({ detail }) => detail !== null && typeof detail === 'object' && typeof detail.reason === 'string' && Object.hasOwn(detail, 'subject'))
    .map(({ detail }) => ({ reason: detail.reason, subject: detail.subject ?? null, fix: fixOf(detail.reason) }));
  const ran = packet.data.checks !== undefined && packet.data.checks !== null;
  let failures = await readDoneFailures({ ...base, road: id, holder });
  if (ran && !dryRun) {
    const recorded = await recordDoneFailure({ ...base, road: id, holder, lockOptions });
    if (recorded.failures !== undefined) failures = recorded.failures;
  }
  const profile = resolveProfile(found.road.executor_class ?? worker.executor.class, executors.class_overrides);
  const limit = profile.done_failures_before_yield;
  const next = failures >= limit ? builder({ phase: 'yield', road: id, failures, executor: holder, rootArgs }) : builder({ phase: 'rejected', road: id, executor: holder, rootArgs });
  return {
    outcome: result.outcome,
    packet: createPacket({
      command: 'done',
      requestId: packet.request_id,
      status: packet.status === 'error' ? 'error' : 'blocked',
      root,
      snapshot: packet.snapshot,
      data: blockedData({
        reason: packet.data.reason ?? 'proposal_rejected', holder, subject: id, blockers,
        checks: packet.data.checks ?? null, audit: packet.data.audit ?? null, changed_files: packet.data.changed_files ?? [],
        attempts: { failures, limit },
      }),
      findings: packet.findings,
      changed: packet.changed,
      nextCommands: packet.status === 'error' ? packet.next_commands : next,
      providers,
      knownCommands,
    }),
  };
}
