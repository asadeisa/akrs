// Shared helpers for the P1-W05 transaction tests: the realistic P1-W02 workflow fixture, deterministic providers,
// byte-tree hashing of everything except `.ops`, and the child-process crash harness.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTransactionalMutation } from '../../lib/store/transactions/index.js';
import { commandSnapshot } from '../../lib/store/snapshots/index.js';
import {
  SCENARIOS,
  SCENARIO_NAMES,
  SCENARIO_REQUEST_ID,
  UNRELATED,
  UNRELATED_REQUEST_ID,
  scenarioOptions,
} from '../fixtures/transaction-crash/scenarios.js';
import { fakeProviders } from '../idempotency/support.js';
import { createWorkflow } from '../snapshots/support.js';

export { fakeProviders, SCENARIOS, SCENARIO_NAMES, SCENARIO_REQUEST_ID, UNRELATED, UNRELATED_REQUEST_ID, scenarioOptions };
export const WORKER = fileURLToPath(new URL('../fixtures/transaction-crash/worker.js', import.meta.url));
export const ulid = (n) => `01ARZ3NDEKTSV4RRFFQ6${String(n).padStart(6, '0')}`;

// The snapshot fixture pre-creates fake lock and journal files under .ops; the real ones need directories.
export const createTxWorkflow = (testContext, extra = {}) => createWorkflow(testContext, {
  omit: ['akrs/.ops/lock', 'akrs/.ops/journal/0001.jsonl'], extra,
});

// sha256 over every file, directory and link of the repository except `akrs/.ops` and `.git`: "the complete old or
// the complete new state" is a statement about this hash. Directories count, so a leftover empty directory is a diff.
export async function treeDigest(workflow, { exclude = ['akrs/.ops', '.git'] } = {}) {
  const hash = createHash('sha256');
  async function walk(directory, relative) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (exclude.includes(child)) continue;
      const absolute = join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        hash.update(`link\0${child}\0${await readlink(absolute)}\0`);
      } else if (metadata.isDirectory()) {
        hash.update(`directory\0${child}\0`);
        await walk(absolute, child);
      } else if (metadata.isFile()) {
        const bytes = await readFile(absolute);
        hash.update(`file\0${child}\0${bytes.byteLength}\0`);
        hash.update(bytes);
      }
    }
  }
  await walk(workflow.root, '');
  return hash.digest('hex');
}

// Digest of one directory including everything in it (used to prove a blocked recovery wrote nothing under .ops/tx).
export const digestOf = (workflow, relative) => treeDigest({ root: workflow.path(relative) }, { exclude: [] })
  .catch((error) => {
    if (error?.code === 'ENOENT') return 'absent';
    throw error;
  });

