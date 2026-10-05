// Shared helpers of the P2-W08 tests: a Plan that has really been through the Tester loop (run, result), a valid stored Plan
// file, and in-process `plan finish` runs. Nothing here seeds a result unless a test says so.
import { readdir, rm, writeFile } from 'node:fs/promises';
import { PLAN_SCHEMA, PLAN_SPEC } from '../../lib/schemas/plan.js';
import { canonicalizeJson, storedSpec, withMeta } from '../../lib/store/canonical/index.js';
import { readLog } from '../../lib/store/log/repository.js';
import { commandSnapshot } from '../../lib/store/snapshots/index.js';
import { seedRoad } from '../road/support.js';
import { details, flat, full, ledger, ranWorld, redefine, reasonsOf, result, runWorld, testRun, worldOptions, acceptance } from '../test-result/support.js';
import { runCommand } from '../road/support.js';

export { acceptance, details, flat, full, ledger, ranWorld, redefine, reasonsOf, result, runWorld, runCommand, seedRoad, testRun, worldOptions };

export const PLAN_PATH = 'akrs/plans/P6.json';

// A valid STORED Plan file (the seeded one of the road helpers is an input form without findings, closure or meta).
export async function writePlan(repo, { questions = [], seams = [], findings = [], closure = { status: 'open', at: null, operation: null }, title = 'Plan P6' } = {}) {
  const stored = { schema: PLAN_SCHEMA, id: 'P6', title, questions, seams, findings, closure };
  const stamped = withMeta(stored, { schema: PLAN_SCHEMA, generator: 'akrs/2.0.0-alpha.0', spec: PLAN_SPEC });
  await repo.write(PLAN_PATH, canonicalizeJson(stamped, storedSpec(PLAN_SPEC)));
}

// Plan P6 with both Roads DONE, a stored open Plan, a passing run and a recorded pass: closable as it stands.
export async function closableWorld(t, { contract, plan } = {}) {
  const repo = await ranWorld(t, { contract });
  await writePlan(repo, plan);
  const pass = await flat(repo, 'pass');
  if (pass.packet.status !== 'ok') throw new Error(`the pass was not recorded: ${pass.text}`);
  return repo;
}

export const snapshotOf = async (repo, key = 'P6') => (await commandSnapshot('plan-finish', { ...repo.options, target: { plan: key } })).snapshot;

// `plan finish P6 --if-snapshot <current> ...args --json`, parsed.
export async function finish(repo, args = [], { key = 'P6', snapshot, providers = repo.providers, stdin } = {}) {
  const guard = snapshot === null ? [] : ['--if-snapshot', snapshot ?? await snapshotOf(repo, key)];
  const out = await runCommand(repo, ['plan', 'finish', key, ...guard, ...args, ...(args.includes('--json') ? [] : ['--json'])], { providers, stdin });
  const text = out.stdout === '' ? out.stderr : out.stdout;
  let packet = null;
  try {
    packet = JSON.parse(text);
  } catch {
    packet = null;
  }
  return { ...out, text, packet };
}

export const blockersOf = (packet) => (packet.data.blockers ?? []).map(({ reason }) => reason);
export const T007 = (packet) => packet.findings.filter(({ code }) => code === 'AKRS-T007').map(({ detail }) => detail.reason);
export const closures = async (repo) => (await readLog(repo.options)).records.filter(({ kind }) => kind === 'plan');
export const removeEvidenceFiles = async (repo, runId) => {
  const directory = repo.path(`akrs/verifications/P6/evidence/${runId}`);
  for (const name of await readdir(directory)) if (name !== 'run.json') await rm(`${directory}/${name}`);
};
export const overwrite = (repo, path, text) => writeFile(repo.path(path), text);
