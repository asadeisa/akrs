// `graph [--touches <path>]` (P2-W09): the one akrs.graph/v1 schema. `--touches` returns a subgraph of it. Read only.
import { compareStrings } from '../../schemas/common.js';
import { GRAPH_SCHEMA } from './policy.js';
import { matchOf, strongest } from './paths.js';
import { touchingRoads } from './where.js';

const edgeOrder = (left, right) => compareStrings(left.type, right.type) || compareStrings(left.from, right.from) || compareStrings(left.to, right.to);

export function buildGraphData(model, { touches = null } = {}) {
  const nodes = new Map();
  const edges = [];
  const node = (entry) => nodes.set(entry.id, { status: null, class: null, lease: null, needs_split: null, plan: null, ...entry });
  const edge = (from, to, type, certainty = null) => edges.push({ from, to, type, certainty });
  const byId = new Map(model.roads.map((road) => [road.id, road]));

  for (const plan of model.plans) {
    node({ id: plan.id, type: 'plan', status: plan.closure });
    if (plan.contract.exists) {
      node({ id: `verification:${plan.id}`, type: 'verification', status: plan.contract.meta_state === 'declared' ? plan.contract.contract.policy : 'unverified', plan: plan.id });
      edge(plan.id, `verification:${plan.id}`, 'touch');
    }
  }
  for (const road of model.roads) {
    node({ id: road.id, type: 'road', status: road.status, class: road.executor_class, lease: road.lease.state === 'none' ? null : { holder: road.lease.holder, state: road.lease.state }, needs_split: road.needs_split, plan: road.plan });
    if (road.plan !== null && nodes.has(road.plan)) edge(road.plan, road.id, 'touch');
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
        if (nodes.has(`verification:${road.plan}`)) keep.add(`verification:${road.plan}`);
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
