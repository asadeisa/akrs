// P2-W10: the packaged example is a working v2 workflow. It validates clean, answers the Worker and Tester queries without writing a
// byte, and the packets it produces equal committed goldens. Regenerate with AKRS_REGENERATE_EXAMPLE_PACKETS=1 only after reviewing
// why a packet changed.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { byteTreeHash } from '../helpers/byte-tree.js';
import { runCli } from '../helpers/process.js';
import { REPOSITORY } from './support.js';

const GOLDEN = new URL('../fixtures/examples-minimal/expected.json', import.meta.url);
const EXAMPLE = join(REPOSITORY, 'examples', 'minimal');
const ROOT_ARGS = ['--root', 'examples/minimal', '--workflow-root', 'examples/minimal/akrs'];
const ABSOLUTE_ROOT = fileURLToPath(new URL('../../examples/minimal', import.meta.url)).replaceAll('\\', '/');

// machine-dependent values: the absolute root, the run ID and the clock
function normalize(value) {
  if (typeof value === 'string') return value.replaceAll('\\', '/').replaceAll(ABSOLUTE_ROOT, '<root>');
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !['run_id', 'timestamp'].includes(key)).map(([key, entry]) => [key, normalize(entry)]));
  }
  return value;
}

async function ask(args) {
  const out = {};
  for (const [name, flags] of [['json', ['--json']], ['prompt', ['--prompt']], ['human', []]]) {
    const result = await runCli([...args, ...ROOT_ARGS, ...flags], { cwd: REPOSITORY });
    assert.equal(result.exitCode, 0, `${args.join(' ')} ${name}: ${result.stderr}`);
    out[name] = name === 'json' ? JSON.parse(result.stdout) : result.stdout;
  }
  return normalize(out);
}

async function produce() {
  const validation = await runCli(['validate', ...ROOT_ARGS, '--json'], { cwd: REPOSITORY });
  assert.equal(validation.exitCode, 0, validation.stderr);
  const packet = JSON.parse(validation.stdout);
  return {
    validate: { status: packet.status, findings: packet.findings, coverage: packet.data.coverage },
    worker: await ask(['road-details', 'R1', '--role', 'worker']),
    tester: await ask(['test-details', 'R1']),
  };
}

test('examples/minimal validates clean, the Worker and Tester queries write nothing, and their packets equal the committed goldens', async () => {
  const before = await byteTreeHash(EXAMPLE);
  const actual = await produce();
  assert.equal(await byteTreeHash(EXAMPLE), before, 'a query never writes into the example');
  assert.deepEqual(actual.validate.findings, []);
  assert.equal(actual.validate.status, 'ok');
  assert.equal(actual.validate.coverage.failed, 0);
  assert.equal(actual.validate.coverage.skipped, 0);
  if (process.env.AKRS_REGENERATE_EXAMPLE_PACKETS === '1') await writeFile(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(actual, JSON.parse(await readFile(GOLDEN, 'utf8')));
});

test('the golden Worker packet carries the class-shaped Road and the golden Tester packet is the none-policy packet', async () => {
  const golden = JSON.parse(await readFile(GOLDEN, 'utf8'));
  assert.deepEqual([golden.worker.json.status, golden.worker.json.data.kind, golden.worker.json.data.role], ['ok', 'road_details', 'worker']);
  assert.match(golden.worker.prompt, /README\.md says what the project does\./);
  assert.deepEqual([golden.tester.json.status, golden.tester.json.data.policy, golden.tester.json.data.kind], ['ok', 'none', 'test_details']);
  assert.match(golden.tester.prompt, /Never edit product code\./);
  assert.equal(golden.tester.prompt.split('Never edit product code.').length - 1, 1, 'the no-product-edit rule appears once');
});

test('a fresh user route reaches scaffold, classified executors, a clean validate, the Worker packet and the Tester packet', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'akrs-docs-route-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const run = async (args) => {
    const result = await runCli([...args, '--json'], { cwd: project });
    return { exitCode: result.exitCode, packet: JSON.parse(result.stdout) };
  };
  assert.equal((await run(['init', '--scaffold'])).exitCode, 0);
  // the scaffold is honest: it asks for the executors before it validates clean
  const open = await run(['validate']);
  assert.deepEqual(open.packet.findings.map(({ code }) => code), ['AKRS-S006']);
  assert.equal((await run(['executor', 'set', 'lead', '--role', 'leader', '--class', 'frontier', '--label', 'Lead model', '--answer', 'frontier'])).exitCode, 0);
  assert.equal((await run(['executor', 'set', 'worker', '--role', 'worker', '--class', 'weak', '--label', 'Worker model', '--answer', 'weak'])).exitCode, 0);
  const clean = await run(['validate']);
  assert.deepEqual([clean.exitCode, clean.packet.status, clean.packet.findings], [0, 'ok', []]);
  const worker = await run(['road-details', 'R1', '--role', 'worker']);
  assert.deepEqual([worker.exitCode, worker.packet.status, worker.packet.data.role], [0, 'ok', 'worker']);
  const tester = await run(['test-details', 'R1']);
  assert.deepEqual([tester.exitCode, tester.packet.status, tester.packet.data.kind], [0, 'ok', 'test_details']);
});
