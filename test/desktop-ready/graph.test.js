// P2-W17 / F22: the complete workflow graph. Frozen decisions first, then coverage of every Plan, Road, Task and verification, the four edge
// kinds, the Tester and lease attributes the board needs, and byte-stable ordering independent of creation order and operating system.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  GRAPH_EDGE_TYPES, GRAPH_ID_PREFIXES, GRAPH_LEASE_STATES, GRAPH_NODE_KEYS, GRAPH_NODE_TYPES, GRAPH_POLICY, GRAPH_SCHEMA, GRAPH_TESTER_STATES,
} from '../../lib/store/navigation/policy.js';
import { validateGraph } from '../../lib/schemas/navigation.js';
import { claimRoad, closableWorld, navWorld, query, runCommand } from '../navigation/support.js';
import { createRepo, fileWrite, seedWithTask } from '../road-details/support.js';
import { seedPlan } from '../road/support.js';
import { fakeProviders, treeDigest } from './support.js';

const GOLDEN = fileURLToPath(new URL('./golden/graph.json', import.meta.url));
const graph = async (repo, extra = []) => {
  const out = await query(repo, ['graph', ...extra]);
  assert.equal(out.exitCode, 0, out.text);
  assert.equal(validateGraph(out.packet.data).ok, true, JSON.stringify(validateGraph(out.packet.data).issues));
  return out.packet.data;
};
const edgesOf = (data, type) => data.edges.filter((edge) => edge.type === type).map(({ from, to }) => `${from}>${to}`);
const nodeOf = (data, id) => data.nodes.find((node) => node.id === id);

test('F22 freezes the node and edge kinds, the id scheme, the attribute keys and the ordering', () => {
  assert.equal(GRAPH_SCHEMA, 'akrs.graph/v1');
  assert.deepEqual([...GRAPH_NODE_TYPES], ['plan', 'road', 'task', 'verification']);
  assert.deepEqual([...GRAPH_EDGE_TYPES], ['block', 'collision', 'dep', 'touch']);
  assert.deepEqual([...GRAPH_NODE_KEYS], ['id', 'type', 'status', 'class', 'lease', 'needs_split', 'plan', 'tester']);
  assert.deepEqual([...GRAPH_TESTER_STATES], ['failed', 'not_required', 'passed', 'ready_for_test', 'stale', 'testing', 'unverified']);
  assert.deepEqual([...GRAPH_LEASE_STATES], ['fresh', 'stale', 'unreadable']);
  assert.deepEqual({ ...GRAPH_ID_PREFIXES }, { plan: '', road: '', task: '', verification: 'verification:' });
  assert.equal(Object.isFrozen(GRAPH_POLICY), true);
  for (const key of ['coverage', 'ids', 'ordering', 'touches', 'consumers']) assert.ok(GRAPH_POLICY[key].length > 40, key);
  assert.deepEqual(Object.keys(GRAPH_POLICY.attributes), ['plan', 'road', 'task', 'verification']);
  assert.deepEqual(Object.keys(GRAPH_POLICY.edges), ['dep', 'block', 'touch', 'collision']);
  assert.match(GRAPH_POLICY.ordering, /code point/);
});

test('every node carries exactly the frozen keys', async (t) => {
  const repo = await navWorld(t);
  const data = await graph(repo);
  for (const node of data.nodes) assert.deepEqual(Object.keys(node).sort(), [...GRAPH_NODE_KEYS].sort(), node.id);
  for (const edge of data.edges) assert.deepEqual(Object.keys(edge).sort(), ['certainty', 'from', 'to', 'type']);
});

test('a Plan node carries its closure, its Tester state and its Tester lease slot; a Road node its class and lease', async (t) => {
  const repo = await navWorld(t);
  await claimRoad(repo, 'R-P6-1', 'flash');
  const data = await graph(repo);
  const plan = nodeOf(data, 'P6');
  assert.equal(plan.type, 'plan');
  assert.ok(GRAPH_TESTER_STATES.includes(plan.tester), plan.tester);
  assert.equal(plan.lease, null);
  assert.deepEqual([plan.class, plan.needs_split, plan.plan], [null, null, null]);
  const road = nodeOf(data, 'R-P6-1');
  assert.deepEqual([road.status, road.class, road.lease, road.tester], ['ACTIVE', 'weak', { holder: 'flash', state: 'fresh' }, null]);
});

test('a closed-on-proof world reports the Tester state passed on the Plan node', async (t) => {
  const repo = await closableWorld(t);
  const data = await graph(repo);
  assert.equal(nodeOf(data, 'P6').tester, 'passed');
  assert.equal(nodeOf(data, 'verification:P6').plan, 'P6');
});

test('a Task file without a Road is still a node, with no edge', async (t) => {
  const repo = await navWorld(t);
  await repo.write('akrs/tasks/T-orphan.md', '# T-orphan\n');
  const data = await graph(repo);
  const orphan = nodeOf(data, 'T-orphan');
  assert.deepEqual([orphan.type, orphan.plan], ['task', null]);
  assert.equal(data.edges.some(({ from, to }) => from === 'T-orphan' || to === 'T-orphan'), false);
  assert.equal(nodeOf(data, 'T-P6-1').plan, 'P6', 'the Task of a Road follows its Plan');
});

