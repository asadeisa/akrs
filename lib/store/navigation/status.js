// `status` (P2-W09): the whole workflow state in one packet, composed from the shared model. Read only.
import { compareStrings } from '../../schemas/common.js';
import { STATUS_SCHEMA } from './policy.js';
import { testerOf } from './model.js';

const byLeaseOrder = (left, right) => compareStrings(left.kind, right.kind) || compareStrings(left.target, right.target);

export function buildStatusData(model) {
  const byStatus = { ACTIVE: 0, DONE: 0, QUEUED: 0 };
  for (const road of model.roads) byStatus[road.status] += 1;
  const queued = model.roads.filter(({ status }) => status === 'QUEUED');
  const leases = [];
  for (const road of model.roads) {
    if (road.lease.state !== 'none') leases.push({ kind: 'road', target: road.id, holder: road.lease.holder, state: road.lease.state === 'fresh' ? 'fresh' : (road.lease.state === 'stale' ? 'stale' : 'unreadable') });
  }
  for (const plan of model.plans) {
    const lease = plan.packet?.data.lease;
    if (lease !== undefined && lease.state !== 'none') leases.push({ kind: 'plan', target: plan.id, holder: lease.holder, state: lease.state === 'fresh' || lease.state === 'stale' ? lease.state : 'unreadable' });
  }
  const last = model.closures.filter(({ meta_state: state }) => state === 'declared').at(-1) ?? null;
  return {
    kind: 'status',
    packet_version: STATUS_SCHEMA,
    state: model.state === null ? null : { mode: model.state.mode, role: model.state.role, plan: model.state.plan, phase: model.state.phase, task: model.state.task, next: model.state.next },
    roads: {
      total: model.roads.length,
      by_status: byStatus,
      unverified: model.unverified_roads.length,
      ready: queued.filter(({ ready }) => ready).map(({ id }) => id),
      blocked: queued.filter(({ ready }) => !ready).map(({ id }) => id),
      needs_split: model.roads.filter(({ needs_split: split }) => split).map(({ id }) => id),
      class_fit_blockers: model.roads.flatMap((road) => road.blockers.filter(({ reason }) => reason === 'class_fit').map(({ subject }) => ({ road: road.id, reason: subject ?? 'unknown' }))),
    },
    plans: model.plans.map((plan) => {
      const tester = testerOf(plan);
      return {
        id: plan.id,
        roads: { total: plan.roads.length, done: plan.roads.filter(({ status }) => status === 'DONE').length },
        tester: { state: tester.state, required: tester.required, latest: tester.latest === null ? null : { id: tester.latest.id, ts: tester.latest.ts, verdict: tester.latest.verdict, current: tester.latest.current } },
        closure: plan.closure,
      };
    }),
    executors: model.executors,
    leases: leases.sort(byLeaseOrder),
    scope: { pending: model.pending, envelope_grants: model.envelope_grants },
    closures: { total: model.closures.length, last: last === null ? null : { id: last.id, ts: last.ts, kind: last.kind, subject: last.subject, outcome: last.outcome } },
  };
}
