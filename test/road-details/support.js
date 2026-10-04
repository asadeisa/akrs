// Shared helpers for the P2-W01 road-details tests: a repository with classified executors, Roads seeded through the
// canonical codec, a Task scaffold written by the real renderer, and in-process CLI runs.
import { writeFile } from 'node:fs/promises';
import { roadPath } from '../../lib/store/roads/paths.js';
import { renderTaskScaffold } from '../../lib/store/roads/task.js';
import { commandSnapshot } from '../../lib/store/snapshots/index.js';
import { everything, strict } from '../change/support.js';
import { fakeProviders, roadInput, runCommand, seedPlan, seedRoad, treeDigest } from '../road/support.js';
import { createRepo as createBaseRepo } from '../road/support.js';
import { setExec } from '../road-fit/support.js';

export { everything, roadInput, runCommand, seedPlan, seedRoad, setExec, strict, treeDigest };

export const EXECUTORS = Object.freeze([
  { id: 'lead', role: 'leader', class: 'frontier', label: 'Opus via Claude Code', user_answer: 'frontier' },
  { id: 'flash', role: 'worker', class: 'weak', label: 'Flash', user_answer: 'weak' },
  { id: 'mid', role: 'worker', class: 'medium', label: 'Mid', user_answer: 'medium' },
  { id: 'top', role: 'worker', class: 'frontier', label: 'Top', user_answer: 'frontier' },
]);

export const readEntry = (path, lines = null, why = null) => ({ path, lines, why });
export const fileWrite = (path, action = 'create') => ({ path, class: 'file', action });

// The default Worker Road: weak class, two declared windows, two writes, one dependency.
export const WORKER_ROAD = Object.freeze({
  id: 'R-P6-1',
  plan: 'P6',
  task: 'T-P6-1',
  deps: ['R-P5-6'],
  reads: [readEntry('SOT/09-use-cases.md', [28, 41], 'canonical paid-state rule'), readEntry('app/config/payment-status.ts', [12, 25], 'existing payment-status adapter')],
  writes: [fileWrite('src/admin.js'), fileWrite('src/own.js', 'modify')],
  forbidden: ['server/**'],
  executor_class: 'weak',
});

export async function createRepo(t, { files = {}, executors = EXECUTORS } = {}) {
  const repo = await createBaseRepo(t, { files });
  repo.providers = fakeProviders();
  for (const executor of executors) {
    const result = await setExec(repo, executor);
    if (result.outcome !== 'committed') throw new Error(`executor ${executor.id} was not recorded: ${result.outcome}`);
  }
  return repo;
}

export async function seedWithTask(repo, overrides = {}, { status = 'ACTIVE', taskNotes = null } = {}) {
  const input = { ...WORKER_ROAD, ...overrides };
  const folder = input.plan === null ? 'roads' : `roads/${input.plan}`;
  await seedRoad(repo, input, { folder, status });
  if (input.task !== null) {
    await repo.write(`akrs/tasks/${input.task}.md`, renderTaskScaffold({
      schema: 'akrs.task/v1', id: input.task, plan: input.plan, road: input.id, objective: 'Build the admin page.', constraints: null, approach: null, notes: taskNotes,
    }, { roadPath: `akrs/${roadPath({ id: input.id, plan: input.plan })}` }));
  }
  return input;
}

// The world every packet test starts from: a plan, the DONE dependency and the ACTIVE weak Road.
export async function packetWorld(t, overrides = {}, options = {}) {
  const repo = await createRepo(t, options);
  await seedPlan(repo, 'P6');
  await seedRoad(repo, { id: 'R-P5-6', plan: null, executor_class: 'medium' }, { status: 'DONE' });
  const road = await seedWithTask(repo, overrides, options.road);
  return { repo, road };
}

export async function details(repo, id, args = [], options = {}) {
  const result = await runCommand(repo, ['road-details', id, '--json', ...args], { providers: repo.providers, ...options });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, packet: result.stdout === '' ? null : JSON.parse(result.stdout) };
}

export const snapshotOf = async (repo, id) => (await commandSnapshot('road-details', { ...repo.options, target: { road: id } })).snapshot;
export const rewrite = (repo, path, transform) => repo.read(path).then((text) => writeFile(repo.path(path), transform(text)));
export const codesOf = (packet) => [...new Set(packet.findings.map(({ code }) => code))].sort();
export const reasonsOf = (packet, code) => packet.findings.filter((finding) => finding.code === code).map(({ detail }) => detail.reason).sort();
