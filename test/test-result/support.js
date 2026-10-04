// Shared helpers of the P2-W07 tests: a Tester world that has really run its scenario (the P2-W14 fixture app), and in-process
// `test result` runs. Results are written by the command under test, never seeded, except where a test says so.
import { readFile } from 'node:fs/promises';
import { commandSnapshot } from '../../lib/store/snapshots/index.js';
import { runCommand } from '../road/support.js';
import { runWorld, testRun } from '../scenario/support.js';
import { define } from '../tester/support.js';
import { details } from '../test-details/support.js';

export { details, runCommand, runWorld, testRun };

// A live contract that asks for the log evidence a plain HTTP run produces.
export const worldOptions = (contract = {}) => ({ contract: { evidence_types: ['log'], ...contract } });

export async function ranWorld(t, options = {}) {
  const repo = await runWorld(t, worldOptions(options.contract));
  const run = await testRun(repo);
  if (run.packet.data.run?.status !== 'passed') throw new Error(`the scenario did not pass: ${run.text}`);
  repo.run = run.packet.data.run;
  return repo;
}

export async function redefine(repo, overrides) {
  const current = JSON.parse(await repo.read('akrs/verifications/P6/contract.json'));
  const { meta: _meta, ...input } = current;
  const snapshot = (await commandSnapshot('test-define', { ...repo.options, target: { plan: 'P6' } })).snapshot;
  const result = await define(repo, 'P6', { ...input, ...overrides }, { expectedSnapshot: snapshot });
  if (result.outcome !== 'committed') throw new Error(`redefine failed: ${JSON.stringify(result.packet.findings)}`);
}

// `test result P6 ...args` with the JSON packet parsed.
export async function result(repo, args = [], { stdin, key = 'P6', providers = repo.providers } = {}) {
  const out = await runCommand(repo, ['test', 'result', key, ...args, ...(args.includes('--json') ? [] : ['--json'])], { stdin, providers });
  const text = out.stdout === '' ? out.stderr : out.stdout;
  let packet = null;
  try {
    packet = JSON.parse(text);
  } catch {
    packet = null;
  }
  return { ...out, text, packet };
}

export const flat = (repo, verdict, because = 'The reservation flow works end to end.', extra = []) => result(repo, ['--verdict', verdict, '--because', because, ...extra]);
export const full = (repo, document, args = []) => result(repo, ['--json', '-', ...args], { stdin: JSON.stringify({ schema: 'akrs.result/v1', ...document }) });

export const RESULTS = 'akrs/verifications/P6/results.jsonl';
export const ledger = async (repo) => {
  const text = await readFile(repo.path(RESULTS), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
};
export const reasonsOf = (packet) => packet.findings.filter(({ code }) => code === 'AKRS-T006').map(({ detail }) => detail.reason);
export const acceptance = (answer, because = 'Reviewed the declared flow.') => ({ answer, because });
