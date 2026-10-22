// P2-W16 through the real entry point: help, the packaged package root, and a child process whose home and config roots are sentinels.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runAgentsDefault } from './support.js';
import { byteTreeHash } from '../helpers/byte-tree.js';
import { runProcess } from '../helpers/process.js';
import { createTempRepository } from '../helpers/temp-repository.js';
import { ALL_AGENTS, makeWorld, readTree } from './support.js';

const CLI = fileURLToPath(new URL('../../bin/akrs.js', import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '').replaceAll('\\', '/');

test('help lists the three commands with their flags', async () => {
  const run = await runProcess(process.execPath, [CLI, '--help', '--json']);
  const help = JSON.parse(run.stdout).data.commands.filter(({ id }) => id.startsWith('agents-'));
  assert.deepEqual(help.map(({ invocation }) => invocation), ['akrs agents setup', 'akrs agents doctor', 'akrs agents list']);
  assert.deepEqual(help[0].options.map(({ name }) => name), ['--agent', '--pi-mcp', '--dry-run']);
});

test('with the real package root every path a config points at exists and the packaged skills become valid pointers', async (t) => {
  const world = await makeWorld(t);
  const run = await runAgentsDefault(world, ['setup']);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(run.packet.status, 'ok');
  const tree = await readTree(world.repo.root);
  const entry = JSON.parse(tree['.mcp.json']).mcpServers.akrs;
  assert.deepEqual(entry, { command: 'node', args: [`${PACKAGE_ROOT}/bin/akrs.js`, 'mcp'] });
  assert.equal(existsSync(entry.args[0]), true);
  const hook = JSON.parse(tree['.claude/settings.local.json']).hooks.PreToolUse[0].hooks[0].command;
  assert.equal(hook, `node "${PACKAGE_ROOT}/bin/akrs-guard.js"`);
  assert.equal(existsSync(`${PACKAGE_ROOT}/bin/akrs-guard.js`), true);
  const skills = Object.keys(tree).filter((path) => path.startsWith('.agents/skills/'));
  assert.deepEqual(skills.sort(), ['akrs-classify-executors', 'akrs-close-out', 'akrs-live-verify', 'akrs-road-author', 'akrs-scope-request', 'akrs-work-loop'].map((name) => `.agents/skills/${name}/SKILL.md`));
  assert.equal((await runAgentsDefault(world, ['doctor'])).packet.status, 'ok');
  assert.equal((await runAgentsDefault(world, ['setup'])).packet.status, 'noop');
});

test('the written guard hook command really runs: it denies a CLI-owned path with exit 2 and allows a product path', async (t) => {
  const world = await makeWorld(t, { repoFiles: { 'akrs/roads/.keep': '' } });
  await runAgentsDefault(world, ['setup', '--agent', 'claude']);
  const settings = JSON.parse(await readFile(join(world.repo.root, '.claude/settings.local.json'), 'utf8'));
  const command = settings.hooks.PreToolUse[0].hooks[0].command;
  const script = /^node "(.+)"$/.exec(command)[1];
  const payload = (path) => JSON.stringify({ tool_input: { file_path: path } });
  const allowed = await runProcess(process.execPath, [script], { cwd: world.repo.root, stdin: payload(join(world.repo.root, 'src', 'a.js')) });
  assert.equal(allowed.exitCode, 0);
  const denied = await runProcess(process.execPath, [script], { cwd: world.repo.root, stdin: payload(join(world.repo.root, 'akrs', 'roads', 'x.json')) });
  assert.equal(denied.exitCode, 2);
});

test('a child process with home, config and temp roots pointed at sentinels never touches them', async (t) => {
  const world = await makeWorld(t);
  const sentinel = await createTempRepository(t, { prefix: 'akrs-agents-sentinel-' });
  const env = { HOME: sentinel.root, USERPROFILE: sentinel.root, APPDATA: sentinel.root, LOCALAPPDATA: sentinel.root, XDG_CONFIG_HOME: sentinel.root, CODEX_HOME: sentinel.root };
  const before = await byteTreeHash(sentinel.root);
  const setup = await runProcess(process.execPath, [CLI, 'agents', 'setup', '--root', world.repo.root, '--json'], { cwd: world.repo.root, env });
  assert.equal(setup.exitCode, 0, setup.stderr);
  const packet = JSON.parse(setup.stdout);
  assert.deepEqual(packet.data.agents, ALL_AGENTS);
  for (const sub of ['doctor', 'list']) {
    const run = await runProcess(process.execPath, [CLI, 'agents', sub, '--root', world.repo.root, '--json'], { cwd: world.repo.root, env });
    assert.equal(run.exitCode, 0, run.stderr);
  }
  assert.equal(await byteTreeHash(sentinel.root), before);
  assert.deepEqual(await readdir(sentinel.root), []);
});

test('setup --dry-run through the process prints one JSON packet and writes nothing', async (t) => {
  const world = await makeWorld(t);
  const before = await byteTreeHash(world.repo.root);
  const run = await runProcess(process.execPath, [CLI, 'agents', 'setup', '--agent', 'codex', '--dry-run', '--root', world.repo.root, '--json']);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).data.dry_run, true);
  assert.equal(run.stderr, '');
  assert.equal(await byteTreeHash(world.repo.root), before);
});