export async function listNames(path) {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export const txRoot = (workflow) => workflow.path('akrs', '.ops', 'tx');
export const txDirectories = (workflow) => listNames(txRoot(workflow));
export const txPath = (workflow, id, ...segments) => join(txRoot(workflow), id, ...segments);
export const opsFile = (workflow, requestId) => workflow.path('akrs', '.ops', 'journal', 'ops', `${requestId}.jsonl`);

export async function journalStates(workflow, requestId) {
  try {
    const text = await readFile(opsFile(workflow, requestId), 'utf8');
    return text.split('\n').filter(Boolean).map((record) => JSON.parse(record).state);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export const pendingMarkers = (workflow) => listNames(workflow.path('akrs', '.ops', 'journal', 'pending'));

// One in-process run of a scenario with an event log; `boundary` records every boundary in order.
export async function runScenario(workflow, scenario, extra = {}) {
  const points = [];
  const calls = { render: 0, authorize: 0, validate: 0 };
  const providers = extra.providers ?? fakeProviders();
  const result = await runTransactionalMutation(scenarioOptions(workflow.options, scenario, {
    providers,
    requestId: scenario === UNRELATED ? UNRELATED_REQUEST_ID : SCENARIO_REQUEST_ID,
    ...extra,
    authorize: extra.authorize === undefined ? undefined : async (context) => { calls.authorize += 1; return extra.authorize(context); },
    validate: extra.validate === undefined ? undefined : async (context) => { calls.validate += 1; return extra.validate(context); },
    render(context) {
      calls.render += 1;
      return (extra.render ?? scenarioOptions(workflow.options, scenario).render)(context);
    },
    async boundary(event) {
      points.push(event);
      await extra.boundary?.(event);
    },
  }));
  return { result, points, calls, providers };
}

// Boundary points, in order, of one clean run of a scenario (a throwaway workflow).
export async function censusOf(testContext, scenarioName) {
  const workflow = await createTxWorkflow(testContext);
  const { points, result } = await runScenario(workflow, SCENARIOS[scenarioName]);
  if (result.outcome !== 'committed') throw new Error(`census run did not commit: ${result.outcome}`);
  return points.map(({ point, index }) => ({ point, index: index ?? null }));
}

// The trees a recovered scenario must equal: `old` (nothing happened), `new` (scenario committed) and `final`
// (scenario and the unrelated mutation both committed, which is where every crash test ends).
export async function referenceTrees(testContext, scenarioName) {
  const old = await createTxWorkflow(testContext);
  const oldDigest = await treeDigest(old);
  const fresh = await createTxWorkflow(testContext);
  await runScenario(fresh, SCENARIOS[scenarioName]);
  const newDigest = await treeDigest(fresh);
  await runScenario(fresh, UNRELATED);
  return { old: oldDigest, new: newDigest, final: await treeDigest(fresh) };
}

export const commandSnapshotFor = async (workflow, scenario) => {
  const target = {};
  for (const key of ['road', 'plan']) if (scenario.target[key] !== null) target[key] = scenario.target[key];
  return (await commandSnapshot(scenario.command, { ...workflow.options, target })).snapshot;
};

// Spawns the crash worker (never a shell). Resolves with the exit facts and the last stdout JSON line, if any.
export function runWorker(config) {
  const child = spawn(process.execPath, [WORKER, JSON.stringify(config)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolveClosed, rejectClosed) => {
    child.on('error', rejectClosed);
    child.on('close', (exitCode, signal) => {
      const last = stdout.trim().split('\n').filter(Boolean).at(-1);
      resolveClosed({ exitCode, signal, stdout, stderr, result: last === undefined ? null : JSON.parse(last) });
    });
  });
}

// Runs async jobs with bounded concurrency; the first failure rejects after the running jobs settle.
export async function pool(jobs, size = 6) {
  const queue = [...jobs];
  const failures = [];
  async function lane() {
    while (queue.length > 0) {
      const job = queue.shift();
      try {
        await job();
      } catch (error) {
        failures.push(error);
        queue.length = 0;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, lane));
  if (failures.length > 0) throw failures[0];
}

export function positionOf(census, point, index = null) {
  const position = census.findIndex((entry) => entry.point === point && entry.index === index);
  if (position < 0) throw new Error(`no boundary ${point}#${index} in the census`);
  return position;
}

// Runs the crash worker on a fresh workflow, killed right after boundary number `killAt` (SIGKILL on itself).
export async function crashWorkflow(testContext, scenarioName, killAt) {
  const workflow = await createTxWorkflow(testContext);
  const child = await runWorker({
    options: workflow.options, scenario: scenarioName, requestId: SCENARIO_REQUEST_ID, killAt,
  });
  if (child.result !== null) throw new Error(`the worker finished instead of crashing at ${killAt}: ${child.stdout}${child.stderr}`);
  if (process.platform !== 'win32' && child.signal !== 'SIGKILL') {
    throw new Error(`the worker was not killed (${child.signal}/${child.exitCode}): ${child.stderr}`);
  }
  return workflow;
}

export async function crashAt(testContext, scenarioName, point, index = null, census = undefined) {
  const found = census ?? await censusOf(testContext, scenarioName);
  return crashWorkflow(testContext, scenarioName, positionOf(found, point, index));
}
