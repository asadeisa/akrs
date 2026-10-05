// The write guard decision (A1 5.4, P2-W12). Pure and tiny on purpose: it imports node built-ins only, so `bin/akrs-guard.js` never loads the
// manifest, the schemas or the snapshot engine. It reads the allowlist `work` compiled to <workflow>/.ops/leases/<road>.guard.json and decides
// ONE path. Nothing is written. Any failure answers allow (fail-open): `audit` is the backstop.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export const GUARD_SCHEMA = 'akrs.guard/v1';
export const GUARD_FILE_SUFFIX = '.guard.json';
export const GUARD_DECISIONS = Object.freeze(['allow', 'deny']);
export const GUARD_DENY_REASONS = Object.freeze(['cli_owned', 'forbidden', 'outside_writes']);
export const GUARD_ALLOW_REASONS = Object.freeze(['drafts', 'guard_error', 'no_identity', 'no_lease', 'no_workflow', 'outside_repository', 'writes']);
export const GUARD_ENV_VARIABLE = 'AKRS_EXECUTOR';

const fold = (text) => text.normalize('NFC').toLowerCase();
const toPosix = (path) => path.split(sep).join('/');

const segmentPattern = (segment) => new RegExp(`^${[...segment].map((char) => {
  if (char === '*') return '[^/]*';
  if (char === '?') return '[^/]';
  return char.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
}).join('')}$`, 'u');

// `**` is a whole segment matching zero or more segments; `*` and `?` stay inside one segment.
export function globMatches(pattern, path) {
  const wanted = fold(pattern).split('/');
  const given = fold(path).split('/');
  const memo = new Map();
  const walk = (left, right) => {
    const key = `${left}:${right}`;
    if (memo.has(key)) return memo.get(key);
    let answer;
    if (left === wanted.length) answer = right === given.length;
    else if (wanted[left] === '**') answer = walk(left + 1, right) || (right < given.length && walk(left, right + 1));
    else answer = right < given.length && segmentPattern(wanted[left]).test(given[right]) && walk(left + 1, right + 1);
    memo.set(key, answer);
    return answer;
  };
  return walk(0, 0);
}

// One declared write { path, class } covers a concrete repository path.
export function writeCovers(entry, path) {
  const target = fold(path);
  const declared = fold(entry.path).replace(/\/+$/, '');
  if (entry.class === 'dir') return target === declared || target.startsWith(`${declared}/`);
  if (entry.class === 'glob') return globMatches(entry.path, path);
  return target === declared || globMatches(entry.path, path);
}

// The allowlist `work` writes: what the Road declares, nothing derived. -> the object the file holds.
export function compileGuard({ road, holder, workflow, writes, forbidden }) {
  return {
    schema: GUARD_SCHEMA,
    road,
    holder,
    workflow,
    writes: writes.map(({ path, class: pathClass }) => ({ path, class: pathClass })),
    forbidden: [...forbidden],
  };
}

export const GUARD_FILE_SPEC = Object.freeze({
  keys: ['schema', 'road', 'holder', 'workflow', 'writes', 'forbidden'],
  arrays: { writes: { kind: 'ordered', item: { keys: ['path', 'class'], arrays: {}, objects: {} } }, forbidden: { kind: 'ordered' } },
  objects: {},
});

function readGuards(workflowRoot) {
  const directory = join(workflowRoot, '.ops', 'leases');
  let names;
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(GUARD_FILE_SUFFIX)).sort();
  } catch {
    return [];
  }
  const guards = [];
  for (const name of names) {
    try {
      const value = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      if (value !== null && typeof value === 'object' && value.schema === GUARD_SCHEMA && typeof value.holder === 'string'
        && Array.isArray(value.writes) && Array.isArray(value.forbidden)) guards.push(value);
    } catch {
      // an unreadable allowlist is not a lease: the guard answers allow for it
    }
  }
  return guards;
}

