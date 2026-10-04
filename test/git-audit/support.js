// Shared helpers for the P1-W12 git posture and audit tests. Real git (argv arrays, no shell) builds the fixtures; the
// code under test only ever reads.
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createRepo, runCommand, seedPlan, seedRoad, treeDigest } from '../road/support.js';

export { createRepo, runCommand, seedPlan, seedRoad, treeDigest };

export const git = (repo, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', ...args], {
  cwd: repo.root, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
});
export const commitAll = (repo, message = 'baseline') => {
  git(repo, 'add', '-A', '-f', '.');
  git(repo, 'commit', '-q', '-m', message);
};
export const put = async (repo, path, content = 'x\n') => {
  await mkdir(dirname(repo.path(path)), { recursive: true });
  await writeFile(repo.path(path), content);
};

// A committed repository: product files, a Plan and two Roads (R-A ACTIVE declaring src/own.js and src/new.js).
export async function auditWorld(t) {
  const repo = await createRepo(t);
  await seedPlan(repo, 'P6');
  await seedRoad(repo, {
    id: 'R-A', plan: 'P6', writes: [{ path: 'src/own.js', class: 'file', action: 'modify' }, { path: 'src/new.js', class: 'file', action: 'create' }, { path: 'src/gen/**', class: 'glob', action: 'modify' }],
    forbidden: ['src/secret.js'],
  }, { folder: 'roads/P6', status: 'ACTIVE' });
  await put(repo, 'src/other.js', 'other\n');
  await put(repo, 'src/secret.js', 'secret\n');
  await put(repo, 'README.md', 'readme\n');
  await put(repo, 'test/foo.test.js', 'test\n');
  git(repo, 'init', '-q', '-b', 'main');
  commitAll(repo);
  return repo;
}
export const dropGit = (repo) => rm(repo.path('.git'), { recursive: true, force: true });
export const auditPacket = async (repo, extra = []) => JSON.parse((await runCommand(repo, ['audit', '--git', '--road', 'R-A', '--json', ...extra])).stdout);
export const doctorPacket = async (repo) => JSON.parse((await runCommand(repo, ['doctor', '--json'])).stdout);
