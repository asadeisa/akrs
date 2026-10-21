// P2-W16 `agents setup`: dry run, the golden tree per agent, idempotency, user content, conflicts, and the per-writer rules.
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyManagedBlock, hashManagedContent } from '../../lib/core/index.js';
import { byteTreeHash } from '../helpers/byte-tree.js';
import {
  ALL_AGENTS, GOLDEN_ROOT, SKILL_NAMES, expectedFiles, fileActions, filePaths, makeWorld, readTree, runAgents, writeTree,
} from './support.js';

const parseJson = async (world, path) => JSON.parse(await readFile(join(world.repo.root, path), 'utf8'));
const read = (world, path) => readFile(join(world.repo.root, path), 'utf8');

for (const agent of ALL_AGENTS) {
  test(`${agent}: setup --dry-run lists the exact files and changes no byte`, async (t) => {
    const world = await makeWorld(t, { repoFiles: { 'README.md': 'user readme\n', 'src/app.js': 'export {};\n' } });
    const before = await byteTreeHash(world.repo.root);
    const run = await runAgents(world, ['setup', '--agent', agent, '--dry-run']);
    assert.equal(run.exitCode, 0);
    assert.deepEqual([run.packet.command, run.packet.status, run.packet.data.kind, run.packet.data.dry_run, run.packet.data.applied], ['agents-setup', 'ok', 'agents_setup', true, false]);
    assert.deepEqual(filePaths(run.packet), expectedFiles(agent));
    assert.deepEqual([...new Set(run.packet.data.files.map(({ action }) => action))], ['create']);
    assert.deepEqual(run.packet.changed, []);
    assert.equal(run.packet.snapshot.before, run.packet.snapshot.after);
    assert.equal(await byteTreeHash(world.repo.root), before);
    // the dry run proposes exactly what the real run then writes
    const real = await runAgents(world, ['setup', '--agent', agent]);
    assert.deepEqual(real.packet.changed, expectedFiles(agent));
    assert.deepEqual(real.packet.data.files.map(({ path, after_snapshot: after }) => [path, after]), run.packet.data.files.map(({ path, after_snapshot: after }) => [path, after]));
  });

  test(`${agent}: setup produces the golden tree and running it twice is a byte-identical noop`, async (t) => {
    const world = await makeWorld(t);
    const first = await runAgents(world, ['setup', '--agent', agent]);
    assert.equal(first.exitCode, 0);
    assert.equal(first.packet.status, 'ok');
    assert.deepEqual(first.packet.changed, expectedFiles(agent));
    const tree = await readTree(world.repo.root);
    assert.deepEqual(Object.keys(tree).sort(), expectedFiles(agent));

    const goldenDirectory = join(GOLDEN_ROOT, agent);
    if (process.env.AKRS_REGENERATE_AGENTS_GOLDEN === '1') {
      await rm(goldenDirectory, { recursive: true, force: true });
      await writeTree(goldenDirectory, tree);
    }
    assert.deepEqual(tree, await readTree(goldenDirectory), 'golden tree');

    const settled = await byteTreeHash(world.repo.root);
    const second = await runAgents(world, ['setup', '--agent', agent]);
    assert.equal(second.exitCode, 0);
    assert.deepEqual([second.packet.status, second.packet.changed], ['noop', []]);
    assert.deepEqual([...new Set(second.packet.data.files.map(({ action }) => action))], ['unchanged']);
    assert.equal(await byteTreeHash(world.repo.root), settled);
    assert.equal(second.packet.snapshot.before, second.packet.snapshot.after);
  });
}

