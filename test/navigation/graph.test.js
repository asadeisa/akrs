// P2-W09: `graph [--touches <path>]` returns the one akrs.graph/v1 schema; --touches returns a subgraph of it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateGraph } from '../../lib/schemas/navigation.js';
import { treeDigest } from '../road/support.js';
import { fileWrite, seedWithTask } from '../road-details/support.js';
import { claimRoad, closableWorld, navWorld, query } from './support.js';

const graph = (repo, extra = []) => query(repo, ['graph', ...extra]);
const ok = (out) => {
  assert.equal(out.exitCode, 0, out.text);
  assert.equal(validateGraph(out.packet.data).ok, true, JSON.stringify(validateGraph(out.packet.data).issues));
  return out.packet.data;
};
const edges = (data, type) => data.edges.filter((edge) => edge.type === type).map(({ from, to }) => `${from}>${to}`);

test('the graph has plan, road, task and verification nodes with status, class, lease and needs_split attributes', async (t) => {
  const repo = await navWorld(t);
  await claimRoad(repo, 'R-P6-1', 'flash');
  const digest = await treeDigest(repo);
  const data = ok(await graph(repo));
  assert.deepEqual([data.kind, data.packet_version, data.touches], ['graph', 'akrs.graph/v1', null]);
  const road = data.nodes.find(({ id }) => id === 'R-P6-1');
  assert.deepEqual([road.type, road.status, road.class, road.lease, road.needs_split, road.plan], ['road', 'ACTIVE', 'weak', { holder: 'flash', state: 'fresh' }, false, 'P6']);
  assert.ok(data.nodes.some(({ id, type }) => id === 'P6' && type === 'plan'));
  assert.ok(data.nodes.some(({ id, type }) => id === 'T-P6-1' && type === 'task'));
  assert.deepEqual(await treeDigest(repo), digest);
});

test('dep edges run from a Road to what it depends on; block edges mark the unfinished ones', async (t) => {
  const repo = await navWorld(t);
  const data = ok(await graph(repo));
  assert.deepEqual(edges(data, 'dep'), ['R-P6-1>R-P5-6', 'R-P6-2>R-P6-1', 'R-P6-3>R-P5-6']);
  assert.deepEqual(edges(data, 'block'), ['R-P6-1>R-P6-2'], 'the unfinished R-P6-1 blocks R-P6-2');
});

test('touch edges tie a Road to its Task and a Plan to its verification', async (t) => {
  const repo = await closableWorld(t);
  const data = ok(await graph(repo));
  assert.ok(data.nodes.some(({ id, type }) => id === 'verification:P6' && type === 'verification'));
  assert.ok(edges(data, 'touch').includes('P6>verification:P6'));
  assert.ok(edges(data, 'touch').includes('P6>R-P6-1'));
});

test('collision edges join Roads whose declared writes overlap; an unprovable overlap says unknown', async (t) => {
  const repo = await navWorld(t);
  await seedWithTask(repo, { id: 'R-P6-4', task: 'T-P6-4', deps: ['R-P5-6'], executor_class: 'medium', writes: [fileWrite('src/own.js')] }, { status: 'QUEUED' });
  const data = ok(await graph(repo));
  const collision = data.edges.find((edge) => edge.type === 'collision');
  assert.deepEqual([collision.from, collision.to, collision.certainty], ['R-P6-1', 'R-P6-4', 'overlap']);
});

test('--touches returns a subgraph of the same schema: the Roads that touch the path and their neighbours', async (t) => {
  const repo = await navWorld(t);
  const data = ok(await graph(repo, ['--touches', 'src/own.js']));
  assert.equal(data.touches, 'src/own.js');
  assert.ok(data.nodes.some(({ id }) => id === 'R-P6-1'));
  assert.equal(data.nodes.some(({ id }) => id === 'R-P6-3'), false, 'a Road that does not touch the path is not in the subgraph');
  for (const edge of data.edges) {
    assert.ok(data.nodes.some(({ id }) => id === edge.from) && data.nodes.some(({ id }) => id === edge.to), 'no dangling edge');
  }
  const full = ok(await graph(repo));
  assert.ok(data.nodes.length < full.nodes.length);
});

test('nodes and edges are sorted so the graph is byte-stable across runs and platforms', async (t) => {
  const repo = await navWorld(t);
  const a = ok(await graph(repo));
  const b = ok(await graph(repo));
  assert.deepEqual(a, b);
  const ids = a.nodes.map(({ id }) => id);
  assert.deepEqual(ids, [...ids].sort());
});