test('a Road without a Plan owns its verification: node verification:<road> and a touch edge from the Road', async (t) => {
  const repo = await createRepo(t);
  await seedWithTask(repo, { id: 'R1', plan: null, task: 'T1', deps: [], executor_class: 'medium', writes: [fileWrite('src/a.js')] }, { status: 'QUEUED' });
  await repo.write('akrs/verifications/R1/contract.json', '{ "not": "a contract" }\n');
  const data = await graph(repo);
  const verification = nodeOf(data, 'verification:R1');
  assert.deepEqual([verification.type, verification.status, verification.plan], ['verification', 'unverified', null]);
  assert.ok(edgesOf(data, 'touch').includes('R1>verification:R1'));
  assert.ok(edgesOf(data, 'touch').includes('R1>T1'));
});

test('--touches keeps the verification of a kept Road without a Plan', async (t) => {
  const repo = await createRepo(t);
  await seedWithTask(repo, { id: 'R1', plan: null, task: 'T1', deps: [], executor_class: 'medium', writes: [fileWrite('src/a.js')] }, { status: 'QUEUED' });
  await seedWithTask(repo, { id: 'R2', plan: null, task: 'T2', deps: [], executor_class: 'medium', writes: [fileWrite('src/b.js')] }, { status: 'QUEUED' });
  await repo.write('akrs/verifications/R1/contract.json', '{ "not": "a contract" }\n');
  const data = await graph(repo, ['--touches', 'src/a.js']);
  assert.deepEqual(data.nodes.map(({ id }) => id), ['R1', 'T1', 'verification:R1']);
  assert.deepEqual(data.edges.map(({ from, to, type }) => `${type}:${from}>${to}`), ['touch:R1>T1', 'touch:R1>verification:R1']);
});

test('the four edge kinds all appear in one workflow', async (t) => {
  const repo = await navWorld(t);
  const data = await graph(repo);
  for (const type of ['dep', 'block', 'touch']) assert.ok(edgesOf(data, type).length > 0, type);
  assert.deepEqual(edgesOf(data, 'dep'), ['R-P6-1>R-P5-6', 'R-P6-2>R-P6-1', 'R-P6-3>R-P5-6']);
  assert.deepEqual(edgesOf(data, 'block'), ['R-P6-1>R-P6-2']);
  await seedWithTask(repo, { id: 'R-P6-4', task: 'T-P6-4', deps: ['R-P5-6'], executor_class: 'medium', writes: [fileWrite('src/own.js')] }, { status: 'QUEUED' });
  assert.deepEqual(edgesOf(await graph(repo), 'collision'), ['R-P6-1>R-P6-4']);
});

test('the graph is a query: it writes nothing', async (t) => {
  const repo = await navWorld(t);
  const before = await treeDigest(repo);
  await graph(repo);
  await graph(repo, ['--touches', 'src/own.js']);
  assert.deepEqual(await treeDigest(repo), before);
});

// ---- ordering ---------------------------------------------------------------------------------------------------------
const ROADS = [
  { id: 'R-Z-1', task: 'T-Z-1', deps: [], writes: [fileWrite('src/z.js')] },
  { id: 'R-A-1', task: 'T-A-1', deps: ['R-Z-1'], writes: [fileWrite('src/a.js')] },
  { id: 'R-M-1', task: 'T-M-1', deps: ['R-Z-1', 'R-A-1'], writes: [fileWrite('src/z.js', 'modify')] },
  { id: 'R-B-1', task: 'T-B-1', deps: [], writes: [fileWrite('src/b.js')] },
];

async function buildInOrder(t, order) {
  const repo = await createRepo(t);
  repo.providers = fakeProviders();
  await seedPlan(repo, 'P9');
  await seedPlan(repo, 'P1');
  for (const index of order) await seedWithTask(repo, { ...ROADS[index], plan: index % 2 === 0 ? 'P9' : 'P1', executor_class: 'medium' }, { status: 'QUEUED' });
  await repo.write('akrs/tasks/T-orphan.md', '# orphan\n');
  return repo;
}

test('the graph bytes do not depend on creation order, run, or root path', async (t) => {
  const first = await graph(await buildInOrder(t, [0, 1, 2, 3]));
  const second = await graph(await buildInOrder(t, [3, 2, 1, 0]));
  const third = await graph(await buildInOrder(t, [2, 0, 3, 1]));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(first), JSON.stringify(third));
  const ids = first.nodes.map(({ id }) => id);
  assert.deepEqual(ids, [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  const keys = first.edges.map(({ type, from, to }) => `${type}\u0000${from}\u0000${to}`);
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(JSON.stringify(first).includes(':\\\\'), false, 'no absolute path in the packet');
});

test('a golden graph pins the exact bytes on every operating system', async (t) => {
  const repo = await buildInOrder(t, [1, 3, 0, 2]);
  const text = `${JSON.stringify(await graph(repo), null, 2)}\n`;
  if (process.env.AKRS_REGENERATE_DESKTOP_GOLDEN === '1') await writeFile(GOLDEN, text);
  assert.equal(text, (await readFile(GOLDEN, 'utf8')).replaceAll('\r\n', '\n'));
});

test('the human rendering shows the Tester state of a Plan node', async (t) => {
  const repo = await navWorld(t);
  const out = await runCommand(repo, ['graph']);
  assert.match(out.stdout, /plan P6 \[[a-z_]+\], Tester [a-z_]+/);
});
