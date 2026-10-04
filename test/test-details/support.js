// Shared helpers for the P2-W06 test-details tests: a Plan world whose Roads are DONE with handoffs and a Leader contract
// written through the real writers, results seeded through the JSONL codec, and in-process CLI runs.
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RESULT_SPEC } from '../../lib/schemas/handoff-result.js';
import { encodeJsonlRecord } from '../../lib/store/canonical/index.js';
import { commandSnapshot } from '../../lib/store/snapshots/index.js';
import { fakeProviders } from '../idempotency/support.js';
import { runCommand, seedRoad, treeDigest } from '../road/support.js';
import { setExec } from '../road-details/support.js';
import { contractInput, define, handoff, planWorld } from '../tester/support.js';

export { contractInput, define, handoff, runCommand, seedRoad, treeDigest };
export const ULID = (n) => `01ARZ3NDEKTSV4RRFFQ6${String(n).padStart(6, '0')}`;

// Plan P6 with R-P6-1 and R-P6-2 DONE, a measured contract over both, a ready handoff for each and the files the contract reads.
export async function testerWorld(t, { contract = {}, handoffs = true, extraRoad = {} } = {}) {
  const repo = await planWorld(t);
  repo.providers = fakeProviders({ firstId: 9000 });
  await repo.write('SOT/10-budgets.md', 'frame budget 16ms\n');
  await seedRoad(repo, { id: 'R-P6-1', plan: 'P6', ...extraRoad }, { folder: 'roads/P6', status: 'DONE' });
  const stored = await define(repo, 'P6', await contractInput('valid/full', contract));
  if (stored.outcome !== 'committed') throw new Error(`contract not stored: ${JSON.stringify(stored.packet.findings)}`);
  if (handoffs) {
    for (const road of ['R-P6-1', 'R-P6-2']) {
      const result = await handoff(repo, 'P6', { road, result: `${road} is reachable.`, reach: [`Open /${road}`, 'Click Save'], expect: `${road} lists reservations.` });
      if (result.outcome !== 'committed') throw new Error(`handoff not stored: ${JSON.stringify(result.packet.findings)}`);
    }
  }
  return repo;
}

export async function details(repo, key = 'P6', args = [], options = {}) {
  const result = await runCommand(repo, ['test-details', key, '--json', ...args], { providers: repo.providers, ...options });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, packet: result.stdout === '' ? null : JSON.parse(result.stdout) };
}

export const snapshotOf = async (repo, key = 'P6') => (await commandSnapshot('test-details', { ...repo.options, target: { plan: key } })).snapshot;
export const blockerReasons = (packet) => packet.data.blockers.map(({ reason }) => reason);

// Appends a stored Result record (the P2-W07 writer owns real ones) through the codec.
export async function seedResult(repo, key, fields) {
  const record = {
    id: ULID(fields.n ?? 1), ts: '2026-10-03T11:00:00.000Z', plan: key, tested_snapshot: fields.tested_snapshot, contract_hash: fields.contract_hash,
    verdict: 'fail', checks: [], measurements: [], evidence: [], findings: [], user_acceptance: { answer: 'no', because: 'The save button does nothing.' }, run: null,
  };
  const { n: _n, ...rest } = fields;
  const line = encodeJsonlRecord({ ...record, ...rest }, RESULT_SPEC);
  const path = repo.path(`akrs/verifications/${key}/results.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line);
}

export const setExecutorFor = (repo, cls) => setExec(repo, { id: 'qa', role: 'tester', class: cls, label: 'QA', user_answer: cls });
