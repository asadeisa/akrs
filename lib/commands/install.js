import { lstat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { CliUsageError } from '../core/errors.js';
import { createPacket } from '../core/packet.js';
import { normalizeAbsolutePath } from '../core/roots.js';
import { DEFAULT_SOURCE_ROOT, canonicalPath, installDoctrine } from '../store/doctrine-install.js';
import { discoverRoots } from '../store/roots.js';

const EMPTY_SNAPSHOT = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const CONFLICT_MESSAGES = Object.freeze({
  case_collision: 'a local file differs from the packaged path only by letter case',
  blocked_by_non_directory: 'a file or link blocks a directory the doctrine needs',
  blocked_by_non_file: 'a directory or link occupies a path the doctrine needs',
  locally_modified: 'it was edited locally',
  removed_upstream_modified: 'it was edited locally and no longer ships upstream',
  unowned_differs: 'it already exists with different content and was never installed by AKRS',
});

const SKIP_REASONS = Object.freeze({
  exec_install: 'installed by npm exec or npx',
  global_install: 'global installs have no project to sync into',
  init_cwd_is_package: 'the install was invoked from the package itself',
  no_init_cwd: 'not run by a package manager (INIT_CWD is unset)',
  not_a_dependency: 'the package is not installed inside node_modules',
  skip_requested: 'AKRS_SKIP_POSTINSTALL is set',
});

function conflictFinding({ path, reason, other_path: other }) {
  const named = other === undefined ? '' : ` (local spelling: ${other})`;
  return {
    code: 'AKRS-C007',
    severity: 'warning',
    message: `Installed doctrine file preserved because ${CONFLICT_MESSAGES[reason] ?? reason}: ${path}${named}.`,
    file: path,
    line: null,
    detail: other === undefined ? { path, reason } : { path, reason, other_path: other },
  };
}

function installData(action, result, extra = {}) {
  return {
    kind: 'install',
    action,
    dry_run: result.dry_run,
    applied: result.applied,
    target: result.target,
    changes: result.changes,
    conflicts: result.conflicts,
    recovery: result.recovery,
    unchanged_count: result.unchanged_count,
    ...extra,
  };
}

function didWork(result) {
  return result.applied || result.changes.length > 0;
}

function resultStatus(result) {
  if (result.conflicts.length > 0) return 'warning';
  return didWork(result) ? 'ok' : 'noop';
}

function requestIdOf(context, providers) {
  return context.request_id ?? providers.runId();
}

function knownCommandsOf(manifest) {
  return manifest.commands.map(({ id }) => id);
}

function resolveRepositoryRoot({ context, input }) {
  try {
    return discoverRoots({ cwd: context.cwd, repositoryRoot: input.flags['--root'] }).repository_root;
  } catch (error) {
    if (error instanceof TypeError) throw new CliUsageError(error.message);
    throw error;
  }
}

function writerPacket(command, { context, input, manifest, providers }, result, repositoryRoot) {
  return createPacket({
    command,
    requestId: requestIdOf(context, providers),
    status: resultStatus(result),
    root: repositoryRoot,
    snapshot: result.snapshot,
    data: installData(command, result),
    findings: result.conflicts.map(conflictFinding),
    changed: result.changed,
    providers,
    knownCommands: knownCommandsOf(manifest),
  });
}

async function writer(command, parameters) {
  const { context, input } = parameters;
  const repositoryRoot = resolveRepositoryRoot(parameters);
  const result = await installDoctrine({
    mode: command,
    repositoryRoot,
    sourceRoot: context.source_root ?? DEFAULT_SOURCE_ROOT,
    force: command === 'init' && input.flags['--force'] === true,
    dryRun: input.flags['--dry-run'] === true,
  });
  return writerPacket(command, parameters, result, repositoryRoot);
}

export const createInitPacket = (parameters) => writer('init', parameters);
export const createSyncPacket = (parameters) => writer('sync', parameters);

async function skipReason(env, packageRoot, initCwd) {
  if (env.AKRS_SKIP_POSTINSTALL) return 'skip_requested';
  if (!initCwd) return 'no_init_cwd';
  if (env.npm_config_global === 'true') return 'global_install';
  if (env.npm_command === 'exec') return 'exec_install';
  const canonicalPackage = await canonicalPath(packageRoot);
  if (!normalizeAbsolutePath(canonicalPackage).split('/').includes('node_modules')) return 'not_a_dependency';
  if (relative(await canonicalPath(initCwd), canonicalPackage) === '') return 'init_cwd_is_package';
  return null;
}

export async function createPostinstallPacket({ context, manifest, providers }) {
  const env = context.env ?? process.env;
  const packageRoot = resolve(context.package_root ?? DEFAULT_SOURCE_ROOT);
  const sourceRoot = context.source_root ?? packageRoot;
  const initCwd = env.INIT_CWD ? resolve(context.cwd, env.INIT_CWD) : '';
  const base = {
    command: 'postinstall',
    requestId: requestIdOf(context, providers),
    root: initCwd || context.cwd,
    providers,
    knownCommands: knownCommandsOf(manifest),
  };

  const reason = await skipReason(env, packageRoot, initCwd);
  if (reason !== null) {
    return createPacket({
      ...base,
      status: 'noop',
      snapshot: { before: EMPTY_SNAPSHOT, after: EMPTY_SNAPSHOT },
      data: {
        kind: 'install',
        action: 'postinstall',
        outcome: 'skipped',
        reason,
        detail: SKIP_REASONS[reason],
      },
    });
  }

  try {
    if (!(await lstat(initCwd)).isDirectory()) throw new CliUsageError(`INIT_CWD is not a directory: ${initCwd}`);
    const { repository_root: repositoryRoot } = discoverRoots({ cwd: initCwd });
    const result = await installDoctrine({ mode: 'sync', repositoryRoot, sourceRoot });
    const outcome = result.conflicts.length > 0 ? 'conflicts' : didWork(result) ? 'synced' : 'noop';
    return createPacket({
      ...base,
      root: repositoryRoot,
      status: resultStatus(result),
      snapshot: result.snapshot,
      data: installData('postinstall', result, { outcome }),
      findings: result.conflicts.map(conflictFinding),
      changed: result.changed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'internal error';
    return createPacket({
      ...base,
      status: 'error',
      snapshot: { before: EMPTY_SNAPSHOT, after: EMPTY_SNAPSHOT },
      data: { kind: 'install', action: 'postinstall', outcome: 'failed', reason: message },
      findings: [{
        code: 'AKRS-C004',
        severity: 'error',
        message: `postinstall could not sync the doctrine: ${message}`,
        file: null,
        line: null,
        detail: { reason: message },
      }],
    });
  }
}
