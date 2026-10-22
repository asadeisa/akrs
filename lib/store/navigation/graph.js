// `graph [--touches <path>]` (P2-W09, frozen again as F22 in P2-W17): the one akrs.graph/v1 schema over the whole workflow.
// `--touches` returns a subgraph of it. Read only. See GRAPH_POLICY for ids, attributes, edges and ordering.
import { compareStrings } from '../../schemas/common.js';
import { GRAPH_ID_PREFIXES, GRAPH_SCHEMA } from './policy.js';
import { matchOf, strongest } from './paths.js';
import { testerOf } from './model.js';
import { touchingRoads } from './where.js';

const edgeOrder = (left, right) => compareStrings(left.type, right.type) || compareStrings(left.from, right.from) || compareStrings(left.to, right.to);
const leaseOf = (lease) => (lease === undefined || lease === null || lease.state === 'none' ? null : { holder: lease.holder ?? null, state: ['fresh', 'stale'].includes(lease.state) ? lease.state : 'unreadable' });

export function buildGraphData(model, { touches = null } = {}) {
  const nodes = new Map();
  const edges = [];
  // the first node to claim an ID keeps it (plan, road, task, verification, in that order of insertion)
  const node = (entry) => {
    if (!nodes.has(entry.id)) nodes.set(entry.id, { id: entry.id, type: entry.type, status: null, class: null, lease: null, needs_split: null, plan: null, tester: null, ...entry });
  };
  const edge = (from, to, type, certainty = null) => edges.push({ from, to, type, certainty });
  const byId = new Map(model.roads.map((road) => [road.id, road]));
  const verificationId = (key) => `${GRAPH_ID_PREFIXES.verification}${key}`;

  for (const plan of model.plans) {
    node({ id: plan.id, type: 'plan', status: plan.closure, tester: testerOf(plan).state, lease: leaseOf(plan.packet?.data.lease) });
  }
  for (const road of model.roads) {
    node({ id: road.id, type: 'road', status: road.status, class: road.executor_class, lease: leaseOf(road.lease), needs_split: road.needs_split, plan: road.plan });
  }
  for (const road of model.roads) {
    if (road.plan !== null && nodes.get(road.plan)?.type === 'plan') edge(road.plan, road.id, 'touch');
    if (road.task !== null) {
      node({ id: road.task, type: 'task', plan: road.plan });
      edge(road.id, road.task, 'touch');
    }
    for (const dependency of road.deps) {
      if (!byId.has(dependency)) continue;
      edge(road.id, dependency, 'dep');
      if (byId.get(dependency).status !== 'DONE') edge(dependency, road.id, 'block');
    }
  }
  for (const taskId of model.task_ids ?? []) node({ id: taskId, type: 'task' });
  for (const { key, plan, contract } of model.verifications ?? []) {
    const id = verificationId(key);
    node({ id, type: 'verification', status: contract.meta_state === 'declared' ? contract.contract.policy : 'unverified', plan });
    if (plan !== null && nodes.get(plan)?.type === 'plan') edge(plan, id, 'touch');
    else if (plan === null && byId.has(key)) edge(key, id, 'touch');
  }
  const open = model.roads.filter(({ status }) => status !== 'DONE');
  for (let first = 0; first < open.length; first += 1) {
    for (let second = first + 1; second < open.length; second += 1) {
      const matches = [];
      for (const left of open[first].writes) for (const right of open[second].writes) matches.push(matchOf(left.path, left.class, right.path, right.class));
      const best = strongest(matches);
      if (best !== null) edge(open[first].id, open[second].id, 'collision', best === 'unknown' ? 'unknown' : 'overlap');
    }
  }

  let keep = null;
  if (touches !== null) {
    const touching = touchingRoads(model, touches);
    keep = new Set(touching);
    for (const entry of edges) {
      if (['dep', 'block', 'collision'].includes(entry.type)) {
        if (touching.has(entry.from)) keep.add(entry.to);
        if (touching.has(entry.to)) keep.add(entry.from);
      }
    }
    for (const id of [...keep]) {
      const road = byId.get(id);
      if (road === undefined) continue;
      if (road.task !== null) keep.add(road.task);
      if (road.plan !== null) {
        keep.add(road.plan);
        if (nodes.has(verificationId(road.plan))) keep.add(verificationId(road.plan));
      } else if (nodes.has(verificationId(road.id))) {
        keep.add(verificationId(road.id));
      }
    }
  }
  const visible = (id) => keep === null || keep.has(id);
  return {
    kind: 'graph',
    packet_version: GRAPH_SCHEMA,
    touches,
    nodes: [...nodes.values()].filter(({ id }) => visible(id)).sort((left, right) => compareStrings(left.id, right.id)),
    edges: edges.filter(({ from, to }) => visible(from) && visible(to)).sort(edgeOrder),
  };
}
