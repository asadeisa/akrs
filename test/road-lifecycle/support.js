// Shared helpers for the P2-W05 lifecycle tests: a repository with executors, a Plan, a DONE dependency and one Road in
// the wanted status, optionally committed to a real git repository, and in-process CLI runs of the lifecycle commands.
import { commandManifest } from '../../lib/commands/manifest.js';
import { readLog } from '../../lib/store/log/index.js';
import { commandSnapshot } from '../../lib/store/snapshots/index.js';
import { commitAll, git, put } from '../git-audit/support.js';
import { fakeProviders } from '../idempotency/support.js';
import { runCommand, treeDigest } from '../road/support.js';
import { packetWorld } from '../road-details/support.js';

export { commitAll, git, put, runCommand, treeDigest };
export const KNOWN_COMMANDS = commandManifest.commands.map(({ id }) => id);
// `node` through PATH, never an absolute path: the Road's content (and so its snapshot) must not depend on the machine.
export const nodeCheck = (name, script, args = [], timeout_ms = 30_000) => ({ name, argv: ['node', '-e', script, ...args], timeout_ms });
export const PASSING = nodeCheck('unit', 'process.stdout.write("ok")');
export const FAILING = nodeCheck('lint', 'process.stderr.write("bad"); process.exit(3)');

// status: the lifecycle status the Road is seeded in. git: commit the whole tree so the audit has a baseline.
export async function lifecycleWorld(t, { status = 'QUEUED', checks = [PASSING], overrides = {}, git: useGit = false } = {}) {
  const { repo, road } = await packetWorld(t, { checks, ...overrides }, { road: { status } });
  // The executors were recorded with their own provider pair; this one starts elsewhere so no request ID repeats.
  repo.providers = fakeProviders({ firstId: 7000 });
  if (useGit) {
    await put(repo, 'src/own.js', 'before\n');
    git(repo, 'init', '-q', '-b', 'main');
    commitAll(repo);
  }
  return { repo, road };
}

export const snapshotOf = async (repo, command, id = 'R-P6-1') => (await commandSnapshot(command, { ...repo.options, target: { road: id } })).snapshot;

export async function lifecycle(repo, verb, args = [], options = {}) {
  const result = await runCommand(repo, ['road', verb, ...(verb === 'check' && args[0] === undefined ? ['R-P6-1'] : []), ...args, '--json'], { providers: repo.providers, ...options });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, packet: result.stdout === '' ? null : JSON.parse(result.stdout) };
}

// `road <verb> R-P6-1 --if-snapshot <current>` with the snapshot read right now.
export async function transition(repo, verb, extra = [], { id = 'R-P6-1' } = {}) {
  const snapshot = await snapshotOf(repo, `road-${verb}`, id);
  return lifecycle(repo, verb, [id, '--if-snapshot', snapshot, ...extra]);
}

export const statusOf = async (repo, folder = 'roads/P6', id = 'R-P6-1') => JSON.parse(await repo.read(`akrs/${folder}/${id}.json`)).status;
export const closures = async (repo) => (await readLog(repo.options)).records.filter(({ kind }) => kind === 'road');
export const codesOf = (packet) => [...new Set(packet.findings.map(({ code }) => code))].sort();
export const reasonsOf = (packet, code = 'AKRS-R025') => packet.findings.filter((finding) => finding.code === code).map(({ detail }) => detail.reason).sort();
