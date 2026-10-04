// Shared helpers for the P1-W07 Road update, scope and move tests. Seeding goes through the canonical codec (never the
// writers under test); one provider pair per repository keeps request and record IDs unique across calls.
import { readFile } from 'node:fs/promises';
import { roadPath } from '../../lib/store/roads/paths.js';
import { renderTaskScaffold } from '../../lib/store/roads/task.js';
import { moveRoad } from '../../lib/store/roads/move.js';
import { updateRoad } from '../../lib/store/roads/update.js';
import { requestScope, resolveScope } from '../../lib/store/scope/writer.js';
import { commandSnapshot } from '../../lib/store/snapshots/index.js';
import {
  assertFindingsMatchCatalog, authoringOptions, codesOf, createRepo, fakeProviders, roadInput, runCommand, seedRoad, treeDigest, ulid,
} from '../road/support.js';

export {
  assertFindingsMatchCatalog, authoringOptions, codesOf, createRepo, roadInput, runCommand, seedRoad, treeDigest, ulid,
};

const pairs = new WeakMap();
export const providersOf = (repo) => {
  if (!pairs.has(repo)) pairs.set(repo, fakeProviders());
  return pairs.get(repo);
};
const opts = (repo, extra) => authoringOptions(repo, { providers: providersOf(repo), ...extra });
const stdin = (document) => ({ stdin: Buffer.from(typeof document === 'string' ? document : JSON.stringify(document)) });

export const snapshotOf = async (repo, command, road = null) => (await commandSnapshot(command, {
  ...repo.options, ...(road === null ? {} : { target: { road } }),
})).snapshot;

export const roadFile = async (repo, id, folder = 'roads') => repo.read(`akrs/${folder}/${id}.json`);
export const roadJson = async (repo, id, folder = 'roads') => JSON.parse(await roadFile(repo, id, folder));
export const strict = (repo) => treeDigest(repo, { exclude: [] });
export const everything = (repo) => treeDigest(repo);

// The update-form object of a seeded Road (stored form without `meta`), optionally changed.
export async function updateForm(repo, id, changes = {}, folder = 'roads') {
  const { meta: _meta, ...rest } = await roadJson(repo, id, folder);
  return { ...rest, ...changes };
}

export const update = (repo, id, document, extra = {}) => updateRoad({ ...opts(repo, extra), id, channel: stdin(document) });
export const patch = (repo, id, ops, extra = {}) => updateRoad({
  ...opts(repo, extra), id, patch: true, channel: stdin({ schema: 'akrs.road-patch/v1', ops }),
});
export const request = (repo, document, extra = {}) => requestScope({
  ...opts(repo, extra),
  channel: stdin({ schema: 'akrs.scope-request/v1', add_reads: [], add_writes: [], reason: 'The declared scope is not enough.', blocking: true, ...document }),
});
export const resolve = (repo, mode, target, extra = {}) => resolveScope({ ...opts(repo, extra), mode, target, ...extra });
export const move = (repo, id, plan, extra = {}) => moveRoad({ ...opts(repo, extra), id, plan, ...extra });

export const readEntry = (path) => ({ path, lines: null, why: 'needed' });
export const fileWrite = (path) => ({ path, class: 'file', action: 'create' });

// A Road with a Task on disk (scaffold written with the real renderer so the marker is canonical).
export async function seedRoadWithTask(repo, { id = 'R-P6-1', plan = 'P6', task = 'T-P6-1', extra = {} } = {}) {
  await seedRoad(repo, { id, plan, task, ...extra }, { folder: plan === null ? 'roads' : `roads/${plan}` });
  const path = `akrs/${roadPath({ id, plan })}`;
  await repo.write(`akrs/tasks/${task}.md`, renderTaskScaffold({
    schema: 'akrs.task/v1', id: task, plan, road: id, objective: 'Build the admin page.', constraints: null, approach: null, notes: 'Custom note.',
  }, { roadPath: path }));
  return path;
}

export const text = (repo, path) => readFile(repo.path(path), 'utf8');