test('no --agent means all nine agents; the shared files are listed once with every agent that needs them', async (t) => {
  const world = await makeWorld(t);
  const run = await runAgents(world, ['setup']);
  assert.deepEqual(run.packet.data.agents, ALL_AGENTS);
  const paths = filePaths(run.packet);
  assert.equal(new Set(paths).size, paths.length);
  assert.deepEqual(paths, [...new Set(ALL_AGENTS.flatMap((agent) => expectedFiles(agent)))].sort());
  const agentsMd = run.packet.data.files.find(({ path }) => path === 'AGENTS.md');
  assert.deepEqual(agentsMd.agents, ALL_AGENTS);
  const shared = run.packet.data.files.find(({ path }) => path === '.agents/skills/akrs-close-out/SKILL.md');
  assert.deepEqual(shared.agents, ['codex', 'gemini', 'pi', 'opencode', 'kimi', 'cursor', 'freebuff']);
  assert.equal((await runAgents(world, ['setup'])).packet.status, 'noop');
});

test('user content outside the managed blocks survives byte for byte (Markdown and TOML), with CRLF and BOM kept', async (t) => {
  const agentsMd = '# My project\r\n\r\nRules of the house.\r\n';
  const claudeMd = '﻿# Claude notes\n\nkeep this exactly   \n';
  const config = '# my codex settings\nmodel = "gpt-x"   # inline comment\n\n[projects."/work/app"]\ntrust_level = "trusted"\n\n[mcp_servers.other]\ncommand = "other"\nargs = [ "a",\n  "b" ]\n';
  const world = await makeWorld(t, { repoFiles: { 'AGENTS.md': agentsMd, 'CLAUDE.md': claudeMd, '.codex/config.toml': config } });
  const run = await runAgents(world, ['setup', '--agent', 'claude', '--agent', 'codex']);
  assert.equal(run.packet.status, 'ok');
  const a = await read(world, 'AGENTS.md');
  assert.equal(a.startsWith(agentsMd), true);
  assert.equal(/(^|[^\r])\n/.test(a), false, 'CRLF is kept');
  assert.match(a, /<!-- akrs:begin agent-pointer sha256=[0-9a-f]{64} -->\r\n/);
  const c = await read(world, 'CLAUDE.md');
  assert.equal(c.startsWith(claudeMd), true);
  assert.equal(c.indexOf('﻿', 1), -1);
  assert.match(c, /<!-- akrs:begin claude-import sha256=[0-9a-f]{64} -->\n@AGENTS\.md\n<!-- akrs:end claude-import -->\n$/);
  const toml = await read(world, '.codex/config.toml');
  assert.equal(toml.startsWith(config), true);
  assert.match(toml.slice(config.length), /^# akrs:begin mcp-akrs sha256=[0-9a-f]{64}\n\[mcp_servers\.akrs\]\ncommand = "node"\nargs = \["[^"]+\/bin\/akrs\.js", "mcp"\]\n# akrs:end mcp-akrs\n$/);
});

test('JSON configs keep every other key and its order; a changed file keeps its indentation', async (t) => {
  const mcp = '{\n    "$schema": "x",\n    "mcpServers": {\n        "other": { "command": "x", "args": ["1"] }\n    },\n    "extra": [1, 2, 3]\n}\n';
  const settings = '{\n\t"permissions": { "allow": ["Bash(ls)"] },\n\t"hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "lint" } ] } ], "Stop": [] }\n}\n';
  const world = await makeWorld(t, { repoFiles: { '.mcp.json': mcp, '.claude/settings.local.json': settings } });
  const run = await runAgents(world, ['setup', '--agent', 'claude']);
  assert.equal(run.packet.status, 'ok');
  const mcpAfter = await read(world, '.mcp.json');
  assert.match(mcpAfter, /^\{\n    "\$schema": "x",\n    "mcpServers": \{\n        "other"/);
  const parsed = JSON.parse(mcpAfter);
  assert.deepEqual(Object.keys(parsed), ['$schema', 'mcpServers', 'extra']);
  assert.deepEqual(Object.keys(parsed.mcpServers), ['other', 'akrs']);
  assert.deepEqual(parsed.mcpServers.other, { command: 'x', args: ['1'] });
  assert.deepEqual(parsed.extra, [1, 2, 3]);
  assert.equal(parsed.mcpServers.akrs.command, 'node');
  assert.equal(parsed.mcpServers.akrs.args[1], 'mcp');
  assert.equal(parsed.mcpServers.akrs.args[0].endsWith('/bin/akrs.js'), true);

  const hooks = await parseJson(world, '.claude/settings.local.json');
  assert.deepEqual(Object.keys(hooks), ['permissions', 'hooks']);
  assert.deepEqual(hooks.permissions, { allow: ['Bash(ls)'] });
  assert.deepEqual(hooks.hooks.Stop, []);
  assert.equal(hooks.hooks.PreToolUse.length, 2);
  assert.equal(hooks.hooks.PreToolUse[0].matcher, 'Bash');
  assert.equal((await read(world, '.claude/settings.local.json')).startsWith('{\n\t"permissions"'), true);
});

test('a conflicting unmanaged entry is reported and never overwritten; every other file is still written', async (t) => {
  const mcp = '{"mcpServers":{"akrs":{"command":"my-own-server"}}}';
  const toml = '[mcp_servers.akrs]\ncommand = "mine"\n';
  const world = await makeWorld(t, { repoFiles: { '.mcp.json': mcp, '.codex/config.toml': toml } });
  const run = await runAgents(world, ['setup', '--agent', 'claude', '--agent', 'codex']);
  assert.equal(run.exitCode, 1);
  assert.equal(run.packet.status, 'warning');
  assert.equal(await read(world, '.mcp.json'), mcp);
  assert.equal(await read(world, '.codex/config.toml'), toml);
  const actions = fileActions(run.packet);
  assert.equal(actions['.mcp.json'], 'conflict');
  assert.equal(actions['.codex/config.toml'], 'conflict');
  assert.equal(actions['AGENTS.md'], 'create');
  assert.equal(actions['CLAUDE.md'], 'create');
  assert.deepEqual(run.packet.findings.map(({ code, detail }) => [code, detail.agent, detail.path, detail.reason]), [
    ['AKRS-C021', 'codex', '.codex/config.toml', 'unmanaged_entry'],
    ['AKRS-C021', 'claude', '.mcp.json', 'unmanaged_entry'],
  ]);
  assert.equal(run.packet.changed.includes('.mcp.json'), false);
  assert.equal(run.packet.data.conflicts, 2);
  // a second run reports the same conflicts and changes nothing
  const again = await runAgents(world, ['setup', '--agent', 'claude', '--agent', 'codex']);
  assert.deepEqual([again.packet.status, again.packet.changed], ['warning', []]);
});

test('a hand-edited managed block, broken markers, an unparsable file and a foreign skill file are conflicts and stay byte for byte', async (t) => {
  const world = await makeWorld(t);
  assert.equal((await runAgents(world, ['setup', '--agent', 'claude'])).packet.status, 'ok');
  const edited = (await read(world, 'AGENTS.md')).replace('Leaders start', 'Leaders STOP');
  await writeFile(join(world.repo.root, 'AGENTS.md'), edited);
  await writeFile(join(world.repo.root, 'CLAUDE.md'), '<!-- akrs:begin claude-import sha256=zz -->\n@AGENTS.md\n');
  await writeFile(join(world.repo.root, '.mcp.json'), '{ "mcpServers": ');
  await writeFile(join(world.repo.root, '.claude/skills/akrs-close-out/SKILL.md'), '---\nname: akrs-close-out\ndescription: mine\n---\nmy own text\n');
  const before = await readTree(world.repo.root);
  const run = await runAgents(world, ['setup', '--agent', 'claude']);
  assert.equal(run.packet.status, 'warning');
  assert.deepEqual(
    Object.fromEntries(run.packet.findings.map(({ detail }) => [detail.path, detail.reason])),
    {
      'AGENTS.md': 'content_edited',
      'CLAUDE.md': 'invalid_marker',
      '.mcp.json': 'unparsable_json',
      '.claude/skills/akrs-close-out/SKILL.md': 'unmanaged_file',
    },
  );
  assert.deepEqual(await readTree(world.repo.root), before);
  assert.deepEqual(run.packet.changed, []);
});

test('agents without MCP or hooks get CLI + skills only: Pi writes no MCP file and no hook; --pi-mcp adds .pi/mcp.json with directTools', async (t) => {
  const world = await makeWorld(t);
  const plain = await runAgents(world, ['setup', '--agent', 'pi']);
  assert.deepEqual(plain.packet.changed, expectedFiles('pi'));
  assert.equal(plain.packet.data.integration.pi, 'cli_skills');
  assert.equal(Object.hasOwn(await readTree(world.repo.root), '.pi/mcp.json'), false);
  assert.ok(plain.packet.data.manual_steps.some(({ agent, text }) => agent === 'pi' && /pi-mcp-adapter/.test(text) && /--pi-mcp/.test(text)));

  const opted = await runAgents(world, ['setup', '--agent', 'pi', '--pi-mcp']);
  assert.deepEqual(opted.packet.changed, ['.pi/mcp.json']);
  assert.equal(opted.packet.data.integration.pi, 'cli_skills_mcp');
  const config = await parseJson(world, '.pi/mcp.json');
  assert.deepEqual(Object.keys(config.mcpServers.akrs), ['command', 'args', 'directTools']);
  assert.equal(config.mcpServers.akrs.directTools, true);
  assert.equal((await runAgents(world, ['setup', '--agent', 'pi', '--pi-mcp'])).packet.status, 'noop');
});

test('integration levels: Claude Code has MCP and the guard hook, the others only MCP or nothing', async (t) => {
  const world = await makeWorld(t);
  const run = await runAgents(world, ['setup', '--dry-run']);
  assert.deepEqual(run.packet.data.integration, {
    claude: 'cli_skills_mcp_guard', codex: 'cli_skills_mcp', gemini: 'cli_skills_mcp', pi: 'cli_skills', opencode: 'cli_skills_mcp', kimi: 'cli_skills_mcp',
    qwen: 'cli_skills_mcp', cursor: 'cli_skills_mcp', freebuff: 'cli_skills_mcp',
  });
});

test('the Codex TOML block is the only change: a second table after user tables, hash markers, valid shape', async (t) => {
  const world = await makeWorld(t);
  await runAgents(world, ['setup', '--agent', 'codex']);
  const toml = await read(world, '.codex/config.toml');
  const lines = toml.split('\n');
  assert.match(lines[0], /^# akrs:begin mcp-akrs sha256=[0-9a-f]{64}$/);
  assert.equal(lines[1], '[mcp_servers.akrs]');
  assert.equal(lines.at(-2), '# akrs:end mcp-akrs');
  const body = `${lines.slice(1, -2).join('\n')}\n`;
  assert.match(lines[0], new RegExp(hashManagedContent(body)));
});

test('the Freebuff .agents/mcp.json entry holds only command and args (its strict parser rejects any other key); user entries are kept', async (t) => {
  const world = await makeWorld(t, { repoFiles: { '.agents/mcp.json': '{\n  "mcpServers": {\n    "mine": { "command": "x", "args": [], "env": { "A": "1" } }\n  }\n}\n' } });
  const run = await runAgents(world, ['setup', '--agent', 'freebuff']);
  assert.equal(run.packet.status, 'ok');
  const config = await parseJson(world, '.agents/mcp.json');
  assert.deepEqual(Object.keys(config), ['mcpServers']);
  assert.deepEqual(Object.keys(config.mcpServers), ['mine', 'akrs']);
  assert.deepEqual(config.mcpServers.mine, { command: 'x', args: [], env: { A: '1' } });
  const allowed = new Set(['type', 'command', 'args', 'env']);
  for (const [name, entry] of Object.entries(config.mcpServers)) {
    assert.deepEqual(Object.keys(entry).filter((key) => !allowed.has(key)), [], name);
  }
  assert.deepEqual(Object.keys(config.mcpServers.akrs), ['command', 'args']);
});

test('opencode gets mcp.akrs = {type: local, command: [...], enabled: true}', async (t) => {
  const world = await makeWorld(t, { repoFiles: { 'opencode.json': '{\n  "theme": "x",\n  "mcp": { "keep": { "type": "remote", "url": "https://x" } }\n}\n' } });
  await runAgents(world, ['setup', '--agent', 'opencode']);
  const config = await parseJson(world, 'opencode.json');
  assert.deepEqual(Object.keys(config), ['theme', 'mcp']);
  assert.deepEqual(Object.keys(config.mcp), ['keep', 'akrs']);
  assert.deepEqual(config.mcp.akrs, { type: 'local', command: ['node', `${world.packageRoot}/bin/akrs.js`, 'mcp'], enabled: true });
});

test('MCP entries launch node with the absolute akrs.js path, never a .cmd or .ps1 shim', async (t) => {
  const world = await makeWorld(t);
  await runAgents(world, ['setup']);
  const tree = await readTree(world.repo.root);
  const launchers = [];
  for (const path of ['.mcp.json', '.cursor/mcp.json', '.gemini/settings.json', '.qwen/settings.json', '.kimi-code/mcp.json', '.agents/mcp.json']) {
    launchers.push(JSON.parse(tree[path]).mcpServers.akrs);
  }
  for (const entry of launchers) assert.deepEqual(entry, { command: 'node', args: [`${world.packageRoot}/bin/akrs.js`, 'mcp'] });
  for (const text of Object.values(tree)) assert.doesNotMatch(text, /\.cmd|\.ps1/);
});

test('skill pointers are copied, never symlinked; the directory name equals the frontmatter name; .claude and .qwen copies equal the .agents pointer', async (t) => {
  const world = await makeWorld(t);
  await runAgents(world, ['setup', '--agent', 'claude', '--agent', 'qwen', '--agent', 'codex']);
  for (const dir of ['.agents/skills', '.claude/skills', '.qwen/skills']) {
    assert.deepEqual((await readdir(join(world.repo.root, dir))).sort(), SKILL_NAMES);
    for (const name of SKILL_NAMES) {
      const file = join(world.repo.root, dir, name, 'SKILL.md');
      assert.equal((await lstat(file)).isSymbolicLink(), false);
      assert.equal((await lstat(file)).isFile(), true);
      assert.equal((await lstat(join(world.repo.root, dir, name))).isSymbolicLink(), false);
      const text = await readFile(file, 'utf8');
      assert.match(text, new RegExp(`^---\\nname: ${name}\\ndescription: "`));
      const keys = text.split('\n---\n')[0].split('\n').slice(1).map((line) => line.split(':')[0]);
      assert.deepEqual(keys, ['name', 'description']);
    }
  }
  for (const name of SKILL_NAMES) {
    const reference = await read(world, `.agents/skills/${name}/SKILL.md`);
    assert.equal(await read(world, `.claude/skills/${name}/SKILL.md`), reference);
    assert.equal(await read(world, `.qwen/skills/${name}/SKILL.md`), reference);
    assert.match(reference, new RegExp(`docs/akrs/framework/skills/${name}\\.md`));
  }
});

test('the skill pointer points at the project body when <workflow>/skills exists, and a skill description with quotes stays a valid frontmatter', async (t) => {
  const world = await makeWorld(t, { repoFiles: { 'akrs/skills/akrs-close-out.md': '---\nname: akrs-close-out\ndescription: Say "hello": now\n---\nbody\n' } });
  await runAgents(world, ['setup', '--agent', 'codex']);
  const text = await read(world, '.agents/skills/akrs-close-out/SKILL.md');
  assert.match(text, /Read and execute `akrs\/skills\/akrs-close-out\.md`/);
  assert.match(text, /description: "Say \\"hello\\": now"/);
  assert.equal(Object.hasOwn(await readTree(world.repo.root), '.agents/skills/akrs-live-verify/SKILL.md'), false, 'the project folder replaces the templates');
});

test('Claude CLAUDE.md gains @AGENTS.md only inside its managed block; Gemini gets the GEMINI.md import and no settings.json instruction key', async (t) => {
  const world = await makeWorld(t);
  await runAgents(world, ['setup', '--agent', 'claude', '--agent', 'gemini']);
  const claude = await read(world, 'CLAUDE.md');
  const applied = applyManagedBlock('', { id: 'claude-import', style: 'html', content: '@AGENTS.md\n' }).text;
  assert.equal(claude, applied);
  const gemini = await read(world, 'GEMINI.md');
  assert.equal(gemini, applyManagedBlock('', { id: 'gemini-import', style: 'html', content: '@./AGENTS.md\n' }).text);
  const settings = await parseJson(world, '.gemini/settings.json');
  assert.deepEqual(Object.keys(settings), ['mcpServers']);
  assert.equal(Object.hasOwn(settings, 'context'), false);
});

test('Claude gets the PreToolUse guard hook: node <abs>/bin/akrs-guard.js, registry fields, no shim', async (t) => {
  const world = await makeWorld(t);
  await runAgents(world, ['setup', '--agent', 'claude']);
  const settings = await parseJson(world, '.claude/settings.local.json');
  assert.deepEqual(settings, {
    hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: `node "${world.packageRoot}/bin/akrs-guard.js"` }] }] },
  });
  const listed = await runAgents(world, ['list', '--agent', 'claude']);
  const { hooks } = listed.packet.data.agents[0];
  assert.deepEqual([hooks.hook_mode, hooks.payload_format, hooks.deny_protocol, hooks.status], ['pre', 'tool_input_json', 'exit_code_2', 'verified']);
});

