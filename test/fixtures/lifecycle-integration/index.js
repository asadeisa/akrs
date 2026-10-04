// P2-W05 golden: the lifecycle integration of the Worker loop over an injected ready Road (a seeded ACTIVE Road, not the
// normative full CLI Worker loop, which waits for `next`): road-details -> verify -> audit -> road finish, then reopen and
// the second finish that records no second closure. Each step is summarised (status, exit code, data kind, finding codes,
// the commands it points at and the facts of the lifecycle data) and byte-compared to committed JSON; machine-dependent
// values (the root) are placeholders. Regenerate with AKRS_REGENERATE_LIFECYCLE=1 only after reviewing why the contract changed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { lifecycleWorld, put, runCommand, snapshotOf } from '../../road-lifecycle/support.js';

const GOLDEN = new URL('./expected.json', import.meta.url);
const ROOT = /(?:[A-Za-z]:)?[\\/][^"\s]*akrs-road-[A-Za-z0-9_-]+/g;
const normalize = (_key, value) => (typeof value === 'string' ? value.replace(ROOT, '<root>') : value);

async function step(repo, name, argv) {
  const result = await runCommand(repo, [...argv, '--json'], { providers: repo.providers });
  const { packet } = { packet: JSON.parse(result.stdout) };
  const { data } = packet;
  return JSON.parse(JSON.stringify({
    step: name,
    exit_code: result.exitCode,
    status: packet.status,
    kind: data.kind,
    findings: packet.findings.map(({ code }) => code),
    next: packet.next_commands.map(({ command, args }) => [command, ...args.filter((arg) => !arg.startsWith('sha256:'))]),
    facts: data.kind === 'road_lifecycle'
      ? { transition: data.transition, from: data.road.from, to: data.road.to, checks: data.checks, audit: data.audit?.status ?? null, changed_files: data.changed_files, closure: data.closure?.action ?? null, lease: data.lease }
      : (data.kind === 'verify_road' ? { outcome: data.outcome, summary: data.summary } : (data.kind === 'audit' ? { status: data.audit.status, counts: data.audit.counts } : null)),
  }, normalize));
}

async function produce(t) {
  const { repo } = await lifecycleWorld(t, { status: 'ACTIVE', git: true });
  await put(repo, 'src/own.js', 'after\n');
  await put(repo, 'src/admin.js', 'new\n');
  const out = [];
  out.push(await step(repo, 'details', ['road-details', 'R-P6-1', '--role', 'worker']));
  out.push(await step(repo, 'verify', ['verify', '--road', 'R-P6-1']));
  out.push(await step(repo, 'audit', ['audit', '--git', '--road', 'R-P6-1']));
  out.push(await step(repo, 'check', ['road', 'check', 'R-P6-1']));
  out.push(await step(repo, 'finish', ['road', 'finish', 'R-P6-1', '--if-snapshot', await snapshotOf(repo, 'road-finish')]));
  out.push(await step(repo, 'reopen', ['road', 'reopen', 'R-P6-1', '--if-snapshot', await snapshotOf(repo, 'road-reopen')]));
  out.push(await step(repo, 'activate', ['road', 'activate', 'R-P6-1', '--if-snapshot', await snapshotOf(repo, 'road-activate')]));
  out.push(await step(repo, 'finish_again', ['road', 'finish', 'R-P6-1', '--if-snapshot', await snapshotOf(repo, 'road-finish')]));
  return out;
}

test('the committed lifecycle-integration golden equals what the CLI produces for the fixed world', async (t) => {
  const actual = await produce(t);
  if (process.env.AKRS_REGENERATE_LIFECYCLE === '1') await writeFile(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(actual, JSON.parse(await readFile(GOLDEN, 'utf8')));
});

test('the golden loop ends DONE with one closure, and a failed step never reaches finish', async () => {
  const golden = JSON.parse(await readFile(GOLDEN, 'utf8'));
  assert.deepEqual(golden.map(({ step: name }) => name), ['details', 'verify', 'audit', 'check', 'finish', 'reopen', 'activate', 'finish_again']);
  assert.deepEqual(golden.map(({ exit_code: code }) => code), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(golden.find(({ step: name }) => name === 'finish').facts.closure, 'appended');
  assert.equal(golden.find(({ step: name }) => name === 'finish_again').facts.closure, 'already_recorded');
});
