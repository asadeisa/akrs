// Shared helpers of the P2-W17 tests. Every test works in temporary directories: project repositories, a temporary user-config root
// (AKRS_CONFIG_HOME) and a sentinel "home" that no code is given. The module also points the whole test process at a throwaway
// config root, so a code path that forgot to inject one still cannot reach the real user profile.
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliAdapter } from '../../bin/cli-adapter.js';
import { commandHandlers, commandManifest, normalizeAbsolutePath } from '../../lib/core/index.js';
import { fakeProviders } from '../idempotency/support.js';
import { createTempRepository } from '../helpers/temp-repository.js';
import { navWorld } from '../navigation/support.js';
import { treeDigest } from '../road/support.js';
import { resolveConfigRoot } from '../../lib/userconfig/root.js';

export { fakeProviders, navWorld, treeDigest };

// the safety net: anything that reads the default config root reads this throwaway one
const SAFETY_ROOT = mkdtempSync(join(tmpdir(), 'akrs-desktop-safety-'));
if (process.env.AKRS_CONFIG_HOME === undefined || process.env.AKRS_CONFIG_HOME === '') process.env.AKRS_CONFIG_HOME = SAFETY_ROOT;
export const PROCESS_CONFIG_HOME = process.env.AKRS_CONFIG_HOME;

export async function configHome(t) {
  const home = await createTempRepository(t, { prefix: 'akrs-config-home-' });
  return { root: join(home.root, 'akrs-config'), home };
}

// A registered-project world: a config root plus helpers that run commands with it injected (never the process environment).
export async function desktopWorld(t) {
  const config = await configHome(t);
  const world = { config: config.root, projects: [] };
  world.env = { AKRS_CONFIG_HOME: world.config };
  world.run = (argv, { cwd, providers = fakeProviders({ firstId: 9000 }), env = world.env, extraContext = {}, stdin } = {}) => runCliAdapter({
    argv,
    cwd: cwd ?? world.cwd ?? process.cwd(),
    manifest: commandManifest,
    handlers: commandHandlers,
    providers,
    resolveContext: async ({ cwd: at }) => ({ repository_root: normalizeAbsolutePath(at), env, platform: process.platform, ...extraContext }),
    readStdin: async () => (stdin === undefined ? Buffer.alloc(0) : Buffer.from(stdin)),
  });
  world.json = async (argv, options = {}) => {
    const out = await world.run([...argv, '--json'], options);
    const text = out.stdout === '' ? out.stderr : out.stdout;
    let packet = null;
    try {
      packet = JSON.parse(text);
    } catch {
      packet = null;
    }
    return { ...out, packet, text };
  };
  // a workflow repository (the navigation world: Plan P6, DONE / ACTIVE / ready / blocked Roads)
  world.project = async () => {
    const repo = await navWorld(t);
    world.projects.push(repo);
    return repo;
  };
  return world;
}

export async function plainDirectory(t, prefix = 'akrs-plain-') {
  return createTempRepository(t, { prefix });
}

export function mkdirp(path) {
  mkdirSync(path, { recursive: true });
}

export const codesOf = (packet) => [...new Set(packet.findings.map(({ code }) => code))].sort();

// The real user profile: where AKRS would put the registry if nothing were injected. Tests never touch it; this probe lets a test prove it.
const realRegistry = (() => {
  try {
    return join(resolveConfigRoot({ env: { ...process.env, AKRS_CONFIG_HOME: '' } }).root, 'projects.json');
  } catch {
    return null;
  }
})();
export function realProfileProbe() {
  if (realRegistry === null || !existsSync(realRegistry)) return { exists: false };
  const { size, mtimeMs } = statSync(realRegistry);
  return { exists: true, size, mtimeMs };
}
export const REAL_PROFILE_AT_START = realProfileProbe();
