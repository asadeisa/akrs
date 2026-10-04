// P2-W04 golden: the exact JSONL event sequences of `verify --road --jsonl` under deterministic time, run IDs and
// durations, byte-compared to committed JSON. Machine-dependent values (the root, inherited environment names) are
// replaced by placeholders. Regenerate with AKRS_REGENERATE_STREAM_EVENTS=1 only after reviewing why the contract changed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fakeProviders, runCommand } from '../../road/support.js';
import { verifyWorld } from '../../verify-road/support.js';

const GOLDEN = new URL('./expected.json', import.meta.url);
// `node` through PATH, never an absolute path: the Road's content (and so its snapshot) must not depend on the machine.
const nodeCheck = (name, script, args = [], timeout_ms = 30_000) => ({ name, argv: ['node', '-e', script, ...args], timeout_ms });
const providers = () => {
  let tick = 0;
  return { ...fakeProviders(), monotonic: () => { tick += 5; return tick; } };
};

async function produce(t) {
  const { repo } = await verifyWorld(t, [
    nodeCheck('unit', 'process.stdout.write("12 passed")'),
    nodeCheck('lint', 'process.stderr.write("lint: 2 problems"); process.exit(4)'),
  ]);
  const out = {};
  for (const [name, args] of [['run', ['--jsonl']], ['dry_run', ['--jsonl', '--dry-run']], ['blocked', ['--jsonl', '--check', 'nope']], ['plain_json', ['--json']]]) {
    const result = await runCommand(repo, ['verify', '--road', 'R-P6-1', ...args], { providers: providers() });
    const text = result.stdout.replaceAll(JSON.stringify(repo.root).slice(1, -1), '<root>');
    const parsed = args.includes('--jsonl') ? text.trimEnd().split('\n').map((line) => JSON.parse(line)) : JSON.parse(text);
    out[name] = JSON.parse(JSON.stringify({ exit_code: result.exitCode, output: parsed }, (key, value) => (key === 'inherited' && Array.isArray(value) ? ['<machine-dependent names>'] : value)));
  }
  return out;
}

test('the committed stream-events golden equals what the CLI streams for the fixed world', async (t) => {
  const actual = await produce(t);
  if (process.env.AKRS_REGENERATE_STREAM_EVENTS === '1') await writeFile(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(actual, JSON.parse(await readFile(GOLDEN, 'utf8')));
});

test('the golden stream is ordered facts ending in the very packet --json returns', async () => {
  const golden = JSON.parse(await readFile(GOLDEN, 'utf8'));
  const events = golden.run.output;
  assert.deepEqual(events.map(({ type }) => type), ['started', 'progress', 'evidence', 'progress', 'progress', 'evidence', 'progress', 'finding', 'complete']);
  assert.deepEqual(events.map(({ sequence }) => sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(events.at(-1).data.packet, golden.plain_json.output);
  assert.deepEqual(golden.blocked.output.map(({ type }) => type), ['complete']);
  assert.deepEqual(golden.dry_run.output.map(({ type }) => type), ['started', 'complete']);
  assert.equal(golden.run.exit_code, 1);
});
