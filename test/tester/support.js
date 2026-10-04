// Shared helpers for the P1-W10 Tester source tests. Seeding uses the canonical codec, never the writers under test.
import { readFile } from 'node:fs/promises';
import { appendHandoff, defineVerification } from '../../lib/store/verification/index.js';
import { everything, providersOf, request, snapshotOf, strict } from '../change/support.js';
import { authoringOptions, createRepo, roadInput, runCommand, seedPlan, seedRoad, treeDigest, ulid } from '../road/support.js';

export { createRepo, everything, request, roadInput, runCommand, seedPlan, seedRoad, snapshotOf, strict, treeDigest, ulid };

const fixture = async (name) => JSON.parse(await readFile(new URL(`../fixtures/schemas/verification/${name}.json`, import.meta.url), 'utf8'));
// The valid fixtures are stored forms; the Leader's INPUT form has no `meta`.
export async function contractInput(name = 'valid/full', overrides = {}) {
  const { meta: _meta, ...input } = await fixture(name);
  return { ...input, ...overrides };
}
export const invalidContract = async (name) => (await fixture(`invalid/${name}`));

const stdin = (document) => ({ stdin: Buffer.from(JSON.stringify(document)) });
const opts = (repo, extra) => authoringOptions(repo, { providers: providersOf(repo), ...extra });
export const define = (repo, key, document, extra = {}) => defineVerification({ ...opts(repo, extra), key, channel: stdin(document) });
export const handoff = (repo, key, document, extra = {}) => appendHandoff({
  ...opts(repo, extra), key, channel: stdin({ schema: 'akrs.handoff/v1', result: 'The admin page is reachable.', reach: ['Open /admin'], expect: 'The page lists reservations.', ...document }),
});

// Two started Roads of Plan P6 (and the Plan file), plus the SOT files createRepo already provides.
export async function planWorld(t) {
  const repo = await createRepo(t);
  await seedPlan(repo, 'P6');
  await seedRoad(repo, { id: 'R-P6-1', plan: 'P6' }, { folder: 'roads/P6', status: 'ACTIVE' });
  await seedRoad(repo, { id: 'R-P6-2', plan: 'P6' }, { folder: 'roads/P6', status: 'DONE' });
  return repo;
}
export const contractFile = (repo, key = 'P6') => repo.read(`akrs/verifications/${key}/contract.json`);
export const handoffLines = async (repo, key = 'P6') => (await repo.read(`akrs/verifications/${key}/handoff.jsonl`)).split('\n').filter(Boolean).map((line) => JSON.parse(line));
export const reasons = (packet) => packet.findings.filter(({ code }) => code === 'AKRS-T002').map(({ detail }) => detail.reason);
