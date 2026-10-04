import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRepo, seedRoad } from '../road/support.js';
import { runCliAdapter } from '../../bin/cli-adapter.js';
import {
  commandHandlers,
  commandManifest,
} from '../../lib/core/index.js';
import { VALIDATION_CHECK_MANIFEST } from '../../lib/validation/canonical.js';

const providers = {
  now: () => '2026-08-25T10:30:00.000Z',
  runId: () => '01ARZ3NDEKTSV4RRFFQ69G5FAV',
};

async function validate(root, format = '--json') {
  return runCliAdapter({
    argv: ['validate', '--root', root, '--workflow-root', join(root, 'akrs'), format],
    cwd: root,
    manifest: commandManifest,
    handlers: commandHandlers,
    providers,
  });
}

test('manifest enables only complete P0-W03, P0-W04, P0-W06, P1-W06, P1-W08, P1-W09, P1-W07, P1-W10, P1-W11, P1-W12, P1-W15, and P1-W13 commands', () => {
  assert.deepEqual(commandManifest.commands.map(({ id }) => id), [
    'help', 'version', 'validate', 'explain', 'init', 'sync', 'postinstall', 'road-new', 'task-new', 'memory-add', 'log-append', 'road-update', 'road-move',
    'scope-request', 'scope-approve', 'scope-reject', 'scope-list', 'test-define', 'test-handoff', 'state-set', 'state-render', 'init-scaffold', 'executor-set', 'executor-remove', 'executor-list', 'road-fit', 'road-details', 'verify', 'road-check', 'road-activate', 'road-finish', 'road-reopen', 'lease-release', 'audit', 'doctor', 'template',
  ]);
});

test('validate reports honest coverage over a v2 workflow and the check manifest is the registry', async (t) => {
  const repo = await createRepo(t);
  await seedRoad(repo, { id: 'R-A', plan: null, deps: ['R-MISSING'] }, { folder: 'roads' });
  const result = await validate(repo.root);
  const packet = JSON.parse(result.stdout);

  assert.deepEqual(packet.data.checks.map(({ check }) => check), VALIDATION_CHECK_MANIFEST.map(({ id }) => id));
  assert.equal(packet.data.checks.every(({ status }) => ['passed', 'failed', 'skipped', 'not_applicable'].includes(status)), true);
  assert.equal(packet.data.legacy_characterization, false);
  assert.equal(packet.findings.some(({ code, detail }) => code === 'AKRS-R005' && detail.dependency === 'R-MISSING'), true);
  assert.equal(packet.data.checks.find(({ check }) => check === 'dependency-references').status, 'failed');
});

test('human and JSON validation outputs project the same packet and coverage counts', async (t) => {
  const repo = await createRepo(t);
  await seedRoad(repo, { id: 'R-A', plan: null, deps: ['R-MISSING'] }, { folder: 'roads' });
  const root = repo.root;
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
