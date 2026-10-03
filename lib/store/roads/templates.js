// `template <kind> --to-draft <name>`: the one scratch write of the template command. It creates
// <workflow>/drafts/<name>.json exclusively (a draft is the agent's own file, never overwritten) outside the
// transaction namespace, which only ever deletes drafts. Drafts are excluded from snapshots.
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PathSafetyError, createPathService } from '../path-service.js';
import { draftPath, inRepository, isDraftName } from './paths.js';
import { DRAFT_DIRECTORY } from './policy.js';

export class DraftWriteError extends Error {
  constructor(reason, path, message) {
    super(message);
    this.name = 'DraftWriteError';
    this.reason = reason;
    this.path = path;
  }
}

export const draftContent = (skeleton) => `${JSON.stringify(skeleton, null, 2)}\n`;

// { path (repository-relative), workflow_path } or a DraftWriteError (`exists` | `unsafe`).
export async function writeTemplateDraft({ repositoryRoot, workflowRoot, name, skeleton }) {
  if (!isDraftName(name)) throw new TypeError('name must be a valid draft name');
  if (skeleton === null || typeof skeleton !== 'object') throw new TypeError('skeleton is required');
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const workflowPath = draftPath(name);
  const path = inRepository(service.workflow_relative_path, workflowPath);
  let resolved;
  try {
    resolved = await service.resolveWorkflowPath(workflowPath);
  } catch (error) {
    if (error instanceof PathSafetyError) throw new DraftWriteError('unsafe', path, error.message);
    throw error;
  }
  if (resolved.exists || !resolved.case_matches) {
    throw new DraftWriteError('exists', path, `${resolved.actual_relative_path} already exists; a draft is never overwritten`);
  }

  const directory = join(resolved.filesystem_path, '..');
  const existing = await lstat(directory).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing !== null && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new DraftWriteError('unsafe', path, `${inRepository(service.workflow_relative_path, DRAFT_DIRECTORY)} is not a plain directory`);
  }
  if (existing === null) await mkdir(directory);

  // write beside the target, then link: the link fails if the name appeared in the meantime (never an overwrite)
  const temporary = join(directory, `.${name}.json.tmp-${process.pid}-${Date.now()}`);
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(draftContent(skeleton), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, resolved.filesystem_path);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new DraftWriteError('exists', path, `${path} already exists; a draft is never overwritten`);
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return { path, workflow_path: workflowPath };
}
