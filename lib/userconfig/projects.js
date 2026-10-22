// Looking at a project root from the registry side (F21): is it a usable AKRS project, and what is its status. Read only: nothing here
// opens a file in a project for writing, takes its lock or writes a cache.
import { lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { normalizeAbsolutePath } from '../core/roots.js';
import { buildStatusData } from '../store/navigation/status.js';
import { readWorkflowModel } from '../store/navigation/model.js';
import { DEFAULT_WORKFLOW, MAX_NAME_LENGTH, WORKFLOW_MARKERS } from './policy.js';

const missing = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
const within = (root, candidate) => {
  const fromRoot = relative(root, candidate);
  return fromRoot !== '' && !isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`);
};

async function statOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

// repository: an absolute or cwd-relative directory; workflow: a path relative to the repository (forward slashes) or null for the default.
// -> { ok: true, root (normalized real path), workflow (relative, /), name } | { ok: false, reason, subject }
export async function inspectProject({ cwd, repository, workflow = null, workflowOverride = null, name = null }) {
  const requested = resolve(cwd, repository);
  const entry = await statOrNull(requested);
  if (entry === null) return { ok: false, reason: 'missing', subject: normalizeAbsolutePath(requested) };
  const physical = await realpath(requested);
  if (!(await lstat(physical)).isDirectory()) return { ok: false, reason: 'not_a_directory', subject: normalizeAbsolutePath(physical) };
  const relativeWorkflow = workflowOverride === null ? (workflow ?? DEFAULT_WORKFLOW) : normalizeAbsolutePath(resolve(cwd, workflowOverride));
  const workflowPath = workflowOverride === null ? resolve(physical, ...relativeWorkflow.split('/')) : resolve(cwd, workflowOverride);
  const found = await statOrNull(workflowPath);
  if (found === null) return { ok: false, reason: 'not_akrs', subject: relativeWorkflow };
  const workflowPhysical = await realpath(workflowPath);
  if (!within(physical, workflowPhysical)) return { ok: false, reason: 'unsafe', subject: relativeWorkflow };
  if (!(await lstat(workflowPhysical)).isDirectory()) return { ok: false, reason: 'not_akrs', subject: relativeWorkflow };
  let marked = false;
  for (const marker of WORKFLOW_MARKERS) {
    if ((await statOrNull(join(workflowPhysical, marker))) !== null) {
      marked = true;
      break;
    }
  }
  if (!marked) return { ok: false, reason: 'not_akrs', subject: relativeWorkflow };
  const root = normalizeAbsolutePath(physical);
  const label = name ?? ([...basename(physical)].slice(0, MAX_NAME_LENGTH).join('') || root);
  return { ok: true, root, workflow: relative(physical, workflowPhysical).replaceAll('\\', '/'), name: label };
}

// The status of one registered project, read-only. -> { state, status|null, message|null }
export async function readProjectStatus(project, { env = {} } = {}) {
  const inspected = await inspectProject({ cwd: project.root, repository: project.root, workflow: project.workflow });
  if (!inspected.ok) return { state: inspected.reason === 'unsafe' ? 'unreadable' : inspected.reason, status: null, message: `${inspected.reason}: ${inspected.subject}` };
  try {
    const repositoryRoot = resolve(project.root);
    const model = await readWorkflowModel({ repositoryRoot, workflowRoot: resolve(repositoryRoot, ...project.workflow.split('/')), env, rootArgs: [] });
    return { state: 'ok', status: buildStatusData(model), message: null };
  } catch (error) {
    return { state: 'unreadable', status: null, message: error instanceof Error ? error.message : 'the project could not be read' };
  }
}
