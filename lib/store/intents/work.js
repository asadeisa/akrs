// `work [<road>] [--executor] [--takeover]` (A1 5.1): claim a lease on the next ACTIVE ready Road of the executor's class (or the named Road),
// write the guard allowlist and return the class-shaped Worker packet. It composes the lease store, the Road readers, the readiness reader and
// `road-details`; it never activates a Road. The claim, the guard file and the packet are one journaled step under the repository lock.
import { createDefaultProviders } from '../../core/providers.js';
import { compareStrings, isId } from '../../schemas/common.js';
import { resolveProfile } from '../executors/index.js';
import { runJournaledMutation } from '../journal/index.js';
import { claimLease, readLease } from '../leases/index.js';
import { readReadiness, readRoadOnce } from '../lifecycle/index.js';
import { buildRoadDetails } from '../road-details/index.js';
import { RoadStoreError, listRoadFiles } from '../roads/repository.js';
import { openYield, readScope } from '../scope/index.js';
import { LEASE_CONTRACT_PROJECTION, commandSnapshot, computeSnapshot } from '../snapshots/index.js';
import { createTransactionRecovery } from '../transactions/index.js';
import { intentFinding, packetFactory, resolveWorker, unresolvedMessage } from './common.js';
import { compileGuard } from './guard-core.js';
import { INTENT_NEXT_COMMAND_BUILDERS } from './next-commands.js';
import { DONE_FLAGS, WORK_SCHEMA } from './policy.js';
import { guardFilePath, resetDoneFailures, writeGuardFile } from './sidecars.js';
import { createPathService } from '../path-service.js';

const builder = INTENT_NEXT_COMMAND_BUILDERS.work;

// What stops this Road from being worked by this holder, or null: -> { reason, subject, message } | null
async function refusalFor({ base, found, holder, executor, explicit }) {
  const { road } = found;
  if (found.meta_state !== 'declared') return { reason: 'road_unverified', subject: found.path, message: `The Road file ${found.path} does not verify (hand-edited or invalid), so it cannot be worked.` };
  if (road.status !== 'ACTIVE') {
    return { reason: 'not_active', subject: road.status, message: `Road ${road.id} is ${road.status}; only the Leader activates a Road (road activate), and work never does.` };
  }
  if (explicit && road.executor_class !== executor.class) {
    return {
      reason: 'class_mismatch', subject: road.executor_class,
      message: `Road ${road.id} is dispatched to class ${road.executor_class ?? 'none'} but ${holder} is class ${executor.class}; the Leader decides who works it.`,
    };
  }
  const scope = await readScope({ ...base, road: road.id });
  const yielded = openYield(scope.records, road.meta?.content_hash ?? null);
  if (yielded !== null) {
    return { reason: 'needs_split', subject: yielded.holder, message: `Road ${road.id} was yielded by ${yielded.holder} ("${yielded.reason}") and waits for the Leader to split or change it.` };
  }
  return null;
}