test('agents with only unverified or post-edit hooks get no hook file', async (t) => {
  const world = await makeWorld(t);
  await runAgents(world, ['setup']);
  const tree = await readTree(world.repo.root);
  for (const path of ['.cursor/hooks.json', '.gemini/hooks.json', '.codex/hooks.json']) assert.equal(Object.hasOwn(tree, path), false, path);
  assert.deepEqual(Object.keys(JSON.parse(tree['.gemini/settings.json'])), ['mcpServers']);
});

test('project scope only: nothing is written outside the repository and user-scope configs are printed as instructions', async (t) => {
  const world = await makeWorld(t);
  const homeBefore = await byteTreeHash(world.home.root);
  const run = await runAgents(world, ['setup'], { extraContext: { env: { HOME: world.home.root, USERPROFILE: world.home.root, APPDATA: world.home.root } } });
  assert.equal(run.packet.status, 'ok');
  assert.equal(await byteTreeHash(world.home.root), homeBefore);
  assert.deepEqual(await readdir(world.home.root), []);
  for (const path of run.packet.changed) assert.doesNotMatch(path, /^(~|\/|[A-Za-z]:|\.\.)/);
  const codex = run.packet.data.user_scope.find(({ agent, purpose }) => agent === 'codex' && purpose === 'mcp');
  assert.equal(codex.path, '~/.codex/config.toml');
  assert.match(codex.snippet, /^\[mcp_servers\.akrs\]\ncommand = "node"\nargs = \["[^"]+\/bin\/akrs\.js", "mcp"\]\n$/);
  const claude = run.packet.data.user_scope.find(({ agent, purpose }) => agent === 'claude' && purpose === 'mcp');
  assert.equal(claude.path, '~/.claude.json');
  assert.deepEqual(JSON.parse(claude.snippet).mcpServers.akrs.command, 'node');
  assert.ok(run.packet.data.manual_steps.some(({ agent, text }) => agent === 'claude' && /approve/i.test(text)));
  assert.ok(run.packet.data.manual_steps.some(({ agent, text }) => agent === 'codex' && /trusted/i.test(text)));
});

test('a symlinked directory that escapes the repository is refused and nothing is written through it', async (t) => {
  const world = await makeWorld(t);
  const outside = join(world.home.root, 'outside');
  await mkdir(outside, { recursive: true });
  let linked = true;
  try {
    const { symlink } = await import('node:fs/promises');
    await symlink(outside, join(world.repo.root, '.codex'), 'junction');
  } catch {
    linked = false;
  }
  if (!linked) {
    t.skip('symlinks are not available');
    return;
  }
  const run = await runAgents(world, ['setup', '--agent', 'codex']);
  assert.notEqual(run.exitCode, 0);
  assert.deepEqual(await readdir(outside), []);
});

test('usage errors: an unknown agent is refused; a repeated agent is listed once', async (t) => {
  const world = await makeWorld(t);
  const unknown = await runAgents(world, ['setup', '--agent', 'nobody']);
  assert.equal(unknown.exitCode, 2);
  assert.match(unknown.packet.findings[0].message, /nobody/);
  const twice = await runAgents(world, ['setup', '--agent', 'pi', '--agent', 'pi', '--dry-run']);
  assert.deepEqual(twice.packet.data.agents, ['pi']);
});

test('no packaged skills and no project skills: instructions and MCP are still set up and the packet says no skills were found', async (t) => {
  const world = await makeWorld(t, { skillFiles: {} });
  const run = await runAgents(world, ['setup', '--agent', 'codex']);
  assert.equal(run.packet.status, 'ok');
  assert.deepEqual(run.packet.changed, ['.codex/config.toml', 'AGENTS.md']);
  assert.equal(run.packet.data.skills.count, 0);
  assert.match(await read(world, 'AGENTS.md'), /akrs:begin agent-pointer/);
  assert.equal(Object.keys(await readTree(world.repo.root)).some((path) => path.includes('skills')), false);
});

test('an outdated managed block or entry is updated by setup (a new package path, a changed skill description)', async (t) => {
  const world = await makeWorld(t);
  await runAgents(world, ['setup', '--agent', 'claude', '--agent', 'codex']);
  const moved = await makeWorld(t, { packageRoot: '/akrs-fixture/moved' });
  await writeTree(world.pkg.root, { 'docs/framework/skills/akrs-close-out.md': '---\nname: akrs-close-out\ndescription: A changed description.\n---\nbody\n' });
  const second = await runAgents({ ...world, packageRoot: moved.packageRoot }, ['setup', '--agent', 'claude', '--agent', 'codex'], { extraContext: { source_root: world.sourceRoot } });
  assert.equal(second.packet.status, 'ok');
  assert.deepEqual(fileActions(second.packet), {
    '.agents/skills/akrs-close-out/SKILL.md': 'update',
    '.agents/skills/akrs-live-verify/SKILL.md': 'unchanged',
    '.claude/settings.local.json': 'update',
    '.claude/skills/akrs-close-out/SKILL.md': 'update',
    '.claude/skills/akrs-live-verify/SKILL.md': 'unchanged',
    '.codex/config.toml': 'update',
    '.mcp.json': 'update',
    'AGENTS.md': 'unchanged',
    'CLAUDE.md': 'unchanged',
  });
  const toml = await read(world, '.codex/config.toml');
  assert.equal(toml.includes(moved.packageRoot), true);
  assert.equal(toml.includes(world.packageRoot), false);
  assert.equal((toml.match(/akrs:begin/g) ?? []).length, 1);
  assert.equal((await parseJson(world, '.mcp.json')).mcpServers.akrs.args[0], `${moved.packageRoot}/bin/akrs.js`);
});

test('a file that changes between the plan and the write stops the run: nothing is replaced after the change', async (t) => {
  const world = await makeWorld(t);
  const { setupAgents } = await import('../../lib/agents/setup.js');
  let triggered = false;
  await assert.rejects(
    setupAgents({
      repositoryRoot: world.repo.root,
      workflowRoot: join(world.repo.root, 'akrs'),
      packageRoot: world.packageRoot,
      sourceRoot: world.sourceRoot,
      agents: ['codex'],
      dryRun: false,
      testHooks: {
        beforeWrite: async (path) => {
          if (path === 'AGENTS.md' && !triggered) {
            triggered = true;
            await writeFile(join(world.repo.root, 'AGENTS.md'), 'someone else was here\n');
          }
        },
      },
    }),
    /changed before write|created concurrently/,
  );
  assert.equal(await read(world, 'AGENTS.md'), 'someone else was here\n');
});
