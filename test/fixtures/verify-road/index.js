// P2-W03 golden: the dry-run, failing and passing `verify --road` data of a fixed world, byte-compared to committed JSON.
// Machine-dependent values (the node path, inherited environment names, durations) are replaced by placeholders.
// Regenerate with AKRS_REGENERATE_VERIFY_ROAD=1 only after reviewing why the contract changed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { nodeCheck, verify, verifyWorld } from '../../verify-road/support.js';

const GOLDEN = new URL('./expected.json', import.meta.url);
const normalized = (packet, repo) => JSON.parse(JSON.stringify({
  status: packet.status, snapshot: packet.snapshot, data: packet.data, findings: packet.findings, next_commands: packet.next_commands,
}).replaceAll(JSON.stringify(process.execPath).slice(1, -1), '<node>').replaceAll(JSON.stringify(repo.root).slice(1, -1), '<root>'), (key, value) => {
  if (key === 'inherited' && Array.isArray(value)) return ['<machine-dependent names>'];
  if (key === 'duration_ms' && typeof value === 'number') return '<ms>';
  return value;
});

async function produce(t) {
  const checks = [
    nodeCheck('unit', 'process.stdout.write("12 passed")', [], 30000),
    nodeCheck('lint', 'process.stderr.write("lint: 2 problems"); process.exit(4)', [], 30000),
    { name: 'ghost', argv: ['akrs-no-such-program-xyz', '--flag'], timeout_ms: 5000 },
  ];
  const { repo } = await verifyWorld(t, checks);
  const out = {};
  for (const [name, args] of [['dry_run', ['--dry-run']], ['run', []], ['single_passed', ['--check', 'unit']], ['unknown_check', ['--check', 'nope']]]) {
    out[name] = normalized((await verify(repo, args)).packet, repo);
  }
  return out;
}

test('the committed verify-road golden equals what the CLI produces for the fixed world', async (t) => {
  const actual = await produce(t);
  if (process.env.AKRS_REGENERATE_VERIFY_ROAD === '1') await writeFile(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(actual, JSON.parse(await readFile(GOLDEN, 'utf8')));
});

test('the golden states mechanical verification, the risk, and keeps every outcome apart', async () => {
  const golden = JSON.parse(await readFile(GOLDEN, 'utf8'));
  assert.equal(golden.run.data.mode, 'mechanical');
  assert.deepEqual(golden.run.data.checks.map(({ status }) => status), ['passed', 'failed', 'spawn_failed']);
  assert.equal(golden.run.status, 'error');
  assert.equal(golden.single_passed.status, 'ok');
  assert.equal(golden.dry_run.data.checks.every(({ status }) => status === 'not_run'), true);
  assert.equal(golden.unknown_check.data.reason, 'check_unknown');
  assert.match(golden.run.data.risk, /trust/);
});
