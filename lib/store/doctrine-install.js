import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliUsageError } from '../core/errors.js';
import {
  SNAPSHOT_PATTERN,
  compareStrings,
  isSortedUnique,
  validateWorkflowPath,
} from '../schemas/common.js';
import { isPlainObject, issue, validateClosedObject, validationResult } from '../schemas/validation.js';
import { PathSafetyError, createPathService, validateRestrictedPath } from './path-service.js';

export const DOCTRINE_TARGET = 'docs/akrs';
export const INSTALL_RECORD_NAME = '.akrs-install.json';
export const INSTALL_RECORD_SCHEMA = 'akrs.install-record/v1';
export const RECOVERY_MARKER_NAME = '.akrs-recovery.json';
export const RECOVERY_MARKER_SCHEMA = 'akrs.install-staging/v1';
export const DEFAULT_SOURCE_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

const MODES = Object.freeze(['init', 'sync']);
const MARKER_KEYS = Object.freeze(['role', 'schema_version']);
const MARKER_ROLES = Object.freeze(['backup', 'staging']);
const RECORD_KEYS = Object.freeze(['schema_version', 'files']);
const RECORD_FILE_KEYS = Object.freeze(['path', 'sha256']);
const REMOVE_OPTIONS = Object.freeze({ recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

const hashBytes = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const EMPTY_SNAPSHOT = hashBytes('');

export function validateInstallRecord(value) {
  const issues = [];
  if (!validateClosedObject(value, RECORD_KEYS, '$', issues)) return validationResult(issues);
  if (value.schema_version !== INSTALL_RECORD_SCHEMA) {
    issue(issues, '$.schema_version', 'invalid_value', `must be ${INSTALL_RECORD_SCHEMA}`);
  }
  if (!Array.isArray(value.files)) {
    issue(issues, '$.files', 'invalid_type', 'must be an array');
    return validationResult(issues);
  }
  value.files.forEach((entry, index) => {
    const path = `$.files[${index}]`;
    if (!validateClosedObject(entry, RECORD_FILE_KEYS, path, issues)) return;
    issues.push(...validateWorkflowPath(entry.path, `${path}.path`).issues);
    if (entry.path === INSTALL_RECORD_NAME) {
      issue(issues, `${path}.path`, 'invalid_value', 'the record cannot list itself');
    }
    if (typeof entry.sha256 !== 'string' || !SNAPSHOT_PATTERN.test(entry.sha256)) {
      issue(issues, `${path}.sha256`, 'invalid_format', 'must be a sha256 snapshot');
    }
  });
  const paths = value.files.map((entry) => entry?.path);
  if (paths.every((path) => typeof path === 'string') && !isSortedUnique(paths, compareStrings)) {
    issue(issues, '$.files', 'invalid_order', 'must be sorted by path and unique');
  }
  return validationResult(issues);
}

export function renderInstallRecord(files) {
  const sorted = [...files]
    .map(({ path, sha256 }) => ({ path, sha256 }))
    .sort((left, right) => compareStrings(left.path, right.path));
  return `${JSON.stringify({ schema_version: INSTALL_RECORD_SCHEMA, files: sorted }, null, 2)}\n`;
}

function markerBytes(role) {
  return Buffer.from(`${JSON.stringify({ schema_version: RECOVERY_MARKER_SCHEMA, role })}\n`);
}

// Returns the role of a valid recovery marker inside `directory`, or null for anything else.
async function readMarker(fs, directory) {
  const path = join(directory, RECOVERY_MARKER_NAME);
  const metadata = await inspect(fs, path);
  if (metadata === null || !metadata.isFile()) return null;
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(path, 'utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || Object.keys(parsed).sort(compareStrings).join() !== MARKER_KEYS.join()) return null;
  if (parsed.schema_version !== RECOVERY_MARKER_SCHEMA || !MARKER_ROLES.includes(parsed.role)) return null;
  return parsed.role;
}

async function removeValidMarker(fs, directory) {
  if ((await readMarker(fs, directory)) !== null) {
    await fs.rm(join(directory, RECOVERY_MARKER_NAME), { force: true });
  }
}

export function recoveryPaths(target = DOCTRINE_TARGET) {
  const segments = validateRestrictedPath(target).split('/');
  const name = segments.pop();
  const parent = segments.length === 0 ? '' : `${segments.join('/')}/`;
  return Object.freeze({
    staging: `${parent}.${name}.akrs-staging`,
    backup: `${parent}.${name}.akrs-backup`,
  });
}

function isWithin(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`));
}

function absoluteOf(root, path) {
  return join(root, ...path.split('/'));
}

async function inspect(fs, path) {
  try {
    return await fs.lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

async function loadDoctrineSource(fs, sourceRoot) {
  const frameworkRoot = join(sourceRoot, 'docs', 'framework');
  const gettingStarted = join(sourceRoot, 'GETTING_STARTED.md');
  const frameworkMeta = await inspect(fs, frameworkRoot);
  const startedMeta = await inspect(fs, gettingStarted);
  if (!frameworkMeta?.isDirectory() || !startedMeta?.isFile()) {
    throw new CliUsageError('packaged doctrine source is incomplete: docs/framework and GETTING_STARTED.md are required');
  }
  const files = [];
  async function walk(directory, prefix) {
    const entries = await fs.readdir(directory);
    entries.sort(compareStrings);
    for (const name of entries) {
      const path = `${prefix}/${name}`;
      const absolute = join(directory, name);
      const metadata = await fs.lstat(absolute);
      if (metadata.isDirectory()) await walk(absolute, path);
      else if (metadata.isFile()) files.push({ path, absolute });
    }
  }
  await walk(frameworkRoot, 'framework');
  files.push({ path: 'GETTING_STARTED.md', absolute: gettingStarted });
  const source = new Map();
  for (const { path, absolute } of files) {
    validateRestrictedPath(path);
    if (path === INSTALL_RECORD_NAME || path === RECOVERY_MARKER_NAME) {
      throw new PathSafetyError(`packaged doctrine uses a reserved name: ${path}`);
    }
    const bytes = await fs.readFile(absolute);
    source.set(path, { bytes, sha256: hashBytes(bytes) });
  }
  return new Map([...source].sort(([left], [right]) => compareStrings(left, right)));
}

async function resolveTarget(fs, { repositoryRoot, target, sourcePaths }) {
  const relativeTarget = validateRestrictedPath(target);
  let physicalRoot;
  try {
    physicalRoot = await fs.realpath(resolve(repositoryRoot));
    if (!(await fs.lstat(physicalRoot)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new CliUsageError(`repository root must be an existing directory: ${String(repositoryRoot)}`);
  }
  const paths = await createPathService({ repositoryRoot: physicalRoot, workflowRoot: physicalRoot });
  const resolved = await paths.resolveRepositoryPath(relativeTarget);
  if (resolved.findings.length > 0) throw new PathSafetyError(resolved.findings[0].message);
  const absolute = resolved.filesystem_path;
  if (!isWithin(physicalRoot, absolute) || isWithin(absolute, physicalRoot)) {
    throw new PathSafetyError(`doctrine target must be inside the repository root and cannot be it: ${relativeTarget}`);
  }
  for (const sourcePath of sourcePaths) {
    if (isWithin(absolute, sourcePath) || isWithin(sourcePath, absolute)) {
      throw new PathSafetyError(`doctrine target overlaps the packaged doctrine source: ${relativeTarget}`);
    }
  }
  let ancestor = dirname(absolute);
  while ((await inspect(fs, ancestor)) === null) ancestor = dirname(ancestor);
  const comparable = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  if (comparable(await fs.realpath(ancestor)) !== comparable(ancestor)) {
    throw new PathSafetyError(`doctrine target path crosses a symlink or junction: ${relativeTarget}`);
  }
  const metadata = await inspect(fs, absolute);
  if (metadata?.isSymbolicLink()) {
    throw new PathSafetyError(`doctrine target is a symlink or junction: ${relativeTarget}`);
  }
  if (metadata && !metadata.isDirectory()) {
    throw new PathSafetyError(`doctrine target exists and is not a directory: ${relativeTarget}`);
  }
  const names = recoveryPaths(relativeTarget);
  return {
    relative: relativeTarget,
    absolute,
    exists: metadata !== null,
    staging: absoluteOf(physicalRoot, names.staging),
    backup: absoluteOf(physicalRoot, names.backup),
  };
}

async function scanTree(fs, root) {
  const entries = new Map();
  async function walk(directory, prefix) {
    const names = await fs.readdir(directory);
    names.sort(compareStrings);
    for (const name of names) {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      const absolute = join(directory, name);
      const metadata = await fs.lstat(absolute);
      if (metadata.isSymbolicLink()) {
        entries.set(path, { kind: 'other' });
      } else if (metadata.isDirectory()) {
        entries.set(path, { kind: 'dir' });
        await walk(absolute, path);
      } else if (metadata.isFile()) {
        entries.set(path, { kind: 'file', sha256: hashBytes(await fs.readFile(absolute)) });
      } else {
        entries.set(path, { kind: 'other' });
      }
    }
  }
  if (root !== null) await walk(root, '');
  return entries;
}

function treeSnapshot(entries) {
  const lines = [...entries]
    .filter(([, entry]) => entry.kind === 'file')
    .map(([path, entry]) => `${path}\0${entry.sha256}\n`)
    .sort(compareStrings);
  return lines.length === 0 ? EMPTY_SNAPSHOT : hashBytes(lines.join(''));
}

function ancestorsOf(path) {
  const segments = path.split('/');
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}

async function readRecord(fs, targetAbsolute, entries) {
  const entry = entries.get(INSTALL_RECORD_NAME);
  if (entry === undefined) return new Map();
  if (entry.kind !== 'file') throw new CliUsageError('install record is invalid: it is not a regular file');
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(absoluteOf(targetAbsolute, INSTALL_RECORD_NAME), 'utf8'));
  } catch (error) {
    throw new CliUsageError(`install record is invalid: ${error.message}`);
  }
  const validation = validateInstallRecord(parsed);
  if (!validation.ok) {
    throw new CliUsageError(`install record is invalid: ${validation.issues[0].path} ${validation.issues[0].message}`);
  }
  return new Map(parsed.files.map(({ path, sha256 }) => [path, sha256]));
}

function recordFor(owned) {
  const files = [...owned].map(([path, sha256]) => ({ path, sha256 }));
  const text = renderInstallRecord(files);
  const bytes = Buffer.from(text);
  return { bytes, sha256: hashBytes(bytes) };
}

const fold = (path) => path.toLowerCase();

function groupByFold(paths) {
  const groups = new Map();
  for (const path of paths) {
    const key = fold(path);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(path);
  }
  return groups;
}

function planSync({ entries, source, owned }) {
  const writes = new Map();
  const expectations = new Map();
  const removals = [];
  const renames = [];
  const changes = [];
  const conflicts = [];
  const finalOwned = new Map();
  const handled = new Set();
  const upstreamFolds = groupByFold(source.keys());
  const localFolds = groupByFold([...entries].filter(([, entry]) => entry.kind !== 'dir').map(([path]) => path));
  let unchanged = 0;

  const keepOwned = (path) => {
    if (owned.get(path) !== undefined) finalOwned.set(path, owned.get(path));
  };
  const collide = (path, other) => {
    conflicts.push({ path, reason: 'case_collision', other_path: other });
    keepOwned(path);
    keepOwned(other);
  };

  for (const [path, upstream] of source) {
    const local = entries.get(path);
    const blocker = ancestorsOf(path).some((ancestor) => {
      const kind = entries.get(ancestor)?.kind;
      return kind === 'file' || kind === 'other';
    });
    const previous = owned.get(path);
    const rivals = upstreamFolds.get(fold(path)).filter((other) => other !== path);
    const variants = (localFolds.get(fold(path)) ?? []).filter((other) => other !== path);
    variants.forEach((variant) => handled.add(variant));
    if (blocker) {
      conflicts.push({ path, reason: 'blocked_by_non_directory' });
      keepOwned(path);
    } else if (rivals.length > 0) {
      collide(path, rivals[0]);
    } else if (variants.length > 0) {
      const [variant] = variants;
      const found = entries.get(variant);
      if (local === undefined && variants.length === 1 && found.kind === 'file'
        && owned.get(variant) !== undefined && found.sha256 === owned.get(variant)) {
        changes.push({ path, action: 'create' }, { path: variant, action: 'remove' });
        writes.set(path, upstream.bytes);
        expectations.set(variant, found.sha256);
        renames.push({ from: variant, to: path });
        finalOwned.set(path, upstream.sha256);
      } else if (local === undefined && variants.length === 1 && found.kind === 'file'
        && previous !== undefined && found.sha256 === upstream.sha256 && basename(variant) === basename(path)) {
        unchanged += 1;
        finalOwned.set(path, upstream.sha256);
      } else {
        collide(path, variant);
      }
    } else if (local === undefined) {
      changes.push({ path, action: 'create' });
      writes.set(path, upstream.bytes);
      expectations.set(path, null);
      finalOwned.set(path, upstream.sha256);
    } else if (local.kind !== 'file') {
      conflicts.push({ path, reason: 'blocked_by_non_file' });
      keepOwned(path);
    } else if (local.sha256 === upstream.sha256) {
      unchanged += 1;
      finalOwned.set(path, upstream.sha256);
    } else if (previous === undefined) {
      conflicts.push({ path, reason: 'unowned_differs' });
    } else if (previous === local.sha256) {
      changes.push({ path, action: 'update' });
      writes.set(path, upstream.bytes);
      expectations.set(path, local.sha256);
      finalOwned.set(path, upstream.sha256);
    } else {
      conflicts.push({ path, reason: 'locally_modified' });
      finalOwned.set(path, previous);
    }
  }

  for (const [path, previous] of owned) {
    if (source.has(path) || handled.has(path)) continue;
    const local = entries.get(path);
    if (local?.kind !== 'file') continue;
    if (local.sha256 === previous) {
      changes.push({ path, action: 'remove' });
      removals.push(path);
      expectations.set(path, local.sha256);
    } else {
      conflicts.push({ path, reason: 'removed_upstream_modified' });
      finalOwned.set(path, previous);
    }
  }

  const record = recordFor(finalOwned);
  const existing = entries.get(INSTALL_RECORD_NAME);
  if (existing === undefined) {
    changes.push({ path: INSTALL_RECORD_NAME, action: 'create' });
    writes.set(INSTALL_RECORD_NAME, record.bytes);
    expectations.set(INSTALL_RECORD_NAME, null);
  } else if (existing.sha256 !== record.sha256) {
    changes.push({ path: INSTALL_RECORD_NAME, action: 'update' });
    writes.set(INSTALL_RECORD_NAME, record.bytes);
    expectations.set(INSTALL_RECORD_NAME, existing.sha256);
  }
  return { changes, conflicts, writes, expectations, removals, renames, unchanged, swap: false };
}

function planReplace({ entries, source }) {
  const desired = new Map([...source].map(([path, { bytes, sha256 }]) => [path, { bytes, sha256 }]));
  const owned = new Map([...source].map(([path, { sha256 }]) => [path, sha256]));
  desired.set(INSTALL_RECORD_NAME, recordFor(owned));
  const changes = [];
  let unchanged = 0;
  for (const [path, wanted] of desired) {
    const local = entries.get(path);
    if (local === undefined || local.kind === 'dir') changes.push({ path, action: 'create' });
    else if (local.kind === 'file' && local.sha256 === wanted.sha256) unchanged += 1;
    else changes.push({ path, action: 'update' });
  }
  for (const [path, local] of entries) {
    if (!desired.has(path) && (local.kind === 'file' || local.kind === 'other')) {
      changes.push({ path, action: 'remove' });
    }
  }
  const wantedDirs = new Set([...desired.keys()].flatMap(ancestorsOf));
  const strayDirectory = [...entries].some(([path, local]) => local.kind === 'dir' && !wantedDirs.has(path));
  const writes = new Map([...desired].map(([path, { bytes }]) => [path, bytes]));
  return {
    changes,
    conflicts: [],
    writes,
    expectations: new Map(),
    removals: [],
    renames: [],
    unchanged,
    swap: changes.length > 0 || strayDirectory,
  };
}

async function stage(fs, location, writes) {
  await fs.rm(location.staging, REMOVE_OPTIONS);
  await fs.mkdir(location.staging, { recursive: true });
  await fs.writeFile(join(location.staging, RECOVERY_MARKER_NAME), markerBytes('staging'));
  for (const [path, bytes] of [...writes].sort(([left], [right]) => compareStrings(left, right))) {
    const absolute = absoluteOf(location.staging, path);
    await fs.mkdir(dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, bytes);
  }
}

async function currentHash(fs, absolute) {
  const metadata = await inspect(fs, absolute);
  if (metadata === null) return null;
  if (!metadata.isFile()) return 'non-file';
  return hashBytes(await fs.readFile(absolute));
}

async function swapIn(fs, location, { expectTarget }) {
  await fs.mkdir(dirname(location.absolute), { recursive: true });
  const present = (await inspect(fs, location.absolute)) !== null;
  if (!expectTarget && present) {
    throw new PathSafetyError(`doctrine target appeared during install; nothing was moved: ${location.relative}`);
  }
  const names = recoveryPaths(location.relative);
  if (!present) {
    await fs.rename(location.staging, location.absolute);
  } else {
    if ((await inspect(fs, location.backup)) !== null) {
      throw new PathSafetyError(`backup path is occupied by something that is not an AKRS backup: ${names.backup}`);
    }
    const markerPath = join(location.absolute, RECOVERY_MARKER_NAME);
    if ((await inspect(fs, markerPath)) !== null && (await readMarker(fs, location.absolute)) === null) {
      throw new PathSafetyError(`doctrine target contains a file that is not a recovery marker: ${location.relative}/${RECOVERY_MARKER_NAME}`);
    }
    await fs.writeFile(markerPath, markerBytes('backup'));
    try {
      await fs.rename(location.absolute, location.backup);
    } catch (error) {
      await removeValidMarker(fs, location.absolute);
      throw error;
    }
    try {
      await fs.rename(location.staging, location.absolute);
    } catch (error) {
      try {
        await fs.rename(location.backup, location.absolute);
      } catch (restoreError) {
        throw new PathSafetyError(
          `swap failed (${error.message}) and the previous tree could not be restored (${restoreError.message}); `
          + `it is preserved at ${location.backup}`,
        );
      }
      await removeValidMarker(fs, location.absolute);
      throw error;
    }
  }
  const pending = [];
  try {
    await removeValidMarker(fs, location.absolute);
  } catch {
    pending.push({ action: 'remove_marker', path: `${location.relative}/${RECOVERY_MARKER_NAME}` });
  }
  if (present) {
    try {
      await fs.rm(location.backup, REMOVE_OPTIONS);
    } catch {
      pending.push({ action: 'remove_backup', path: names.backup });
    }
  }
  return { pending };
}

async function applyInPlace(fs, location, plan) {
  const verify = async (path) => {
    const current = await currentHash(fs, absoluteOf(location.absolute, path));
    if (current !== plan.expectations.get(path)) {
      throw new PathSafetyError(`snapshot changed before write: ${location.relative}/${path}`);
    }
  };
  const renamedFrom = new Map(plan.renames.map(({ from, to }) => [to, from]));
  const writes = [...plan.writes.keys()].filter((path) => path !== INSTALL_RECORD_NAME).sort(compareStrings);
  const ordered = [...writes, ...plan.removals, ...(plan.writes.has(INSTALL_RECORD_NAME) ? [INSTALL_RECORD_NAME] : [])];
  for (const path of ordered) await verify(renamedFrom.get(path) ?? path);
  for (const path of writes) {
    const destination = absoluteOf(location.absolute, path);
    const from = renamedFrom.get(path);
    if (from === undefined) {
      await verify(path);
    } else {
      await verify(from);
      await fs.rm(absoluteOf(location.absolute, from), { force: true });
      if ((await currentHash(fs, destination)) !== null) {
        throw new PathSafetyError(`snapshot changed before write: ${location.relative}/${path}`);
      }
    }
    await fs.mkdir(dirname(destination), { recursive: true });
    await fs.rename(absoluteOf(location.staging, path), destination);
  }
  for (const path of plan.removals) {
    await verify(path);
    await fs.rm(absoluteOf(location.absolute, path), { force: true });
  }
  const emptied = new Set([...plan.removals, ...plan.renames.map(({ from }) => from)].flatMap(ancestorsOf));
  for (const directory of [...emptied].sort((left, right) => right.length - left.length)) {
    const absolute = absoluteOf(location.absolute, directory);
    if ((await inspect(fs, absolute))?.isDirectory() && (await fs.readdir(absolute)).length === 0) {
      await fs.rmdir(absolute);
    }
  }
  if (plan.writes.has(INSTALL_RECORD_NAME)) {
    await verify(INSTALL_RECORD_NAME);
    await fs.rename(absoluteOf(location.staging, INSTALL_RECORD_NAME), absoluteOf(location.absolute, INSTALL_RECORD_NAME));
  }
}

async function recover(fs, location, recovery) {
  for (const { action } of recovery) {
    if (action === 'remove_staging') {
      await fs.rm(location.staging, REMOVE_OPTIONS);
    } else if (action === 'remove_backup') {
      await fs.rm(location.backup, REMOVE_OPTIONS);
    } else if (action === 'remove_marker') {
      await removeValidMarker(fs, location.absolute);
    } else if (action === 'restore_backup') {
      await fs.rename(location.backup, location.absolute);
      await removeValidMarker(fs, location.absolute);
    }
  }
}

function changedBetween(before, after) {
  const signature = (entry) => {
    if (entry === undefined || entry.kind === 'dir') return null;
    return entry.kind === 'file' ? entry.sha256 : 'other';
  };
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => signature(before.get(path)) !== signature(after.get(path)))
    .sort(compareStrings);
}

export async function installDoctrine(options) {
  const {
    mode,
    repositoryRoot,
    sourceRoot = DEFAULT_SOURCE_ROOT,
    target = DOCTRINE_TARGET,
    force = false,
    dryRun = false,
    fsOps = {},
  } = options ?? {};
  if (!MODES.includes(mode)) throw new TypeError(`unknown install mode: ${String(mode)}`);
  const fs = { ...nodeFs, ...fsOps };
  const sourceAbsolute = resolve(sourceRoot);
  const location = await resolveTarget(fs, {
    repositoryRoot,
    target,
    sourcePaths: [join(sourceAbsolute, 'docs', 'framework'), join(sourceAbsolute, 'GETTING_STARTED.md')],
  });
  const source = await loadDoctrineSource(fs, sourceAbsolute);

  const names = recoveryPaths(location.relative);
  const stagingMeta = await inspect(fs, location.staging);
  const backupMeta = await inspect(fs, location.backup);
  const stagingOwned = stagingMeta?.isDirectory() === true && (await readMarker(fs, location.staging)) === 'staging';
  const backupOwned = backupMeta?.isDirectory() === true && (await readMarker(fs, location.backup)) === 'backup';
  const strayMarker = location.exists && (await readMarker(fs, location.absolute)) !== null;
  if (mode === 'init' && !force) {
    if (stagingOwned || backupOwned) {
      throw new CliUsageError(`interrupted install leftovers found beside ${location.relative}; run sync or init --force to recover`);
    }
    if (location.exists) {
      throw new CliUsageError(`${location.relative} already exists; use sync to refresh it or init --force to replace it`);
    }
  }
  const recovery = [];
  if (stagingMeta !== null) {
    recovery.push({ action: stagingOwned ? 'remove_staging' : 'skip_unmarked_staging', path: names.staging });
  }
  if (backupMeta !== null) {
    const action = !backupOwned ? 'skip_unmarked_backup' : location.exists ? 'remove_backup' : 'restore_backup';
    recovery.push({ action, path: names.backup });
  }
  if (strayMarker) recovery.push({ action: 'remove_marker', path: `${location.relative}/${RECOVERY_MARKER_NAME}` });
  const sortRecovery = () => recovery.sort((left, right) => compareStrings(left.action, right.action)
    || compareStrings(left.path, right.path));
  sortRecovery();
  const recoveryActions = recovery.filter(({ action }) => !action.startsWith('skip_'));

  let targetExists = location.exists;
  let scanRoot = targetExists ? location.absolute : null;
  let baseline = null;
  if (!dryRun && recoveryActions.length > 0) {
    baseline = await scanTree(fs, targetExists ? location.absolute : null);
    await recover(fs, location, recoveryActions);
    targetExists = (await inspect(fs, location.absolute)) !== null;
    scanRoot = targetExists ? location.absolute : null;
  } else if (!targetExists && backupOwned) {
    scanRoot = location.backup;
  }

  const entries = await scanTree(fs, scanRoot);
  const replace = mode === 'init' && force && entries.size > 0;
  const plan = replace
    ? planReplace({ entries, source })
    : planSync({ entries, source, owned: await readRecord(fs, scanRoot ?? location.absolute, entries) });
  const useSwap = plan.swap || scanRoot === null || (scanRoot === location.backup);
  const prefix = (path) => `${location.relative}/${path}`;
  const changes = plan.changes
    .map(({ path, action }) => ({ path: prefix(path), action }))
    .sort((left, right) => compareStrings(left.path, right.path));
  const conflicts = plan.conflicts
    .map(({ path, reason, other_path: other }) => (other === undefined
      ? { path: prefix(path), reason }
      : { path: prefix(path), reason, other_path: prefix(other) }))
    .sort((left, right) => compareStrings(left.path, right.path));
  const performedRecovery = baseline !== null;
  const origin = baseline ?? entries;
  const before = treeSnapshot(origin);
  const summary = {
    mode,
    dry_run: dryRun,
    target: location.relative,
    changes,
    conflicts,
    recovery,
    unchanged_count: plan.unchanged,
  };
  if (dryRun) {
    return { ...summary, applied: false, changed: [], snapshot: { before, after: before } };
  }
  if (changes.length === 0 && !plan.swap) {
    return {
      ...summary,
      applied: performedRecovery,
      changed: changedBetween(origin, entries).map(prefix),
      snapshot: { before, after: treeSnapshot(entries) },
    };
  }

  const stagingNow = await inspect(fs, location.staging);
  if (stagingNow !== null
    && !(stagingNow.isDirectory() && (await readMarker(fs, location.staging)) === 'staging')) {
    throw new PathSafetyError(`staging path is occupied by something that is not an AKRS staging directory: ${names.staging}`);
  }
  let swapped = { pending: [] };
  try {
    await stage(fs, location, plan.writes);
    if (useSwap) swapped = await swapIn(fs, location, { expectTarget: scanRoot !== null });
    else await applyInPlace(fs, location, plan);
  } finally {
    await fs.rm(location.staging, REMOVE_OPTIONS);
  }
  for (const note of swapped.pending) {
    if (!recovery.some(({ action, path }) => action === note.action && path === note.path)) recovery.push(note);
  }
  sortRecovery();

  const after = await scanTree(fs, (await inspect(fs, location.absolute)) === null ? null : location.absolute);
  const changed = changedBetween(origin, after).map(prefix);
  return { ...summary, applied: true, changed, snapshot: { before, after: treeSnapshot(after) } };
}
