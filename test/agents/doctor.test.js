// P2-W16 `agents doctor` and `agents list`: queries that classify what setup manages and say explicitly what each agent can and cannot do.
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AGENT_REGISTRY } from '../../lib/agents/registry.js';
import { byteTreeHash } from '../helpers/byte-tree.js';
import { ALL_AGENTS, expectedFiles, makeWorld, runAgents, writeTree } from './support.js';

const states = (packet) => Object.fromEntries(packet.data.files.map(({ path, state }) => [path, state]));
const read = (world, path) => readFile(join(world.repo.root, path), 'utf8');

test('doctor on a repository nobody set up: every managed file is missing, the finding carries the exact setup command, nothing is written', async (t) => {
  const world = await makeWorld(t, { repoFiles: { 'README.md': 'x\n' } });
  const before = await byteTreeHash(world.repo.root);
  const run = await runAgents(world, ['doctor', '--agent', 'claude']);
  assert.equal(run.exitCode, 1);
  assert.deepEqual([run.packet.command, run.packet.status, run.packet.data.kind], ['agents-doctor', 'warning', 'agents_doctor']);
  assert.deepEqual(Object.keys(states(run.packet)), expectedFiles('claude'));
  assert.deepEqual([...new Set(Object.values(states(run.packet)))], ['missing']);
  assert.equal(run.packet.findings.length, expectedFiles('claude').length);
  const setup = `akrs agents setup --agent claude --root ${world.repo.root}`;
  for (const finding of run.packet.findings) {
    assert.equal(finding.code, 'AKRS-C021');
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.detail.reason, 'missing');
    assert.equal(finding.detail.agent, 'claude');
    assert.equal(finding.detail.setup, setup);
    assert.equal(finding.file, finding.detail.path);
  }
  assert.deepEqual(run.packet.next_commands, [{ command: 'agents-setup', args: ['--agent', 'claude', '--root', world.repo.root] }]);
  assert.deepEqual(run.packet.data.counts, { current: 0, missing: 6, outdated: 0, hand_modified: 0, conflict: 0 });
  assert.equal(run.packet.snapshot.before, run.packet.snapshot.after);
  assert.deepEqual(run.packet.changed, []);
  assert.equal(await byteTreeHash(world.repo.root), before);
});

test('doctor after setup is ok for every agent, exit 0, no findings', async (t) => {
  const world = await makeWorld(t);
  await runAgents(world, ['setup']);
  const run = await runAgents(world, ['doctor']);
  assert.equal(run.exitCode, 0);
  assert.deepEqual([run.packet.status, run.packet.findings, run.packet.next_commands], ['ok', [], []]);
  assert.deepEqual([...new Set(Object.values(states(run.packet)))], ['current']);
  assert.deepEqual(run.packet.data.agents.map(({ id, state }) => [id, state]), ALL_AGENTS.map((id) => [id, 'ok']));
});

