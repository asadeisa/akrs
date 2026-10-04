// The control-plane posture: are the workflow artifacts tracked, ignored or a mix (E8)? Reads only.
import { compareStrings } from '../../schemas/common.js';
import { createPathService } from '../path-service.js';
import { WORKFLOW_DIRECTORIES, WORKFLOW_FILES } from './policy.js';
import { runGit } from './runner.js';
import { locateGit } from './status.js';

// Repository-relative paths of every workflow artifact file on disk, sorted.
export async function workflowFiles({ repositoryRoot, workflowRoot }) {
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const files = [];
  for (const name of WORKFLOW_DIRECTORIES) files.push(...await service.walkWorkflowFiles(name));
  for (const name of WORKFLOW_FILES) files.push(...await service.walkWorkflowFiles(name));
  return [...new Set(files)].sort(compareStrings);
}

// -> { git, posture, reason, workflow_path, tracked, ignored, untracked }
export async function readPosture({ repositoryRoot, workflowRoot }) {
  const files = await workflowFiles({ repositoryRoot, workflowRoot });
  const base = { git: false, posture: 'not_git', reason: null, tracked: [], ignored: [], untracked: [] };
  const located = await locateGit({ repositoryRoot });
  if (!located.git) return { ...base, reason: located.reason };
  const listed = await runGit(repositoryRoot, ['ls-files', '-z']);
  if (!listed.ok) return { ...base, reason: 'not_git' };
  const known = new Set(listed.stdout.toString('utf8').split('\0').filter(Boolean));
  const tracked = files.filter((path) => known.has(path));
  const rest = files.filter((path) => !known.has(path));
  let ignored = [];
  if (rest.length > 0) {
    const checked = await runGit(repositoryRoot, ['check-ignore', '-z', '--stdin'], { input: `${rest.join('\0')}\0` });
    const hit = new Set(checked.stdout.toString('utf8').split('\0').filter(Boolean));
    ignored = rest.filter((path) => hit.has(path));
  }
  const untracked = rest.filter((path) => !ignored.includes(path));
  let posture = 'mixed';
  if (ignored.length === 0) posture = 'tracked';
  else if (tracked.length + untracked.length === 0) posture = 'ignored';
  return { git: true, posture, reason: null, tracked, ignored, untracked };
}
