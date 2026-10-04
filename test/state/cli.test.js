import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { createRepo, runCommand, seedPlan, seedRoad } from './support.js';

test('manifest declares state set (leader, akrs_write/state_set) and state render, both journaled mutations', () => {
  const set = commandManifest.commands.find(({ id }) => id === 'state-set');
  const render = commandManifest.commands.find(({ id }) => id === 'state-render');
  assert.deepEqual(set.tokens, ['state', 'set']);
  assert.equal(set.required_role, 'leader');
  assert.deepEqual([set.mcp_tool, set.mcp_action], ['akrs_write', 'state_set']);
  assert.deepEqual(render.tokens, ['state', 'render']);
  for (const entry of [set, render]) {
    assert.equal(entry.mutability, 'mutation');
    assert.equal(entry.idempotency, 'journal');
    assert.equal(entry.dry_run, true);
  }
  assert.equal(render.mcp_tool, null);
});

test('the CLI sets and renders: flat flags, --clear, usage errors exit 2', async (t) => {
  const repo = await createRepo(t);
  await seedPlan(repo, 'P6');
  await seedRoad(repo, { id: 'R-P6-1', plan: 'P6' }, { folder: 'roads/P6', status: 'ACTIVE' });
  const none = await runCommand(repo, ['state', 'set', '--json']);
  assert.equal(none.exitCode, 2);
  const bad = await runCommand(repo, ['state', 'set', '--mode', 'seven', '--json']);
  assert.equal(bad.exitCode, 2);
  const good = await runCommand(repo, ['state', 'set', '--mode', '3', '--role', 'leader', '--plan', 'P6', '--next', 'Ship it', '--json']);
  assert.equal(good.exitCode, 0, good.stdout + good.stderr);
  const packet = JSON.parse(good.stdout);
  assert.equal(packet.command, 'state-set');
  assert.deepEqual(packet.changed, ['STATE.md', 'state.json']);
  const cleared = await runCommand(repo, ['state', 'set', '--clear', 'plan', '--json']);
  assert.equal(cleared.exitCode, 0);
  assert.equal(JSON.parse(await repo.read('akrs/state.json')).plan, null);
  await repo.write('akrs/STATE.md', 'stale\n');
  const rendered = await runCommand(repo, ['state', 'render', '--json']);
  assert.equal(rendered.exitCode, 0, rendered.stdout + rendered.stderr);
  assert.equal(JSON.parse(rendered.stdout).command, 'state-render');
  assert.match(await repo.read('akrs/STATE.md'), /^# STATE\n/);
});
