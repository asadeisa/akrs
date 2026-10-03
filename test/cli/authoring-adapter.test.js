// P1-W06 adapter additions: the `--json -` stdin marker, usage packets mapping to exit 2, and manifest-token
// rendering of next commands.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCliAdapter } from '../../bin/cli-adapter.js';
import { createPacket } from '../../lib/core/packet.js';
import { renderHuman } from '../../lib/renderers/human.js';
import { renderPrompt } from '../../lib/renderers/prompt.js';

const RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SNAPSHOT = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const providers = { now: () => '2026-08-25T10:30:00.000Z', runId: () => RUN_ID };
const flag = (name, value_type = 'boolean') => ({ name, value_type, required: false, repeatable: false });

function entry(overrides = {}) {
  return {
    id: 'probe-new',
    tokens: ['probe', 'new'],
    summary: 'Exercise the CLI adapter.',
    input_schema: 'akrs.command-input/probe-new/v1',
    positionals: [],
    flags: [flag('--json'), flag('--jsonl'), flag('--prompt'), flag('--input', 'path')],
    required_role: 'leader',
    mutability: 'mutation',
    dry_run: true,
    idempotency: 'journal',
    expected_snapshot: 'revalidate',
    snapshot_inputs: [],
    streaming: 'none',
    output_schema: 'akrs.command-output/probe-new/v1',
    statuses: ['ok', 'warning', 'error', 'blocked', 'noop'],
    exit_codes: [0, 1, 2, 3, 4],
    next_command_builder: 'none',
    mcp_tool: null,
    mcp_action: null,
    ...overrides,
  };
}

const manifestOf = (...commands) => ({ schema_version: 'akrs.command-manifest/v1', commands, reserved_commands: [] });
const probePacket = ({ status = 'ok', data = { observed: true }, nextCommands = [] } = {}) => createPacket({
  command: 'probe-new', status, root: '/project', snapshot: { before: SNAPSHOT, after: SNAPSHOT }, data, nextCommands, providers,
  knownCommands: ['probe-new'],
});

test('`--json -` selects stdin as the input channel and implies JSON output; the handler reads stdin lazily', async () => {
  let reads = 0;
  let seen;
  const result = await runCliAdapter({
    argv: ['probe', 'new', '--json', '-'],
    cwd: '/project',
    manifest: manifestOf(entry()),
    handlers: { 'probe-new': async (parameters) => { seen = parameters; return probePacket(); } },
    providers,
    readStdin: async () => { reads += 1; return Buffer.from('{"a":1}'); },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(seen.input.stdin, true);
  assert.equal(seen.input.format, 'json');
  assert.equal(seen.input.flags['--json'], true);
  assert.equal(reads, 0, 'the adapter does not read stdin itself');
  assert.deepEqual(await seen.readStdin(), Buffer.from('{"a":1}'));
  assert.equal(reads, 1);
  assert.equal(JSON.parse(result.stdout).command, 'probe-new');
});

test('without the marker stdin is not selected, and `--json` alone stays an output flag', async () => {
  let seen;
  await runCliAdapter({
    argv: ['probe', 'new', '--json'],
    cwd: '/project',
    manifest: manifestOf(entry()),
    handlers: { 'probe-new': async (parameters) => { seen = parameters; return probePacket(); } },
    providers,
  });
  assert.equal(seen.input.stdin, false);
});

test('the lone dash is accepted only directly after --json and only by a command that declares --input', async () => {
  const handlers = { 'probe-new': async () => probePacket(), probe: async () => probePacket() };
  const plain = entry({ id: 'probe', tokens: ['probe'], flags: [flag('--json'), flag('--jsonl'), flag('--prompt')], input_schema: 'akrs.command-input/probe/v1', output_schema: 'akrs.command-output/probe/v1' });
  for (const [argv, expectedExit] of [
    [['probe', 'new', '--prompt', '-'], 2],
    [['probe', 'new', '-', '--json'], 2],
    [['probe', 'new', '--json', '-', '-'], 2],
    [['probe', 'new', '--json', '-', '--json'], 2],
    [['probe', '--json', '-'], 2],
    [['probe', 'new', '--json', '-'], 0],
  ]) {
    const result = await runCliAdapter({
      argv, cwd: '/project', manifest: manifestOf(entry(), plain), handlers, providers, readStdin: async () => Buffer.alloc(0),
    });
    assert.equal(result.exitCode, expectedExit, argv.join(' '));
  }
});

test('a handler packet whose data.kind is usage exits 2 when the command declares 2, otherwise 1', async () => {
  const usage = probePacket({ status: 'error', data: { kind: 'usage', reason: 'x' } });
  const withFinding = createPacket({
    command: 'probe-new', status: 'error', root: '/project', snapshot: { before: SNAPSHOT, after: SNAPSHOT },
    data: { kind: 'usage', reason: 'x' },
    findings: [{ code: 'AKRS-C008', severity: 'error', message: 'bad', file: null, line: null, detail: {} }],
    providers, knownCommands: ['probe-new'],
  });
  const run = (packet, exits) => runCliAdapter({
    argv: ['probe', 'new', '--json'], cwd: '/project', manifest: manifestOf(entry({ exit_codes: exits })),
    handlers: { 'probe-new': async () => packet }, providers,
  });
  assert.equal((await run(withFinding, [0, 1, 2, 3, 4])).exitCode, 2);
  assert.equal((await run(usage, [0, 1, 2, 3, 4])).exitCode, 2, 'a usage packet without findings is still a usage error');
  assert.equal((await run(withFinding, [0, 1, 3, 4])).exitCode, 1);
  const findings = createPacket({
    command: 'probe-new', status: 'error', root: '/project', snapshot: { before: SNAPSHOT, after: SNAPSHOT },
    data: { kind: 'findings' },
    findings: [{ code: 'AKRS-R001', severity: 'error', message: 'dup', file: null, line: null, detail: {} }],
    providers, knownCommands: ['probe-new'],
  });
  assert.equal((await run(findings, [0, 1, 2, 3, 4])).exitCode, 1);
  assert.equal((await run(probePacket({ status: 'noop' }), [0, 1, 2, 3, 4])).exitCode, 0);
});

test('renderers print next commands with the manifest tokens when they are supplied, and fall back to the id otherwise', () => {
  const packet = probePacket({ nextCommands: [{ command: 'probe-new', args: ['--input', 'akrs/drafts/a.json'] }] });
  const known = ['probe-new'];
  const commandTokens = new Map([['probe-new', ['probe', 'new']]]);
  assert.match(renderHuman(packet, { knownCommands: known, commandTokens }), /^ {2}akrs probe new --input akrs\/drafts\/a\.json$/m);
  assert.match(renderPrompt(packet, { knownCommands: known, commandTokens }), /^- `akrs probe new --input akrs\/drafts\/a\.json`$/m);
  assert.match(renderHuman(packet, { knownCommands: known }), /^ {2}akrs probe-new --input akrs\/drafts\/a\.json$/m);
});

test('the adapter feeds its renderers the manifest tokens, so a non-ok packet prints a pasteable command', async () => {
  const packet = probePacket({ status: 'error', data: { kind: 'usage' }, nextCommands: [{ command: 'probe-new', args: ['--input', 'x.json'] }] });
  const result = await runCliAdapter({
    argv: ['probe', 'new'], cwd: '/project', manifest: manifestOf(entry()), handlers: { 'probe-new': async () => packet }, providers,
  });
  assert.match(result.stderr, /akrs probe new --input x\.json/);
});
