import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { validateWorkflowPath } from '../schemas/common.js';

export const ROOT_OVERRIDE_FLAGS = Object.freeze([
  Object.freeze({ name: '--root', value_type: 'path', required: false, repeatable: false }),
  Object.freeze({ name: '--workflow-root', value_type: 'path', required: false, repeatable: false }),
]);

export const ROOT_DISCOVERY_POLICY = Object.freeze({
  override_base: 'cwd',
  repository_precedence: Object.freeze(['override', 'git', 'enclosing_workflow', 'cwd']),
  workflow_precedence: Object.freeze(['override', 'enclosing_workflow', 'repository_default']),
  default_workflow_directory: 'akrs',
});

export { validateWorkflowPath };

export function normalizeAbsolutePath(value) {
  const portable = value.replaceAll('\\', '/');
  const alreadyAbsolute = portable.startsWith('/') || /^[A-Za-z]:\//.test(portable);
  const normalized = (alreadyAbsolute ? portable : resolve(value).replaceAll('\\', '/'))
    .replace(/\/{2,}/g, (match, offset) => (offset === 0 ? match : '/'));
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, '');
}

function requireDirectory(value, label) {
  const resolved = resolve(value);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new TypeError(`${label} must identify an existing directory`);
  }
  return resolved;
}

function ancestors(start) {
  const values = [];
  let current = start;
  while (true) {
    values.push(current);
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) return values;
    current = parent;
  }
}

export function discoverRoots({ cwd, repositoryRoot, workflowRoot } = {}) {
  const resolvedCwd = requireDirectory(cwd, 'cwd');
  let repository = null;
  let workflow = null;
  let repositorySource;
  let workflowSource;

  if (repositoryRoot !== undefined) {
    repository = requireDirectory(resolve(resolvedCwd, repositoryRoot), 'repositoryRoot');
    repositorySource = 'override';
  } else {
    const lineage = ancestors(resolvedCwd);
    repository = lineage.find((candidate) => existsSync(join(candidate, '.git'))) ?? null;
    if (repository) {
      repositorySource = 'git';
    } else {
      workflow = lineage.find((candidate) => basename(candidate).toLowerCase() === 'akrs') ?? null;
      if (workflow) {
        repository = dirname(workflow);
        repositorySource = 'workflow';
        workflowSource = 'discovered';
      } else {
        repository = resolvedCwd;
        repositorySource = 'cwd';
      }
    }
  }

  if (workflowRoot !== undefined) {
    workflow = requireDirectory(resolve(resolvedCwd, workflowRoot), 'workflowRoot');
    workflowSource = 'override';
  } else if (!workflow) {
    workflow = join(repository, ROOT_DISCOVERY_POLICY.default_workflow_directory);
    workflowSource = 'default';
  }

  return {
    repository_root: normalizeAbsolutePath(repository),
    workflow_root: normalizeAbsolutePath(workflow),
    repository_source: repositorySource,
    workflow_source: workflowSource,
  };
}
