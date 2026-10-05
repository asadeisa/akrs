// Shared helpers of the P2-W09 navigation tests: a workflow with every kind of Road (DONE, ACTIVE, ready QUEUED, blocked QUEUED),
// Tester worlds in each state, and in-process CLI runs of the query commands. Worlds are built through the real writers.
import { claimLease } from '../../lib/store/leases/index.js';
import { LEASE_CONTRACT_PROJECTION, computeSnapshot } from '../../lib/store/snapshots/index.js';
import { fakeProviders } from '../idempotency/support.js';
import { fileWrite, packetWorld, runCommand, seedWithTask, setExec } from '../road-details/support.js';
import { acceptance, closableWorld, finish, flat, full, ranWorld, redefine, runWorld, testRun, worldOptions, writePlan } from '../plan-finish/support.js';

export { acceptance, closableWorld, finish, flat, full, packetWorld, ranWorld, redefine, runCommand, runWorld, setExec, testRun, worldOptions, writePlan };

// Plan P6 (input-form file of the road helpers), R-P5-6 DONE (no Plan), R-P6-1 ACTIVE (weak, depends on R-P5-6),
// R-P6-2 QUEUED but blocked (depends on the unfinished R-P6-1), R-P6-3 QUEUED and ready (depends on the DONE R-P5-6).
export async function navWorld(t) {
  const { repo } = await packetWorld(t);
  repo.providers = fakeProviders({ firstId: 7000 });
  await seedWithTask(repo, { id: 'R-P6-2', task: 'T-P6-2', deps: ['R-P6-1'], executor_class: 'medium', writes: [fileWrite('src/second.js')] }, { status: 'QUEUED' });
  await seedWithTask(repo, { id: 'R-P6-3', task: 'T-P6-3', deps: ['R-P5-6'], executor_class: 'medium', writes: [fileWrite('src/third.js')] }, { status: 'QUEUED' });
  return repo;
}

// `akrs <command...> --json`, parsed.
export async function query(repo, argv, { providers = repo.providers, stdin } = {}) {
  const out = await runCommand(repo, [...argv, ...(argv.includes('--json') || argv.includes('--prompt') ? [] : ['--json'])], { providers, stdin });
  const text = out.stdout === '' ? out.stderr : out.stdout;
  let packet = null;
  try {
    packet = JSON.parse(text);
  } catch {
    packet = null;
  }
  return { ...out, text, packet };
}
export const status = (repo, extra = []) => query(repo, ['status', ...extra]);
export const next = (repo, extra = []) => query(repo, ['next', ...extra]);
export const planOf = (packet, id = 'P6') => packet.data.plans.find((plan) => plan.id === id);

export async function claimRoad(repo, id, holder = 'flash') {
  const current = await computeSnapshot({ ...repo.options, projections: LEASE_CONTRACT_PROJECTION, target: { road: id } });
  return claimLease({ ...repo.options, providers: repo.providers, kind: 'road', target: id, holder, snapshot: current.snapshot, inventory: current.inventory });
}
