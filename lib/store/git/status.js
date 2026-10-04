// git adapter core: locate the repository, read the porcelain status. Pure parsing is exported for the tests.
import { compareStrings } from '../../schemas/common.js';
import { runGit } from './runner.js';

// -> { git: true, prefix } | { git: false, reason: 'not_git' | 'git_unavailable' }
// `prefix` is the position of the CLI repository root below the git top level ('' or 'sub/dir/').
export async function locateGit({ repositoryRoot }) {
  const result = await runGit(repositoryRoot, ['rev-parse', '--show-toplevel', '--show-prefix']);
  if (result.unavailable) return { git: false, reason: 'git_unavailable' };
  if (!result.ok) return { git: false, reason: 'not_git' };
  const lines = result.stdout.toString('utf8').split('\n');
  return { git: true, prefix: lines[1] ?? '' };
}

const strip = (path, prefix) => (prefix === '' ? path : (path.startsWith(prefix) ? path.slice(prefix.length) : null));

// `git status --porcelain=v1 -z` bytes -> [{ path, staged, unstaged, untracked, renamed_from? }] sorted by path.
export function parseStatusZ(buffer, { prefix = '' } = {}) {
  const tokens = buffer.toString('utf8').split('\0');
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4) continue;
    const x = token[0];
    const y = token[1];
    const path = token.slice(3);
    let origin = null;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      origin = tokens[index + 1] ?? null;
      index += 1;
    }
    if (x === '!' && y === '!') continue;
    const relative = strip(path, prefix);
    if (relative === null) continue;
    const entry = {
      path: relative,
      staged: x !== ' ' && x !== '?' && x !== '!',
      unstaged: y !== ' ' && y !== '?' && y !== '!',
      untracked: x === '?' && y === '?',
    };
    if (origin !== null) entry.renamed_from = strip(origin, prefix) ?? origin;
    entries.push(entry);
  }
  return entries.sort((left, right) => compareStrings(left.path, right.path));
}

// -> { git: true, changes } | { git: false, reason } | { git: true, changes: null, reason: 'status_failed' }
export async function readChanges({ repositoryRoot }) {
  const located = await locateGit({ repositoryRoot });
  if (!located.git) return located;
  const result = await runGit(repositoryRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no']);
  if (!result.ok) return { git: true, changes: null, reason: 'status_failed' };
  return { git: true, prefix: located.prefix, changes: parseStatusZ(result.stdout, { prefix: located.prefix }) };
}
