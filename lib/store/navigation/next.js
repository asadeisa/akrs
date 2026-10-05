// `next` (P2-W09): the legal actions, in a frozen order, with explicit blocked and empty states. Every command is a manifest command
// that runs as it is. Read only.
import { compareStrings } from '../../schemas/common.js';
import { commandSnapshot } from '../snapshots/index.js';
import { NEXT_SCHEMA } from './policy.js';
import { testerOf } from './model.js';

const action = (kind, subject, command, args, why) => ({ kind, subject, command, args, why });
const REASON = (entries) => entries.map(({ reason, subject }) => ({ reason, subject: subject ?? null }));

// executor: null | { id, role, class }. -> { data, next: [{ command, args }] }
export async function buildNextData(model, { repositoryRoot, workflowRoot, executor = null }) {
  const base = { repositoryRoot, workflowRoot };
  const actions = [];
  const blocked = [];
  const takes = (road) => executor === null || (executor.role === 'worker' && road.executor_class === executor.class);
  const forLeader = executor === null || executor.role === 'leader';
  const forTester = executor === null || executor.role === 'tester';

  // 1. pending scope requests are a Leader decision
  if (forLeader) {
    for (const road of [...new Set(model.pending.map(({ road: id }) => id))]) {
      const requests = model.pending.filter((entry) => entry.road === road);
      actions.push(action('decide_scope', road, 'scope-list', ['--road', road], `${requests.length} pending scope request${requests.length === 1 ? '' : 's'}${requests.some(({ blocking }) => blocking) ? ', at least one blocking' : ''}: the Leader decides.`));
    }
  }

  // 2. Roads: QUEUED first (the Leader's dispatch), then ACTIVE (the Worker's)
  for (const road of model.roads.filter(({ status }) => status === 'QUEUED')) {
    if (!forLeader && !takes(road)) continue;
    if (!road.ready) {
      blocked.push({ kind: 'road', subject: road.id, reasons: REASON(road.blockers) });
    } else {
      const snapshot = (await commandSnapshot('road-activate', { ...base, target: { road: road.id } })).snapshot;
      actions.push(action('activate', road.id, 'road-activate', [road.id, '--if-snapshot', snapshot], 'The Road is ready: the Leader makes it dispatchable.'));
    }
  }
  for (const road of model.roads.filter((entry) => entry.status === 'ACTIVE' && takes(entry))) {
    if (road.lease.state === 'fresh') actions.push(action('finish_road', road.id, 'road-check', [road.id], `${road.lease.holder} holds a fresh lease: road check names the legal transitions.`));
    else actions.push(action('work', road.id, 'work', [road.id, ...(executor === null ? [] : ['--executor', executor.id])], 'The Road is ACTIVE and nobody holds it: claim it and read the Worker packet.'));
  }

  // 3. the Tester loop of every Plan whose Roads are all DONE
  if (forTester) {
    for (const plan of model.plans) {
      if (plan.closure === 'closed' || plan.roads.length === 0 || plan.roads.some(({ status }) => status !== 'DONE')) continue;
      const tester = testerOf(plan);
      const runnable = plan.packet !== null && plan.packet.data.kind === 'test_details' && ['live', 'measured'].includes(plan.packet.data.policy) && plan.packet.data.scenario.length > 0;
      if (tester.state === 'passed') actions.push(action('close_plan', plan.id, 'plan-finish', [plan.id, '--dry-run'], 'The latest Tester result is a current pass: preview the close.'));
      else if (tester.state === 'ready_for_test' || tester.state === 'stale') {
        actions.push(runnable
          ? action('run_tests', plan.id, 'test-run', [plan.id], tester.state === 'stale' ? 'The pass is stale: run the scenario again.' : 'The Plan is ready for the Tester: run the scenario.')
          : action('inspect', plan.id, 'test-details', [plan.id], tester.state === 'stale' ? 'The pass is stale: read the packet and test again.' : 'The Plan is ready for the Tester: read the packet.'));
      } else if (tester.state === 'testing' || tester.state === 'failed') {
        actions.push(action('inspect', plan.id, 'test-details', [plan.id], tester.state === 'failed' ? 'The latest result is a fail: read the packet and its findings.' : 'A test is under way: read the packet and record the result.'));
      } else if (tester.state === 'unverified') {
        blocked.push({ kind: 'plan', subject: plan.id, reasons: REASON(plan.packet?.data.blockers ?? [{ reason: 'contract_missing', subject: plan.id }]) });
      }
    }
  }

  const empty = actions.length > 0 ? null : { reason: blocked.length > 0 ? 'blocked' : 'nothing_to_do' };
  return {
    data: {
      kind: 'next',
      packet_version: NEXT_SCHEMA,
      executor: executor === null ? null : { id: executor.id, role: executor.role, class: executor.class },
      actions,
      blocked: blocked.sort((left, right) => compareStrings(left.kind, right.kind) || compareStrings(left.subject, right.subject)),
      empty,
    },
    next: actions.map(({ command, args }) => ({ command, args })),
  };
}
