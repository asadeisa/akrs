// `agents setup` (F20): plan, then write each changed file whole through a sibling temporary file. Not a workflow transaction (the
// agent_config exception): every write re-reads the bytes it planned against, and a run cut off halfway is finished by running it again.
import { constants } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { PathSafetyError } from '../store/path-service.js';
import { planAgents } from './plan.js';

const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK']);

async function placeWithoutReplacing(fs, temporary, destination) {
  try {
    await fs.link(temporary, destination);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    if (!LINK_UNSUPPORTED.has(error?.code)) throw error;
  }
  try {
    await fs.copyFile(temporary, destination, constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

async function writeFile(fs, pathService, file) {
  const target = await pathService.resolveRepositoryPath(file.path);
  if (target.findings.length > 0) throw new PathSafetyError(target.findings[0].message);
  const slash = target.relative_path.lastIndexOf('/');
  const directory = slash === -1 ? '' : target.relative_path.slice(0, slash + 1);
  const name = target.relative_path.slice(slash + 1);
  const sibling = await pathService.resolveRepositoryPath(`${directory}.${name}.akrs-tmp-${randomBytes(6).toString('hex')}`);
  const temporary = sibling.filesystem_path;
  const changed = () => new PathSafetyError(`snapshot changed before write: ${file.path}`);
  try {
    await fs.mkdir(dirname(target.filesystem_path), { recursive: true });
    await fs.writeFile(temporary, file.after, { flag: 'wx' });
    if (file.before !== null) {
      const mode = await fs.lstat(target.filesystem_path);
      if (!mode.isFile()) throw changed();
      await fs.chmod(temporary, mode.mode & 0o7777);
      const current = await fs.readFile(target.filesystem_path);
      if (!current.equals(file.before)) throw changed();
      await fs.rename(temporary, target.filesystem_path);
    } else if (!(await placeWithoutReplacing(fs, temporary, target.filesystem_path))) {
      throw changed();
    }
  } catch (error) {
    await fs.rm(temporary, { force: true });
    if (error?.code === 'ENOENT' && file.before !== null) throw changed();
    throw error;
  }
  await fs.rm(temporary, { force: true });
}

// -> the plan plus { dry_run, applied, written } ; `written` lists the repository-relative files changed (empty for a dry run).
export async function setupAgents({
  repositoryRoot, workflowRoot, packageRoot, sourceRoot, agents, piMcp = false, dryRun = true, fsOps = {}, testHooks = {},
}) {
  const plan = await planAgents({ repositoryRoot, workflowRoot, packageRoot, sourceRoot, agents, piMcp });
  const fs = { ...nodeFs, ...fsOps };
  const pending = plan.files.filter(({ action }) => action === 'create' || action === 'update');
  const written = [];
  if (!dryRun) {
    for (const file of pending) {
      await testHooks.beforeWrite?.(file.path);
      await writeFile(fs, plan.pathService, file);
      written.push(file.path);
    }
  }
  return { ...plan, dry_run: dryRun, applied: written.length > 0, pending: pending.map(({ path }) => path), written };
}
