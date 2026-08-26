import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WorkflowNotFoundError,
  runCliAdapter,
} from '../../bin/cli-adapter.js';
import { createPacket } from '../../lib/core/packet.js';

const RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SNAPSHOT = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const providers = {
  now: () => '2026-08-25T10:30:00.000Z',
  runId: () => RUN_ID,
};

const outputFlags = [
  { name: '--json', value_type: 'boolean', required: false, repeatable: false },
  { name: '--jsonl', value_type: 'boolean', required: false, repeatable: false },
  { name: '--prompt', value_type: 'boolean', required: false, repeatable: false },
];

function entry(overrides = {}) {
  return {
    id: 'probe',
    tokens: ['probe'],
    summary: 'Exercise the CLI adapter.',
    input_schema: 'akrs.command-input/probe/v1',
    positionals: [],
    flags: [
      ...outputFlags,
      { name: '--workflow-root', value_type: 'path', required: false, repeatable: false },
    ],
    required_role: 'any',
    mutability: 'query',
    dry_run: false,
    idempotency: 'not_applicable',
    expected_snapshot: 'not_applicable',
    snapshot_inputs: [],
    streaming: 'none',
    output_schema: 'akrs.command-output/probe/v1',
    statuses: ['ok', 'warning', 'error', 'blocked'],
    exit_codes: [0, 1, 2, 3, 4],
    next_command_builder: 'none',
    ...overrides,
  };
}

function manifest(command = entry()) {
  return { schema_version: 'akrs.command-manifest/v1', commands: [command] };
}

function packet({ status = 'ok', findings = [] } = {}) {
  return createPacket({
    command: 'probe',
    status,
    root: 'E:/project',
    snapshot: { before: SNAPSHOT, after: SNAPSHOT },
    data: { observed: true },
    findings,
    providers,
    knownCommands: ['probe'],
  });
}

const finding = {
  code: 'AKRS-C024',
  severity: 'warning',
  message: 'Stable machine identity.',
  file: null,
  line: null,
  detail: {},
};

test('missing option values fail before context resolution or core invocation', async () => {
  let resolved = 0;
  let invoked = 0;
  const result = await runCliAdapter({
    argv: ['probe', '--workflow-root', '--json'],
    cwd: 'E:/project',
    manifest: manifest(),
    handlers: { probe: async () => { invoked += 1; return packet(); } },
    resolveContext: async () => { resolved += 1; return {}; },
    providers,
  });

  assert.equal(result.exitCode, 2);
  assert.equal(resolved, 0);
  assert.equal(invoked, 0);
  assert.equal(JSON.parse(result.stdout).findings[0].code, 'AKRS-C001');
  assert.equal(result.stderr, '');
});

test('invalid formats, non-streaming JSONL, and extra positionals fail before core', async () => {
  for (const argv of [
    ['probe', '--json', '--prompt'],
    ['probe', '--jsonl'],
    ['probe', 'extra'],
    ['probe', '-j'],
  ]) {
    let invoked = 0;
    const result = await runCliAdapter({
      argv,
      cwd: 'E:/project',
      manifest: manifest(),
      handlers: { probe: async () => { invoked += 1; return packet(); } },
      providers,
    });
    assert.equal(result.exitCode, 2, argv.join(' '));
    assert.equal(invoked, 0, argv.join(' '));
  }
});

test('workflow absence maps to exit 3 and a clean JSON packet', async () => {
  const result = await runCliAdapter({
    argv: ['probe', '--json'],
    cwd: 'E:/project',
    manifest: manifest(),
    handlers: { probe: async () => packet() },
    resolveContext: async () => { throw new WorkflowNotFoundError('akrs'); },
    providers,
  });

  assert.equal(result.exitCode, 3);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).findings[0].code, 'AKRS-C003');
});

test('internal exceptions map to exit 4 without partial JSON stdout', async () => {
  const result = await runCliAdapter({
    argv: ['probe', '--json'],
    cwd: 'E:/project',
    manifest: manifest(),
    handlers: { probe: async () => { throw new Error('controlled failure'); } },
    providers,
  });

  assert.equal(result.exitCode, 4);
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.findings[0].code, 'AKRS-C004');
  assert.equal(parsed.findings[0].severity, 'error');
  assert.equal(result.stdout, `${JSON.stringify(parsed, null, 2)}\n`);
});

test('renderer exceptions are buffered and map to exit 4', async () => {
  const malformedHelpData = createPacket({
    command: 'probe',
    status: 'ok',
    root: 'E:/project',
    snapshot: { before: SNAPSHOT, after: SNAPSHOT },
    data: { kind: 'help' },
    providers,
    knownCommands: ['probe'],
  });
  const result = await runCliAdapter({
    argv: ['probe'],
    cwd: 'E:/project',
    manifest: manifest(),
    handlers: { probe: async () => malformedHelpData },
    providers,
  });

  assert.equal(result.exitCode, 4);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /ERROR AKRS-C004/);
});

test('failed, blocked, and finding-bearing packets map to exit 1', async () => {
  for (const returned of [
    packet({ status: 'error' }),
    packet({ status: 'blocked' }),
    packet({ findings: [finding] }),
  ]) {
    const result = await runCliAdapter({
      argv: ['probe', '--json'],
      cwd: 'E:/project',
      manifest: manifest(),
      handlers: { probe: async () => returned },
      providers,
    });
    assert.equal(result.exitCode, 1, returned.status);
    assert.deepEqual(JSON.parse(result.stdout), returned);
  }
});

test('human finding output is written to stderr, not stdout', async () => {
  const result = await runCliAdapter({
    argv: ['probe'],
    cwd: 'E:/project',
    manifest: manifest(),
    handlers: { probe: async () => packet({ findings: [finding] }) },
    providers,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /WARNING AKRS-C024/);
});
