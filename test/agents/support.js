// Shared helpers of the P2-W16 tests. Every test runs in temporary directories: a repository, a fake package root (the akrs bin paths the
// configs point at and the packaged skill templates) and a sentinel "home" that no code is given and that must stay empty.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCliAdapter } from '../../bin/cli-adapter.js';
import { commandHandlers, commandManifest, normalizeAbsolutePath } from '../../lib/core/index.js';
import { createTempRepository } from '../helpers/temp-repository.js';

export const PROVIDERS = { now: () => '2026-10-21T10:30:00.000Z', runId: () => '01ARZ3NDEKTSV4RRFFQ69G5FAV' };
export const GOLDEN_ROOT = fileURLToPath(new URL('./golden/', import.meta.url));
export const ALL_AGENTS = ['claude', 'codex', 'gemini', 'pi', 'opencode', 'kimi', 'qwen', 'cursor', 'freebuff'];
export const SKILL_NAMES = ['akrs-close-out', 'akrs-live-verify'];

export const SKILL_TEMPLATES = Object.freeze({
  'docs/framework/skills/README.md': '# Framework skills\n\nnot a skill\n',
  'docs/framework/skills/akrs-close-out.md': '---\nname: akrs-close-out\ndescription: Run the AKRS Road close-out when work lands: flip the status, append the ledger line.\n---\n\n# akrs-close-out\n\nSteps.\n',
  'docs/framework/skills/akrs-live-verify.md': '---\nname: akrs-live-verify\ndescription: "Verify a Plan against the running product, with a \\"raw\\" measurement."\n---\n\n# akrs-live-verify\n\nSteps.\n',
});

export async function writeTree(root, files) {
  for (const [path, data] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

export async function readTree(root) {
  const files = {};
  async function walk(directory, prefix) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : 1));
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), path);
      else files[path] = await readFile(join(directory, entry.name), 'utf8');
    }
  }
  await walk(root, '');
  return files;
}

// The package root the configs point at is a fixed fake path (the same on every operating system), so the bytes and the marker hashes of the
// golden trees are deterministic; the packaged skill templates live in a temporary `source` directory.
export const FIXTURE_PACKAGE_ROOT = '/akrs-fixture/pkg';

export async function makeWorld(t, { repoFiles = {}, skillFiles = SKILL_TEMPLATES, packageRoot = FIXTURE_PACKAGE_ROOT } = {}) {
  const repo = await createTempRepository(t, { prefix: 'akrs-agents-repo-' });
  const pkg = await createTempRepository(t, { prefix: 'akrs-agents-pkg-' });
  const home = await createTempRepository(t, { prefix: 'akrs-agents-home-' });
  await writeTree(repo.root, repoFiles);
  await writeTree(pkg.root, skillFiles);
  return { repo, pkg, home, packageRoot, sourceRoot: normalizeAbsolutePath(pkg.root) };
}

export async function runAgents(world, argv, { extraContext = {}, withRoot = true, format = '--json' } = {}) {
  const result = await runCliAdapter({
    argv: ['agents', ...argv, ...(withRoot ? ['--root', world.repo.root] : []), format],
    cwd: world.repo.root,
    manifest: commandManifest,
    handlers: commandHandlers,
    providers: PROVIDERS,
    resolveContext: async () => ({ package_root: world.packageRoot, source_root: world.sourceRoot, ...extraContext }),
  });
  let packet = null;
  if (format === '--json') packet = JSON.parse(result.stdout === '' ? result.stderr : result.stdout);
  return { ...result, packet };
}

// the files a packet lists, with their action
export const fileActions = (packet) => Object.fromEntries(packet.data.files.map(({ path, action }) => [path, action]));
export const filePaths = (packet) => packet.data.files.map(({ path }) => path);

export function skillFiles(dir) {
  return SKILL_NAMES.map((name) => `${dir}/${name}/SKILL.md`);
}

// The files each agent's setup manages in a repository that has the two fixture skills, in code point order.
export function expectedFiles(agent, { piMcp = false } = {}) {
  const common = ['AGENTS.md'];
  const byAgent = {
    claude: [...common, 'CLAUDE.md', ...skillFiles('.claude/skills'), '.claude/settings.local.json', '.mcp.json'],
    codex: [...common, ...skillFiles('.agents/skills'), '.codex/config.toml'],
    gemini: [...common, 'GEMINI.md', ...skillFiles('.agents/skills'), '.gemini/settings.json'],
    pi: [...common, ...skillFiles('.agents/skills'), ...(piMcp ? ['.pi/mcp.json'] : [])],
    opencode: [...common, ...skillFiles('.agents/skills'), 'opencode.json'],
    kimi: [...common, ...skillFiles('.agents/skills'), '.kimi-code/mcp.json'],
    qwen: [...common, ...skillFiles('.qwen/skills'), '.qwen/settings.json'],
    cursor: [...common, ...skillFiles('.agents/skills'), '.cursor/mcp.json'],
    freebuff: [...common, ...skillFiles('.agents/skills'), '.agents/mcp.json'],
  };
  return [...byAgent[agent]].sort();
}

// Like runAgents, but with the default context: the real package root and the packaged skills.
export async function runAgentsDefault(world, argv, { format = '--json' } = {}) {
  const result = await runCliAdapter({
    argv: ['agents', ...argv, '--root', world.repo.root, format],
    cwd: world.repo.root,
    manifest: commandManifest,
    handlers: commandHandlers,
    providers: PROVIDERS,
  });
  return { ...result, packet: format === '--json' ? JSON.parse(result.stdout === '' ? result.stderr : result.stdout) : null };
}
