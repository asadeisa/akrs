import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runCli } from '../helpers/process.js';

const packageJson = JSON.parse(await readFile(
  new URL('../../package.json', import.meta.url),
  'utf8',
));

test('bare CLI and --help render manifest-backed help with exit 0', async () => {
  for (const args of [[], ['--help']]) {
    const result = await runCli(args);
    assert.equal(result.exitCode, 0, args.join(' '));
    assert.equal(result.stderr, '', args.join(' '));
    assert.match(result.stdout, /^AKRS — Adaptive Knowledge Routing System/m);
    assert.match(result.stdout, /--help/);
    assert.match(result.stdout, /--version/);
  }
});

test('--version reports CLI, schema, and doctrine versions with exit 0', async () => {
  const result = await runCli(['--version']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, new RegExp(`^AKRS CLI ${packageJson.version}$`, 'm'));
  assert.match(result.stdout, new RegExp(`^Doctrine ${packageJson.version}$`, 'm'));
  assert.match(result.stdout, /^Packet schema akrs\.packet\/v2$/m);
  assert.match(result.stdout, /^Event schema akrs\.event\/v1$/m);
  assert.match(result.stdout, /^Manifest schema akrs\.command-manifest\/v1$/m);
});

test('unknown commands, flags, and abbreviated flags exit 2', async () => {
  for (const args of [['unknown'], ['--help', '--unknown'], ['-h']]) {
    const result = await runCli(args);
    assert.equal(result.exitCode, 2, args.join(' '));
    assert.equal(result.stdout, '', args.join(' '));
    assert.match(result.stderr, /AKRS-C001/);
    assert.match(result.stderr, /ERROR/);
  }
});

test('--json writes one parseable packet and no diagnostic bytes', async () => {
  const result = await runCli(['--version', '--json']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.endsWith('\n'), true);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.schema_version, 'akrs.packet/v2');
  assert.equal(packet.command, 'version');
  assert.equal(packet.data.cli_version, packageJson.version);
  assert.equal(result.stdout.includes('\u001b['), false);
  assert.equal(/[✅❌⚠✖]/u.test(result.stdout), false);
});

test('an unknown command is a structured usage packet when JSON is requested', async () => {
  const result = await runCli(['unknown', '--json']);
  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, '');
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.status, 'error');
  assert.equal(packet.findings[0].code, 'AKRS-C001');
  assert.equal(packet.findings[0].severity, 'error');
});
