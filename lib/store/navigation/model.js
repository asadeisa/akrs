// The workflow model the navigation queries share (P2-W09): one read-only composition of the existing projections. Nothing is rebuilt
// from prose; a source that does not verify is counted, never dropped silently. It writes nothing, not even a lease.
//
// readWorkflowModel({ repositoryRoot, workflowRoot, env?, rootArgs? }) -> {
//   state, executors, executors_state, roads (declared, sorted), unverified_roads, plans (sorted), closures, pending, envelope_grants, issues }
import { compareStrings } from '../../schemas/common.js';
import { readExecutors } from '../executors/index.js';
import { readLog } from '../log/repository.js';
import { readPlan } from '../plan-finish/repository.js';
import { createPathService } from '../path-service.js';
import { buildRoadDetails } from '../road-details/index.js';
import { RoadStoreError, listRoadFiles, readRoad } from '../roads/repository.js';
import { readAllRequests } from '../scope/repository.js';
import { readState } from '../state/repository.js';
import { buildTesterPacket } from '../test-details/index.js';
import { readContract, readResults } from '../verification/index.js';

const byId = (left, right) => compareStrings(left.id, right.id);

async function readRoads({ repositoryRoot, workflowRoot, env, rootArgs }) {
  const base = { repositoryRoot, workflowRoot };
  const roads = [];
  const unverified = [];
  for (const { id, path } of await listRoadFiles(base)) {
    let found = null;
    try {
      found = await readRoad({ ...base, id });
    } catch (error) {
      if (!(error instanceof RoadStoreError)) throw error;
    }
    if (found === null || found.meta_state !== 'declared') {
      unverified.push({ id, path: found?.path ?? path });
      continue;
    }
    const { road } = found;
    const leader = await buildRoadDetails({ ...base, id, role: 'leader', env, rootArgs });
    const data = leader.problem === undefined && leader.data.kind === 'road_details' ? leader.data : null;
    roads.push({
      id,
      plan: road.plan ?? null,
      task: road.task ?? null,
      status: road.status,
      executor_class: road.executor_class ?? null,
      deps: [...road.deps],
      reads: road.reads.map(({ path: readPath, lines, why }) => ({ path: readPath, lines: lines === null ? null : [...lines], why })),
      writes: road.writes.map(({ path: writePath, class: pathClass, action }) => ({ path: writePath, class: pathClass, action })),
      path: found.path,
      ready: data === null ? false : data.readiness.ready,
      blockers: data === null ? [{ reason: 'road_unverified', subject: found.path }] : data.readiness.blockers.map(({ reason, subject }) => ({ reason, subject })),
      needs_split: data === null ? false : data.needs_split === true,
      lease: data === null ? { holder: null, state: 'none' } : { holder: data.lease.holder, state: data.lease.state },
    });
  }
  return { roads: roads.sort(byId), unverified: unverified.sort(byId) };
}

async function readPlans({ repositoryRoot, workflowRoot, env, rootArgs, roads }) {
  const base = { repositoryRoot, workflowRoot };
  const service = await createPathService(base);
  const keys = new Set(roads.map(({ plan }) => plan).filter((plan) => plan !== null));
  for (const path of await service.walkWorkflowFiles('plans')) {
    const match = /\/plans\/([^/]+)\.json$/.exec(`/${path}`);
    if (match !== null) keys.add(match[1]);
  }
  const plans = [];
  for (const key of [...keys].sort(compareStrings)) {
    const file = await readPlan({ ...base, key });
    let closure = 'missing_file';
    if (file.exists) closure = file.meta_state === 'declared' ? file.plan.closure.status : 'unverified';
    const packet = await buildTesterPacket({ ...base, key, env, rootArgs });
    const contract = await readContract({ ...base, key });
    const results = await readResults({ ...base, key });
    plans.push({
      id: key,
      file,
      closure,
      packet: packet.problem === undefined ? packet : null,
      contract,
      results: results.records.map(({ value }) => value),
      roads: roads.filter(({ plan }) => plan === key),
    });
  }
  return plans;
}

export async function readWorkflowModel({ repositoryRoot, workflowRoot, env = process.env, rootArgs = [] }) {
  const base = { repositoryRoot, workflowRoot };
  const executorsRead = await readExecutors(base);
  const { roads, unverified } = await readRoads({ ...base, env, rootArgs });
  const plans = await readPlans({ ...base, env, rootArgs, roads });
  const log = await readLog(base);
  const scope = await readAllRequests(base);
  const stateRead = await readState(base);
  return {
    state: stateRead.meta_state === 'declared' ? stateRead.state : null,
    state_read: stateRead,
    executors: executorsRead.executors.map(({ id, role, class: cls }) => ({ id, role, class: cls ?? null })).sort(byId),
    executors_read: executorsRead,
    roads,
    unverified_roads: unverified,
    plans,
    closures: log.records,
    log,
    requests: scope.requests,
    pending: scope.requests.filter(({ state }) => state === 'pending').map(({ id, road, blocking }) => ({ id, road, blocking })),
    envelope_grants: scope.requests.filter(({ resolution }) => resolution !== null && resolution.granted_by === 'envelope').length,
    issues: { scope: scope.issues, log: log.issues },
  };
}

// The closure state shown for a Plan and the Tester state with it: a closed Plan keeps the proof it was closed on (see
// NAVIGATION_POLICY.closed_plan), the others the live current-result projection.
export function testerOf(plan) {
  if (plan.packet === null) return { state: 'unverified', required: true, latest: null };
  if (plan.packet.data.kind === 'test_details_blocked') return { state: 'unverified', required: true, latest: null };
  const live = plan.packet.data.result;
  if (plan.closure === 'closed' && plan.results.at(-1)?.verdict === 'pass') return { state: 'passed', required: live.required, latest: live.latest };
  return live;
}
