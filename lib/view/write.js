// Writing the board: one file in the snapshot- and audit-excluded cache of the workflow. The write is contained by the path service, atomic
// (temp file, rename) and skipped when the file already holds exactly these bytes.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createPathService } from '../store/path-service.js';
import { VIEW_DIRECTORY, VIEW_FILE } from './policy.js';

// -> { path (repository-relative, /), outcome: 'written' | 'unchanged', bytes, sha256 }
export async function writeBoard({ repositoryRoot, workflowRoot, html }) {
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const target = await service.resolveWorkflowPath(`${VIEW_DIRECTORY}/${VIEW_FILE}`);
  const bytes = Buffer.from(html, 'utf8');
  const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  let current = null;
  try {
    current = await readFile(target.filesystem_path);
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
  }
  if (current !== null && current.equals(bytes)) return { path: target.relative_path, outcome: 'unchanged', bytes: bytes.length, sha256 };
  await mkdir(dirname(target.filesystem_path), { recursive: true });
  const temporary = `${target.filesystem_path}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, target.filesystem_path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { path: target.relative_path, outcome: 'written', bytes: bytes.length, sha256 };
}