// { repositoryRoot, workflowRoot } for a hook invoked from `cwd`: the overrides, else the git root, else the enclosing `akrs` folder.
export function locateRoots({ cwd, root = null, workflowRoot = null }) {
  const start = resolve(cwd);
  let repository = root === null ? null : resolve(start, root);
  if (repository === null) {
    for (let current = start; ; current = dirname(current)) {
      if (existsSync(join(current, '.git'))) {
        repository = current;
        break;
      }
      if (dirname(current) === current || current === parse(current).root) break;
    }
  }
  if (repository === null) repository = start;
  const workflow = workflowRoot === null ? join(repository, 'akrs') : resolve(start, workflowRoot);
  return { repositoryRoot: repository, workflowRoot: workflow };
}

const decision = (value, reason, path, extra = {}) => ({ schema: GUARD_SCHEMA, decision: value, reason, path, road: extra.road ?? null, detail: extra.detail ?? null });

// -> { schema, decision: 'allow' | 'deny', reason, path, road, detail }; never throws.
export function decideWrite({ path, executor = null, repositoryRoot, workflowRoot }) {
  try {
    if (typeof path !== 'string' || path === '') return decision('allow', 'guard_error', null);
    const absolute = isAbsolute(path) ? resolve(path) : resolve(repositoryRoot, path);
    const fromRepository = relative(repositoryRoot, absolute);
    if (fromRepository === '' || fromRepository === '..' || fromRepository.startsWith(`..${sep}`) || isAbsolute(fromRepository)) {
      return decision('allow', 'outside_repository', toPosix(path));
    }
    const repositoryPath = toPosix(fromRepository);
    if (!existsSync(workflowRoot) || !statSync(workflowRoot).isDirectory()) return decision('allow', 'no_workflow', repositoryPath);

    // CLI-owned files: never hand-edited (the CLI hash-checks them); only drafts are the agent's to write
    const workflowPrefix = toPosix(relative(repositoryRoot, workflowRoot));
    const inside = workflowPrefix === '' ? repositoryPath : (fold(repositoryPath) === fold(workflowPrefix) ? '' : (fold(repositoryPath).startsWith(`${fold(workflowPrefix)}/`) ? repositoryPath.slice(workflowPrefix.length + 1) : null));
    if (inside !== null) {
      if (fold(inside).startsWith('drafts/')) return decision('allow', 'drafts', repositoryPath);
      return decision('deny', 'cli_owned', repositoryPath, { detail: { workflow: workflowPrefix === '' ? '.' : workflowPrefix } });
    }

    const identity = executor ?? null;
    if (identity === null || identity === '') return decision('allow', 'no_identity', repositoryPath);
    const guards = readGuards(workflowRoot).filter(({ holder }) => holder === identity);
    if (guards.length === 0) return decision('allow', 'no_lease', repositoryPath);
    let refusal = null;
    for (const guard of guards) {
      const forbidden = guard.forbidden.find((pattern) => typeof pattern === 'string' && globMatches(pattern, repositoryPath));
      if (forbidden !== undefined) {
        refusal ??= decision('deny', 'forbidden', repositoryPath, { road: guard.road, detail: { pattern: forbidden } });
        continue;
      }
      if (guard.writes.some((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string' && writeCovers(entry, repositoryPath))) {
        return decision('allow', 'writes', repositoryPath, { road: guard.road });
      }
      refusal ??= decision('deny', 'outside_writes', repositoryPath, { road: guard.road, detail: { writes: guard.writes.map(({ path: declared }) => declared) } });
    }
    return refusal ?? decision('allow', 'no_lease', repositoryPath);
  } catch {
    return decision('allow', 'guard_error', typeof path === 'string' ? path : null);
  }
}

// The one-line reason a denied hook shows the agent (stderr of bin/akrs-guard.js and the `guard` packet).
export function denialMessage(result) {
  if (result.reason === 'cli_owned') return `${result.path} is CLI-owned workflow state: change it through an akrs command (drafts go under ${result.detail?.workflow ?? 'akrs'}/drafts/).`;
  if (result.reason === 'forbidden') return `${result.path} is forbidden by Road ${result.road} (${result.detail?.pattern}); ask the Leader (scope request) instead of editing it.`;
  return `${result.path} is outside the declared writes of Road ${result.road}; raise a scope request instead of editing it.`;
}
