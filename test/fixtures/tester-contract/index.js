// P2-W06 golden: the complete and the negative Tester packets of fixed worlds, with their prompt and human renderings,
// byte-compared to committed JSON. Machine-dependent values (the root) are placeholders. Regenerate with
// AKRS_REGENERATE_TESTER_CONTRACT=1 only after reviewing why the contract changed.
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { contractInput, runCommand, seedRoad, testerWorld } from '../../test-details/support.js';

const GOLDEN = new URL('./expected.json', import.meta.url);
const ROOT = /(?:[A-Za-z]:)?[\\/][^"\s]*akrs-road-[A-Za-z0-9_-]+/g;
const normalize = (_key, value) => (typeof value === 'string' ? value.replace(ROOT, '<root>') : value);

async function capture(repo) {
  const out = {};
  for (const [name, args] of [['json', ['--json']], ['prompt', ['--prompt']], ['human', []]]) {
    const result = await runCommand(repo, ['test-details', 'P6', ...args], { providers: repo.providers });
    // a human view of a non-ok packet goes to stderr, a prompt and JSON to stdout
    out[name] = name === 'json' ? { exit_code: result.exitCode, packet: JSON.parse(result.stdout) } : (result.stdout === '' ? result.stderr : result.stdout);
  }
  return JSON.parse(JSON.stringify(out, normalize));
}

async function produce(t) {
  const cases = {};
  cases.complete = await capture(await testerWorld(t));
  cases.policy_none = await capture(await testerWorld(t, { handoffs: false, contract: await contractInput('valid/policy-none', { plan: 'P6', roads: ['R-P6-1', 'R-P6-2'] }) }));
  const missing = await testerWorld(t);
  await rm(missing.path('akrs/verifications/P6/contract.json'));
  cases.no_contract = await capture(missing);
  const many = await testerWorld(t, { handoffs: false, contract: { acceptance: [] } });
  await seedRoad(many, { id: 'R-P6-2', plan: 'P6' }, { folder: 'roads/P6', status: 'ACTIVE' });
  await rm(many.path('SOT/10-budgets.md'));
  cases.blocked_many = await capture(many);
  const edited = await testerWorld(t);
  await writeFile(edited.path('akrs/verifications/P6/contract.json'), '{"plan":"P6"}\n');
  cases.contract_unverified = await capture(edited);
  return cases;
}

test('the committed tester-contract golden equals what the CLI returns for the fixed worlds', async (t) => {
  const actual = await produce(t);
  if (process.env.AKRS_REGENERATE_TESTER_CONTRACT === '1') await writeFile(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(actual, JSON.parse(await readFile(GOLDEN, 'utf8')));
});

test('the golden complete packet is ready and every negative one is blocked with named blockers, never a partial ready state', async () => {
  const golden = JSON.parse(await readFile(GOLDEN, 'utf8'));
  assert.deepEqual(Object.entries(golden).map(([name, entry]) => [name, entry.json.packet.status]), [
    ['complete', 'ok'], ['policy_none', 'ok'], ['no_contract', 'blocked'], ['blocked_many', 'blocked'], ['contract_unverified', 'blocked'],
  ]);
  for (const [name, entry] of Object.entries(golden)) {
    assert.equal(entry.prompt.includes('Never edit product code.') || entry.json.packet.data.kind === 'test_details_blocked', true, name);
    assert.equal(entry.json.packet.status === 'blocked', entry.json.packet.data.blockers.length > 0, name);
    assert.equal(entry.json.exit_code, entry.json.packet.status === 'ok' ? 0 : 1, name);
  }
});
