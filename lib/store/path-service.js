import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CliUsageError } from '../core/errors.js';
import { compareStrings } from '../schemas/common.js';
import { normalizeAbsolutePath } from './roots.js';

export class PathSafetyError extends CliUsageError {}

export const PATH_SAFETY_POLICY = Object.freeze({
  contract: 'repository-relative-forward-slash',
  path_classes: Object.freeze(['file_or_directory']),
  glob_grammar: 'none_until_P1_W01',
  case_mismatch: 'finding',
  archived_ledger_pattern: '(^|/)LOG-[0-9]+\\.md$',
});

function safetyFailure(value, reason) {
  throw new PathSafetyError(`unsafe path "${String(value)}": ${reason}`);
}

export function validateRestrictedPath(value) {
  if (typeof value !== 'string' || value.length === 0) safetyFailure(value, 'path must be non-empty');
  if (value.includes('\0')) safetyFailure(value, 'NUL bytes are forbidden');
  if (value.includes('\\')) safetyFailure(value, 'backslashes, UNC paths, and device paths are forbidden');
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    safetyFailure(value, 'absolute and drive-relative paths are forbidden');
  }
  if (value.includes(':')) safetyFailure(value, 'NTFS alternate data stream forms are forbidden');
  if (/[*?\[\]{}]/.test(value)) safetyFailure(value, 'globs are not enabled until P1-W01');
  if (/[-]/.test(value)) safetyFailure(value, 'control characters are forbidden');
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    safetyFailure(value, 'path must be normalized and cannot traverse');
  }
  return value;
}

function isWithin(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === ''
    || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`));
}

async function isPresent(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

async function nearestExistingAncestor(candidate) {
  let current = candidate;
  while (!(await isPresent(current))) {
    const parent = resolve(current, '..');
    if (parent === current) safetyFailure(candidate, 'no existing ancestor can prove containment');
    current = parent;
  }
  return current;
}

async function inspectCase(root, segments) {
  const actual = [];
  let current = root;
  let caseMatches = true;

  for (let index = 0; index < segments.length; index += 1) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        actual.push(...segments.slice(index));
        break;
      }
      throw error;
    }
    entries.sort((left, right) => compareStrings(left.name, right.name));
    const expected = segments[index];
    const exact = entries.find(({ name }) => name === expected);
    const folded = entries.filter(({ name }) => name.toLowerCase() === expected.toLowerCase());
    if (exact) {
      actual.push(exact.name);
      current = join(current, exact.name);
    } else if (folded.length > 0) {
      caseMatches = false;
      actual.push(folded[0].name);
      current = join(current, folded[0].name);
    } else {
      actual.push(...segments.slice(index));
      break;
    }
  }
  return { actual, caseMatches };
}

function caseFinding(expectedPath, actualPath) {
  return {
    code: 'AKRS-C006',
    severity: 'warning',
    message: `Path case does not match the filesystem entry: ${expectedPath}.`,
    file: expectedPath,
    line: null,
    detail: { actual_path: actualPath, expected_path: expectedPath },
  };
}

export async function createPathService({ repositoryRoot, workflowRoot }) {
  const repositoryPhysical = await realpath(resolve(repositoryRoot));
  const workflowPhysical = await realpath(resolve(workflowRoot));
  const repositoryMetadata = await lstat(repositoryPhysical);
  const workflowMetadata = await lstat(workflowPhysical);
  if (!repositoryMetadata.isDirectory() || !workflowMetadata.isDirectory()) {
    safetyFailure(workflowRoot, 'repository and workflow roots must be directories');
  }
  if (!isWithin(repositoryPhysical, workflowPhysical)) {
    safetyFailure(workflowRoot, 'workflow root is outside the repository root');
  }
  const repositoryDisplay = normalizeAbsolutePath(repositoryPhysical);
  const workflowDisplay = normalizeAbsolutePath(workflowPhysical);
  const workflowRelative = relative(repositoryPhysical, workflowPhysical).replaceAll('\\', '/');

  async function resolveRepositoryPath(value, options = {}) {
    const relativePath = validateRestrictedPath(value);
    const segments = relativePath.split('/');
    const requested = resolve(repositoryPhysical, ...segments);
    if (!isWithin(repositoryPhysical, requested)) safetyFailure(value, 'lexical containment failed');

    const inspected = await inspectCase(repositoryPhysical, segments);
    const actualRelativePath = inspected.actual.join('/');
    const actual = resolve(repositoryPhysical, ...inspected.actual);
    const ancestor = await nearestExistingAncestor(actual);
    const physicalAncestor = await realpath(ancestor);
    if (!isWithin(repositoryPhysical, physicalAncestor)) {
      safetyFailure(value, 'existing symlink or nearest ancestor escapes the repository');
    }
    const exists = await isPresent(actual);
    if (options.mustExist && !exists) safetyFailure(value, 'target does not exist');
    const findings = inspected.caseMatches
      ? []
      : [caseFinding(relativePath, actualRelativePath)];

    return Object.freeze({
      repository_root: repositoryDisplay,
      workflow_root: workflowDisplay,
      relative_path: relativePath,
      actual_relative_path: actualRelativePath,
      absolute_path: normalizeAbsolutePath(requested),
      filesystem_path: actual,
      exists,
      case_matches: inspected.caseMatches,
      findings: Object.freeze(findings),
    });
  }

  async function resolveWorkflowPath(value, options = {}) {
    const workflowPath = validateRestrictedPath(value);
    const repositoryPath = workflowRelative === ''
      ? workflowPath
      : `${workflowRelative}/${workflowPath}`;
    return resolveRepositoryPath(repositoryPath, options);
  }

  async function walkFiles(value) {
    const target = await resolveRepositoryPath(value);
    if (!target.exists) return Object.freeze([]);
    const files = [];
    async function walk(directory, relativeDirectory) {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => compareStrings(left.name, right.name));
      for (const entry of entries) {
        const childRelative = `${relativeDirectory}/${entry.name}`;
        const childAbsolute = join(directory, entry.name);
        if (entry.isDirectory()) await walk(childAbsolute, childRelative);
        else if (entry.isFile()) files.push(childRelative);
      }
    }
    const metadata = await lstat(target.filesystem_path);
    if (metadata.isFile()) return [target.actual_relative_path];
    if (!metadata.isDirectory()) return [];
    await walk(target.filesystem_path, target.actual_relative_path);
    return Object.freeze(files);
  }

  async function walkWorkflowFiles(value) {
    const workflowPath = validateRestrictedPath(value);
    const repositoryPath = workflowRelative === ''
      ? workflowPath
      : `${workflowRelative}/${workflowPath}`;
    return walkFiles(repositoryPath);
  }

  function assertWritableTarget(value) {
    const relativePath = validateRestrictedPath(value);
    if (/(?:^|\/)LOG-[0-9]+\.md$/i.test(relativePath)) {
      throw new PathSafetyError(`archived ledger is read-only: ${relativePath}`);
    }
    return relativePath;
  }

  return Object.freeze({
    repository_root: repositoryDisplay,
    workflow_root: workflowDisplay,
    workflow_relative_path: workflowRelative,
    resolveRepositoryPath,
    resolveWorkflowPath,
    walkFiles,
    walkWorkflowFiles,
    assertWritableTarget,
  });
}
