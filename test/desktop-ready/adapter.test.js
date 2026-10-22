// P2-W17: a test adapter drives everything the desktop app will need through the public core exports only (lib/core/index.js): no binary, no
// terminal text, no deep import. The adapter calls handlers with plain objects and gets plain packets back.
import assert from 'node:assert/strict';
import { readFile, readdir, rm } from 'node:fs/promises';
import { test } from 'node:test';
import {
  CONFIG_HOME_ENV, GRAPH_POLICY, USER_CONFIG_POLICY, VIEW_POLICY, WATCH_POLICY, buildGraphData, commandHandlers, commandManifest, createDefaultProviders, readRegistry, readWorkflowModel,
  renderBoardHtml, resolveConfigRoot, runWatch,
} from '../../lib/core/index.js';
import { createTempRepository } from '../helpers/temp-repository.js';
import {
  PROCESS_CONFIG_HOME, REAL_PROFILE_AT_START, realProfileProbe, treeDigest,
} from './support.js';

const providers = createDefaultProviders();

// the whole adapter: plain input in, plain packet out
function adapter(configRoot) {
  const call = async (id, { flags = {}, positionals = {}, cwd, format = 'json' } = {}) => {
    const packet = await commandHandlers[id]({
      command: commandManifest.commands.find((entry) => entry.id === id),
      context: { cwd, env: { [CONFIG_HOME_ENV]: configRoot }, platform: process.platform },
      input: { flags, positionals, format, stdin: false },
      manifest: commandManifest,
      providers,
      readStdin: async () => Buffer.alloc(0),
    });
    return packet;
  };
  return { call };
}

async function scaffolded(t) {
  const repo = await createTempRepository(t, { prefix: 'akrs-adapter-project-' });
  const config = await createTempRepository(t, { prefix: 'akrs-adapter-config-' });
  const app = adapter(`${config.root}/cfg`);
  const created = await app.call('init-scaffold', { cwd: repo.root, flags: { '--root': repo.root, '--plan': 'P1' } });
  assert.equal(created.status, 'ok', JSON.stringify(created.findings));
  return { repo, config, app, roots: { repositoryRoot: repo.root, workflowRoot: repo.path('akrs') } };
}

test('the registry, the cross-project status, the graph, the board and the stream all run through the core exports', async (t) => {
  const { repo, config, app, roots } = await scaffolded(t);

  // projects
  const added = await app.call('projects-add', { cwd: config.root, positionals: { path: repo.root } });
  assert.deepEqual([added.status, added.data.outcome], ['ok', 'added']);
  const listed = await app.call('projects-list', { cwd: config.root });
  assert.deepEqual(listed.data.projects.map(({ root }) => root), [added.data.project.root]);
  assert.equal((await readRegistry({ configRoot: resolveConfigRoot({ env: { [CONFIG_HOME_ENV]: `${config.root}/cfg` } }).root })).projects.length, 1);

  // cross-project status, read only
  const before = await treeDigest(repo);
  const all = await app.call('status', { cwd: config.root, flags: { '--all-projects': true } });
  assert.deepEqual([all.status, all.data.kind, all.data.projects[0].state], ['ok', 'status_all_projects', 'ok']);
  assert.deepEqual(all.data.projects[0].status, (await app.call('status', { cwd: repo.root, flags: { '--root': repo.root } })).data);
  assert.equal(await treeDigest(repo), before, 'registered projects are only read');

  // the graph packet is the plain data of the core builder
  const graph = await app.call('graph', { cwd: repo.root, flags: { '--root': repo.root } });
  assert.deepEqual(graph.data, buildGraphData(await readWorkflowModel({ ...roots, env: {}, rootArgs: [] })));
  assert.deepEqual([...new Set(graph.data.nodes.map(({ type }) => type))], ['plan', 'road', 'task', 'verification'], 'a scaffolded Plan has every node kind');
  assert.deepEqual([...new Set(graph.data.edges.map(({ type }) => type))], ['touch']);

  // the board is rendered from that data alone
  const view = await app.call('view', { cwd: repo.root, flags: { '--root': repo.root } });
  assert.equal(view.data.path, 'akrs/.cache/view/index.html');
  assert.equal(await readFile(repo.path(view.data.path), 'utf8'), renderBoardHtml(graph.data));

  // the stream: an operation committed while watching arrives as an event
  const events = [];
  let announce = () => {};
  const startedSeen = new Promise((resolve) => { announce = resolve; });
  const controller = new AbortController();
  const running = runWatch({
    ...roots,
    debounceMs: 20,
    pollMs: 50,
    durationMs: 30_000,
    signal: controller.signal,
    emit: (type, data) => {
      events.push({ type, data });
      if (type === 'started') announce();
      if (data.kind === 'watch_op') controller.abort();
    },
  });
  await startedSeen;
  const set = await app.call('state-set', { cwd: repo.root, flags: { '--root': repo.root, '--next': 'review the board' } });
  assert.equal(set.status, 'ok', JSON.stringify(set.findings));
  const ended = await running;
  assert.equal(ended.ended, 'signal');
  assert.equal(events[0].type, 'started');
  const reported = events.find(({ data }) => data.kind === 'watch_op');
  assert.deepEqual([reported.data.op, reported.data.command], [set.request_id, 'state-set']);
  const touched = events.filter(({ data }) => data.kind === 'watch_change').flatMap(({ data }) => data.paths);
  assert.deepEqual([...new Set(touched)].sort(), ['akrs/STATE.md', 'akrs/state.json'], 'the files the operation changed were reported as changes');

  // remove deletes the entry, not the project
  const projectBefore = await treeDigest(repo);
  const removed = await app.call('projects-remove', { cwd: config.root, positionals: { project: repo.root } });
  assert.deepEqual([removed.status, removed.data.outcome], ['ok', 'removed']);
  assert.equal(await treeDigest(repo), projectBefore);
  assert.deepEqual((await app.call('projects-list', { cwd: config.root })).data.projects, []);
});

test('the frozen decisions are public and the adapter never needed a default config root', async () => {
  assert.equal(Object.isFrozen(USER_CONFIG_POLICY) && Object.isFrozen(GRAPH_POLICY) && Object.isFrozen(VIEW_POLICY) && Object.isFrozen(WATCH_POLICY), true);
  assert.deepEqual(await readdir(PROCESS_CONFIG_HOME), [], 'nothing reached the process-level safety config root');
});

test('removing a registered project from the registry works after the project is deleted', async (t) => {
  const { repo, config, app } = await scaffolded(t);
  await app.call('projects-add', { cwd: config.root, positionals: { path: repo.root } });
  await rm(repo.root, { recursive: true, force: true });
  const removed = await app.call('projects-remove', { cwd: config.root, positionals: { project: repo.root } });
  assert.equal(removed.data.outcome, 'removed');
});

test('the real user profile was not touched by any test of this file', () => {
  assert.deepEqual(realProfileProbe(), REAL_PROFILE_AT_START);
});
