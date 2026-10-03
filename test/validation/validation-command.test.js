import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runCliAdapter } from '../../bin/cli-adapter.js';
import {
  VALIDATION_CHECK_MANIFEST,
  commandHandlers,
  commandManifest,
} from '../../lib/core/index.js';

const providers = {
  now: () => '2026-08-25T10:30:00.000Z',
  runId: () => '01ARZ3NDEKTSV4RRFFQ69G5FAV',
};
const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, '..', 'fixtures');

async function copyFixture(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'akrs-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(source, root, { recursive: true });
  return root;
}

async function validate(root, format = '--json') {
  return runCliAdapter({
    argv: ['validate', '--root', root, '--workflow-root', join(root, 'akrs'), format],
    cwd: root,
    manifest: commandManifest,
    handlers: commandHandlers,
    providers,
  });
}

test('manifest enables only complete P0-W03, P0-W04, and P0-W06 commands', () => {
  assert.deepEqual(commandManifest.commands.map(({ id }) => id), [
    'help', 'version', 'validate', 'explain', 'init', 'sync', 'postinstall',
  ]);
});

test('table-form required legacy input reports skipped coverage with examined count zero', async (t) => {
  for (const source of [
    join(fixtureRoot, 'validation', 'coverage-zero'),
    join(fixtureRoot, 'legacy', 'road-table-expected-files'),
  ]) {
    const root = await copyFixture(t, source);
    const result = await validate(root);

    assert.equal(result.exitCode, 1);
    const packet = JSON.parse(result.stdout);
    const check = packet.data.checks.find(({ check }) => check === 'legacy-expected-files');
    assert.deepEqual(check, {
      check: 'legacy-expected-files',
      status: 'skipped',
      examined_count: 0,
      finding_count: 1,
      reason: 'required Expected files input was not readable by the legacy parser',
    });
    assert.equal(packet.findings.some(({ code }) => code === 'AKRS-R004'), true);
    assert.equal(packet.data.coverage.skipped, 1);
    assert.equal(packet.data.coverage.passed + packet.data.coverage.failed
      + packet.data.coverage.skipped + packet.data.coverage.not_applicable,
    packet.data.coverage.total_checks);
  }
});

test('a legitimate empty readiness check is not applicable', async (t) => {
  const root = await copyFixture(t,
    join(fixtureRoot, 'validation', 'coverage-not-applicable'));
  const result = await validate(root);
  const packet = JSON.parse(result.stdout);
  const check = packet.data.checks.find(({ check }) => check === 'dependency-readiness');

  assert.equal(result.exitCode, 0);
  assert.equal(check.status, 'not_applicable');
  assert.equal(check.examined_count, 0);
  assert.equal(packet.data.coverage.not_applicable > 0, true);
});

test('regression manifest proves every expected check ran, skipped, or was not applicable', async (t) => {
  const root = await copyFixture(t,
    join(fixtureRoot, 'validation', 'dependency-graph'));
  const result = await validate(root);
  const packet = JSON.parse(result.stdout);

  assert.deepEqual(packet.data.checks.map(({ check }) => check),
    VALIDATION_CHECK_MANIFEST.map(({ id }) => id));
  assert.equal(packet.data.checks.every(({ status }) =>
    ['passed', 'failed', 'skipped', 'not_applicable'].includes(status)), true);
  assert.equal(packet.findings.some(({ code, file }) =>
    code === 'AKRS-R005' && file === 'akrs/roads/Q.md'), true);
  assert.equal(packet.findings.some(({ code }) => code === 'AKRS-R006'), true);
});

test('nested duplicate fixture produces stable duplicate findings without hiding a Road', async (t) => {
  const root = await copyFixture(t,
    join(fixtureRoot, 'legacy', 'road-nested-plans'));
  const result = await validate(root);
  const packet = JSON.parse(result.stdout);

  assert.equal(result.exitCode, 1);
  assert.deepEqual(packet.findings.filter(({ code }) => code === 'AKRS-R001')
    .map(({ file }) => file), [
    'akrs/roads/P1/R1.md', 'akrs/roads/P2/R1.md',
  ]);
  assert.equal(packet.data.checks.find(({ check }) => check === 'road-identities').status,
    'failed');
  assert.equal(packet.data.checks.find(({ check }) => check === 'dependency-references').status,
    'skipped');
});

test('human and JSON validation outputs project the same packet and coverage counts', async (t) => {
  const root = await copyFixture(t,
    join(fixtureRoot, 'validation', 'dependency-graph'));
  const jsonResult = await validate(root);
  const humanResult = await validate(root, '--prompt');
  const packet = JSON.parse(jsonResult.stdout);

  assert.deepEqual(humanResult.packet, packet);
  assert.match(humanResult.stdout, /"coverage"/);

  const human = await runCliAdapter({
    argv: ['validate', '--root', root, '--workflow-root', join(root, 'akrs')],
    cwd: root,
    manifest: commandManifest,
    handlers: commandHandlers,
    providers,
  });
  assert.deepEqual(human.packet, packet);
  assert.match(human.stderr, new RegExp(
    `Coverage: ${packet.data.coverage.total_checks} checks — `
      + `${packet.data.coverage.passed} passed, ${packet.data.coverage.failed} failed, `
      + `${packet.data.coverage.skipped} skipped, `
      + `${packet.data.coverage.not_applicable} not applicable`,
  ));
});

test('fixture files retain exact intended content', async () => {
  const queued = await readFile(join(
    fixtureRoot, 'validation', 'coverage-not-applicable', 'akrs', 'roads', 'R1.md'), 'utf8');
  assert.equal(queued, '# Road R1\n\nStatus: QUEUED\n\n## Expected files\n\n- `README.md`\n');

  for (const fixture of [
    'coverage-zero', 'coverage-not-applicable', 'dependency-graph', 'finding-order',
  ]) {
    const provenance = JSON.parse(await readFile(join(
      fixtureRoot, 'validation', fixture, 'provenance.json'), 'utf8'));
    assert.equal(provenance.fixture, fixture);
    assert.equal(provenance.kind, 'synthetic-regression');
    assert.equal(provenance.runtimeFiles.length > 0, true);
  }
});
