// Shared helpers for the P2-W03 tests: a repository with an ACTIVE Road whose declared checks are tiny node programs,
// and in-process CLI runs of `verify --road`.
import { dirname, join } from 'node:path';
import { runCommand } from '../road/support.js';
import { packetWorld } from '../road-details/support.js';

export { packetWorld };
export const nodeCheck = (name, script, args = [], timeout_ms = 10_000) => ({ name, argv: [process.execPath, '-e', script, ...args], timeout_ms });

export async function verifyWorld(t, checks, overrides = {}) {
  const { repo, road } = await packetWorld(t, { checks, ...overrides });
  repo.markerDir = join(dirname(repo.root), `${repo.root.split(/[\\/]/).at(-1)}-markers`);
  return { repo, road };
}

export async function verify(repo, args = [], options = {}) {
  const result = await runCommand(repo, ['verify', '--road', 'R-P6-1', '--json', ...args], { providers: repo.providers, ...options });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, packet: result.stdout === '' ? null : JSON.parse(result.stdout) };
}