test('doctor detects a missing file, an outdated block and entry, and hand-modified blocks and entries', async (t) => {
  const world = await makeWorld(t);
  await runAgents(world, ['setup', '--agent', 'claude', '--agent', 'codex']);
  await rm(join(world.repo.root, '.claude/skills/akrs-live-verify/SKILL.md'));
  await writeFile(join(world.repo.root, 'AGENTS.md'), (await read(world, 'AGENTS.md')).replace('Leaders start', 'Leaders STOP'));
  const mcp = JSON.parse(await read(world, '.mcp.json'));
  mcp.mcpServers.akrs.env = { MINE: '1' };
  await writeFile(join(world.repo.root, '.mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`);
  await writeTree(world.pkg.root, { 'docs/framework/skills/akrs-close-out.md': '---\nname: akrs-close-out\ndescription: A changed description.\n---\nbody\n' });

  const run = await runAgents(world, ['doctor', '--agent', 'claude', '--agent', 'codex']);
  assert.equal(run.packet.status, 'warning');
  assert.deepEqual(states(run.packet), {
    '.agents/skills/akrs-close-out/SKILL.md': 'outdated',
    '.agents/skills/akrs-live-verify/SKILL.md': 'current',
    '.claude/settings.local.json': 'current',
    '.claude/skills/akrs-close-out/SKILL.md': 'outdated',
    '.claude/skills/akrs-live-verify/SKILL.md': 'missing',
    '.codex/config.toml': 'current',
    '.mcp.json': 'hand_modified',
    'AGENTS.md': 'hand_modified',
    'CLAUDE.md': 'current',
  });
  const reasons = Object.fromEntries(run.packet.findings.map(({ detail }) => [detail.path, detail.reason]));
  assert.equal(reasons['AGENTS.md'], 'content_edited');
  assert.equal(reasons['.mcp.json'], 'hand_modified_entry');
  assert.equal(reasons['.claude/skills/akrs-close-out/SKILL.md'], 'outdated');
  assert.equal(reasons['.claude/skills/akrs-live-verify/SKILL.md'], 'missing');
  // the fix is suggested for what setup can repair; a hand-edited file is explained instead
  const byPath = Object.fromEntries(run.packet.findings.map((finding) => [finding.detail.path, finding]));
  assert.match(byPath['.claude/skills/akrs-close-out/SKILL.md'].detail.setup, /^akrs agents setup --agent claude --root /);
  assert.equal(Object.hasOwn(byPath['AGENTS.md'].detail, 'setup'), false);
  assert.match(byPath['AGENTS.md'].message, /edited by hand/);
  assert.match(byPath['AGENTS.md'].message, /remove the block/);
  assert.deepEqual(run.packet.next_commands.map(({ command }) => command), ['agents-setup']);
  assert.deepEqual(run.packet.next_commands[0].args.filter((value) => value === '--agent').length, 2);
});

test('doctor sees an outdated server path after the package moved', async (t) => {
  const world = await makeWorld(t);
  await runAgents(world, ['setup', '--agent', 'claude', '--agent', 'codex']);
  const moved = await makeWorld(t, { packageRoot: '/akrs-fixture/moved' });
  const run = await runAgents({ ...world, packageRoot: moved.packageRoot }, ['doctor', '--agent', 'claude', '--agent', 'codex'], { extraContext: { source_root: world.sourceRoot } });
  assert.deepEqual(
    Object.fromEntries(Object.entries(states(run.packet)).filter(([, state]) => state !== 'current')),
    { '.claude/settings.local.json': 'outdated', '.codex/config.toml': 'outdated', '.mcp.json': 'outdated' },
  );
});

test('doctor says explicitly which agents are CLI + skills only and which have no pre-write guard', async (t) => {
  const world = await makeWorld(t);
  await runAgents(world, ['setup']);
  const run = await runAgents(world, ['doctor']);
  const byId = Object.fromEntries(run.packet.data.agents.map((agent) => [agent.id, agent]));
  assert.equal(byId.pi.integration, 'cli_skills');
  assert.match(byId.pi.summary, /CLI \+ skills only/);
  assert.match(byId.pi.summary, /no MCP/);
  assert.deepEqual([byId.pi.surfaces.mcp.status, byId.pi.surfaces.hooks.status], ['not_configured', 'not_configured']);
  assert.match(byId.pi.surfaces.mcp.detail, /pi-mcp-adapter/);
  assert.match(byId.pi.surfaces.mcp.detail, /--pi-mcp/);

  assert.equal(byId.claude.integration, 'cli_skills_mcp_guard');
  assert.equal(byId.claude.surfaces.hooks.status, 'ok');
  assert.equal(byId.claude.surfaces.mcp.status, 'ok');
  for (const id of ['codex', 'gemini', 'opencode', 'kimi', 'qwen', 'freebuff']) {
    assert.equal(byId[id].integration, 'cli_skills_mcp', id);
    assert.equal(byId[id].surfaces.hooks.status, 'not_configured', id);
    assert.match(byId[id].summary, /no pre-write guard/, id);
    assert.match(byId[id].summary, /audit/, id);
  }
  assert.match(byId.gemini.surfaces.hooks.detail, /unverified/);
  assert.match(byId.cursor.surfaces.hooks.detail, /report/);
  assert.match(byId.cursor.surfaces.hooks.detail, /afterFileEdit/);
  assert.match(byId.qwen.surfaces.hooks.detail, /no hook/i);
  assert.match(byId.kimi.surfaces.hooks.detail, /user scope/);
  for (const agent of run.packet.data.agents) assert.deepEqual(Object.keys(agent.surfaces), ['instructions', 'skills', 'mcp', 'hooks']);
});

test('doctor with --pi-mcp expects .pi/mcp.json and reports it', async (t) => {
  const world = await makeWorld(t);
  await runAgents(world, ['setup', '--agent', 'pi']);
  const without = await runAgents(world, ['doctor', '--agent', 'pi']);
  assert.equal(without.packet.status, 'ok');
  const wanted = await runAgents(world, ['doctor', '--agent', 'pi', '--pi-mcp']);
  assert.equal(wanted.packet.status, 'warning');
  assert.deepEqual(wanted.packet.findings.map(({ detail }) => [detail.path, detail.reason]), [['.pi/mcp.json', 'missing']]);
  assert.match(wanted.packet.findings[0].detail.setup, /--agent pi --pi-mcp/);
  await runAgents(world, ['setup', '--agent', 'pi', '--pi-mcp']);
  const after = await runAgents(world, ['doctor', '--agent', 'pi', '--pi-mcp']);
  assert.equal(after.packet.status, 'ok');
  assert.equal(after.packet.data.agents[0].integration, 'cli_skills_mcp');
});

test('doctor warns that non-interactive Pi ignores untrusted project skills; other notes are listed, not findings', async (t) => {
  const world = await makeWorld(t);
  await runAgents(world, ['setup']);
  const run = await runAgents(world, ['doctor']);
  const notes = Object.fromEntries(run.packet.data.agents.map(({ id, notes: value }) => [id, value]));
  const pi = notes.pi.find(({ code }) => code === 'untrusted_project_skills');
  assert.equal(pi.level, 'warning');
  assert.match(pi.text, /non-interactive/);
  assert.match(pi.text, /untrusted/);
  assert.match(pi.text, /trust/);
  assert.ok(notes.claude.some(({ code, text }) => code === 'mcp_approval' && /approve/.test(text)));
  assert.ok(notes.codex.some(({ code, text }) => code === 'trusted_project' && /trusted/.test(text)));
  assert.equal(run.packet.findings.length, 0);
  assert.equal(run.packet.status, 'ok');
});

test('doctor reports a conflict (not hand_modified) for an unmanaged entry and an unparsable file', async (t) => {
  const world = await makeWorld(t, { repoFiles: { '.mcp.json': '{"mcpServers":{"akrs":{"command":"mine"}}}', '.cursor/mcp.json': '{' } });
  const run = await runAgents(world, ['doctor', '--agent', 'claude', '--agent', 'cursor']);
  const found = states(run.packet);
  assert.equal(found['.mcp.json'], 'conflict');
  assert.equal(found['.cursor/mcp.json'], 'conflict');
  const reasons = Object.fromEntries(run.packet.findings.filter(({ detail }) => detail.state === 'conflict').map(({ detail }) => [detail.path, detail.reason]));
  assert.deepEqual(reasons, { '.mcp.json': 'unmanaged_entry', '.cursor/mcp.json': 'unparsable_json' });
});

test('doctor renders in the prompt and JSON formats and is a pure query', async (t) => {
  const world = await makeWorld(t);
  const before = await byteTreeHash(world.repo.root);
  for (const format of ['--prompt', '--json']) {
    const run = await runAgents(world, ['doctor', '--agent', 'codex'], { format });
    assert.equal(run.exitCode, 1);
    assert.match(run.stdout + run.stderr, /AKRS-C021/);
  }
  assert.equal(await byteTreeHash(world.repo.root), before);
});

test('list: one record per agent from the registry, or only the selected ones; a query that writes nothing', async (t) => {
  const world = await makeWorld(t);
  const before = await byteTreeHash(world.repo.root);
  const all = await runAgents(world, ['list']);
  assert.equal(all.exitCode, 0);
  assert.deepEqual([all.packet.command, all.packet.status, all.packet.data.kind], ['agents-list', 'ok', 'agents_list']);
  assert.deepEqual(all.packet.data.agents.map(({ id }) => id), ALL_AGENTS);
  assert.deepEqual(all.packet.data.agents, JSON.parse(JSON.stringify(AGENT_REGISTRY)));
  const two = await runAgents(world, ['list', '--agent', 'pi', '--agent', 'cursor']);
  assert.deepEqual(two.packet.data.agents.map(({ id }) => id), ['pi', 'cursor']);
  assert.equal((await runAgents(world, ['list', '--agent', 'nobody'])).exitCode, 2);
  assert.equal(await byteTreeHash(world.repo.root), before);
});