// options: { repositoryRoot, workflowRoot, road?, executorFlag?, takeover?, env?, rootArgs?, providers?, knownCommands, boundary?, lockOptions?, root? }
// -> { problem: 'road_missing' } | { outcome, packet }
export async function workIntent(options) {
  const {
    repositoryRoot, workflowRoot, road: requested = null, executorFlag, takeover = false, env = process.env, rootArgs = [],
    providers = createDefaultProviders(), knownCommands, boundary, lockOptions,
  } = options;
  if (requested !== null && !isId(requested)) throw new TypeError('road must be a valid ID');
  const root = options.root ?? repositoryRoot;
  const base = { repositoryRoot, workflowRoot };
  const make = packetFactory({ command: 'work', root, providers, knownCommands });
  const refused = ({ reason, road = null, subject = null, message, holder = null, choices = [], candidates = [], blockers = [], findings = null, next, snapshot = null }) => ({
    outcome: 'refused',
    packet: make({
      status: 'blocked', snapshot, next,
      data: { kind: 'work_blocked', packet_version: WORK_SCHEMA, reason, road, holder, subject, choices, candidates, blockers },
      findings: findings ?? [intentFinding({ road, intent: 'work', reason, subject, message })],
    }),
  });

  // 1. who is working
  const worker = await resolveWorker({ ...base, executorFlag, env });
  if (worker.status === 'executors_unusable') {
    return refused({ reason: 'executors_unusable', subject: worker.path, message: 'executors.json does not verify, so the class of the executor is unknown.', next: builder({ phase: 'refused', rootArgs }) });
  }
  if (worker.status === 'unresolved') {
    const { resolved } = worker;
    return refused({
      reason: 'holder_unresolved', road: requested, subject: resolved.supplied, choices: resolved.choices, message: unresolvedMessage(resolved),
      next: builder({ phase: 'choices', road: requested, choices: resolved.choices, rootArgs }),
    });
  }
  const { holder, executor, executors } = worker;

  // 2. which Road
  let found;
  const candidates = [];
  if (requested !== null) {
    try {
      found = await readRoadOnce({ ...base, id: requested });
    } catch (error) {
      if (!(error instanceof RoadStoreError)) throw error;
      return refused({ reason: 'road_ambiguous', road: requested, subject: requested, message: error.message, next: builder({ phase: 'refused', executor: holder, rootArgs }) });
    }
    if (found.problem === 'road_missing') return { problem: 'road_missing' };
    if (found.problem === 'road_ambiguous') {
      return refused({ reason: 'road_ambiguous', road: requested, subject: found.subject, message: `Road ${requested} exists in more than one file: ${found.subject}.`, next: builder({ phase: 'refused', executor: holder, rootArgs }) });
    }
    if (found.problem === 'road_unverified') {
      return refused({ reason: 'road_unverified', road: requested, subject: found.subject, message: `The Road file ${found.subject} does not verify (hand-edited or invalid), so it cannot be worked.`, next: builder({ phase: 'refused', executor: holder, rootArgs }) });
    }
    found = found.found;
    const stop = await refusalFor({ base, found, holder, executor, explicit: true });
    if (stop !== null) return refused({ ...stop, road: requested, holder, next: builder({ phase: 'refused', executor: holder, rootArgs }) });
  } else {
    const ids = (await listRoadFiles(base)).map(({ id }) => id);
    const taken = [];
    for (const id of ids) {
      let read;
      try {
        read = await readRoadOnce({ ...base, id });
      } catch (error) {
        if (!(error instanceof RoadStoreError)) throw error;
        continue;
      }
      if (read.found === undefined || read.found.meta_state !== 'declared') continue;
      const { road } = read.found;
      if (road.status !== 'ACTIVE' || road.executor_class !== executor.class) continue;
      const stop = await refusalFor({ base, found: read.found, holder, executor, explicit: false });
      if (stop !== null) {
        candidates.push({ road: id, reason: stop.reason, subject: stop.subject });
        continue;
      }
      const lease = await readLease({ ...base, kind: 'road', target: id });
      if (lease.status === 'held' && lease.lease.holder !== holder) {
        candidates.push({ road: id, reason: 'lease_held', subject: lease.lease.holder });
        continue;
      }
      if (lease.status === 'corrupt') {
        candidates.push({ road: id, reason: 'lease_corrupt', subject: lease.reason });
        continue;
      }
      const readiness = await readReadiness({ ...base, id, env, rootArgs });
      if (readiness.problem !== undefined || !readiness.ready) {
        candidates.push({ road: id, reason: 'not_ready', subject: readiness.blockers?.[0]?.reason ?? null });
        continue;
      }
      taken.push({ id, found: read.found, own: lease.status === 'held' });
    }
    taken.sort((left, right) => (left.own === right.own ? compareStrings(left.id, right.id) : (left.own ? -1 : 1)));
    if (taken.length === 0) {
      return refused({
        reason: 'no_ready_road', holder, subject: executor.class, candidates: candidates.sort((left, right) => compareStrings(left.road, right.road)),
        message: `No ACTIVE ready Road of class ${executor.class} is free for ${holder}; the Leader activates or releases one.`, next: builder({ phase: 'empty', executor: holder, rootArgs }),
      });
    }
    found = taken[0].found;
  }
  const id = found.road.id;

  // 3. the Worker packet must be readable before anything is claimed: a blocked packet claims nothing
  const before = await buildRoadDetails({ ...base, id, role: 'worker', env, rootArgs, holder });
  if (before.status === 'blocked') {
    return refused({
      reason: 'details_blocked', road: id, holder, findings: before.findings, message: 'The Worker packet is blocked.',
      blockers: before.findings.filter(({ detail }) => typeof detail?.reason === 'string').map(({ detail }) => ({ reason: detail.reason, subject: detail.subject ?? null })),
      next: before.nextCommands, snapshot: before.snapshot,
    });
  }

  // 4. the claim, the guard allowlist and the packet: one journaled step under the lock
  const leaseSnapshot = async () => (await commandSnapshot('work', { ...base, target: { road: id } })).snapshot;
  const recovery = createTransactionRecovery({ ...base, boundary });
  const service = await createPathService(base);
  const workflowFolder = service.workflow_relative_path === '' ? '.' : service.workflow_relative_path;
  const result = await runJournaledMutation({
    ...base,
    root,
    command: 'work',
    target: { road: id, plan: null },
    input: { road: id, holder, takeover },
    dedupe: 'none',
    providers,
    knownCommands,
    currentSnapshot: leaseSnapshot,
    lockOptions,
    recover: recovery.recover,
    sweep: recovery.sweep,
    async apply(context) {
      const tested = await computeSnapshot({ ...base, projections: LEASE_CONTRACT_PROJECTION, target: { road: id } });
      if (tested.status !== 'ok') {
        return make({
          status: 'blocked', snapshot: context.current_snapshot, requestId: context.request_id, next: builder({ phase: 'refused', executor: holder, rootArgs }),
          data: { kind: 'work_blocked', packet_version: WORK_SCHEMA, reason: 'snapshot_unstable', road: id, holder, subject: null, choices: [], candidates: [], blockers: [] },
          findings: [intentFinding({ road: id, intent: 'work', reason: 'snapshot_unstable', message: `Road ${id} was changing while its lease contract was measured; run work again.` })],
        });
      }
      const claim = await claimLease({
        ...base, kind: 'road', target: id, holder, snapshot: tested.snapshot, inventory: tested.inventory, requestId: context.request_id, takeover, heldLock: context.lock, providers,
      });
      if (claim.status === 'blocked') {
        return make({
          status: 'blocked', snapshot: tested.snapshot, requestId: context.request_id, next: builder({ phase: 'refused', executor: holder, rootArgs }),
          data: { kind: 'work_blocked', packet_version: WORK_SCHEMA, reason: 'lease_held', road: id, holder: claim.holder, subject: claim.holder, choices: [], candidates: [], blockers: [] },
          findings: [claim.finding],
        });
      }
      if (claim.status === 'corrupt') {
        return make({
          status: 'blocked', snapshot: tested.snapshot, requestId: context.request_id, next: builder({ phase: 'refused', executor: holder, rootArgs }),
          data: { kind: 'work_blocked', packet_version: WORK_SCHEMA, reason: 'lease_corrupt', road: id, holder: null, subject: claim.reason, choices: [], candidates: [], blockers: [] },
          findings: [intentFinding({ road: id, intent: 'work', reason: 'lease_corrupt', subject: claim.reason, message: `The lease of ${id} is unreadable (${claim.reason}); the Leader releases it, or take it over explicitly with --takeover.` })],
        });
      }
      let action = 'claimed';
      if (claim.status === 'taken_over') action = 'taken_over';
      else if (claim.status === 'noop') action = claim.refreshed ? 'refreshed' : 'unchanged';
      const guard = compileGuard({ road: id, holder, workflow: workflowFolder, writes: found.road.writes, forbidden: found.road.forbidden });
      await writeGuardFile({ ...base, guard });
      if (action === 'claimed' || action === 'taken_over') await resetDoneFailures({ ...base, road: id, holder });
      const details = await buildRoadDetails({ ...base, id, role: 'worker', env, rootArgs, holder });
      const profile = found.road.executor_class === null ? null : resolveProfile(found.road.executor_class, executors.class_overrides);
      const warning = details.status === 'warning' || details.status === 'blocked';
      return make({
        status: action === 'unchanged' && !warning ? 'noop' : (warning ? 'warning' : 'ok'),
        snapshot: tested.snapshot,
        requestId: context.request_id,
        data: {
          kind: 'work',
          packet_version: WORK_SCHEMA,
          executor: { id: holder, class: executor.class, source: worker.source },
          road: id,
          claim: { action, previous_holder: claim.previous_holder ?? null },
          guard: { path: guardFilePath(id), writes: guard.writes.length, forbidden: guard.forbidden.length },
          done: { requires: [...DONE_FLAGS], failures_before_yield: profile === null ? null : profile.done_failures_before_yield },
          details: details.data,
        },
        findings: details.findings,
        next: builder({ phase: 'claimed', road: id, rootArgs }),
      });
    },
  });
  return { outcome: result.outcome, packet: result.packet };
}
