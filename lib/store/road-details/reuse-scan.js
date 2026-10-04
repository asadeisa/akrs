// P2-W02: the opt-in reuse scan of `road-details --reuse`. It is deliberately NOT part of validation: it only lists
// existing files whose NAME matches the base name of a file the Road creates. It never reads file content and never
// claims that a candidate behaves like the new file.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { compareStrings } from '../../schemas/common.js';

export const REUSE_SCAN_LIMITS = Object.freeze({ visited: 20000, per_write: 10 });
const LABEL = Object.freeze({
  candidate: 'same file name only; behaviour is not compared',
  more_omitted: `more files share this name; only the first ${REUSE_SCAN_LIMITS.per_write} are listed`,
  scan_incomplete: `the scan stopped after ${REUSE_SCAN_LIMITS.visited} entries; later files were not examined`,
});
const SKIPPED_DIRECTORIES = new Set(['node_modules']);
const baseName = (path) => path.slice(path.lastIndexOf('/') + 1).toLowerCase();

async function listFiles(repositoryRoot, skipRelative) {
  const files = [];
  let visited = 0;
  let complete = true;
  const walk = async (relative) => {
    const entries = await readdir(join(repositoryRoot, relative), { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => compareStrings(left.name, right.name));
    for (const entry of entries) {
      if (!complete) return;
      visited += 1;
      if (visited > REUSE_SCAN_LIMITS.visited) {
        complete = false;
        return;
      }
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name) || path === skipRelative) continue;
        await walk(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  await walk('');
  return { files, complete };
}

// writes: the Road's declared writes. Only a `create` of a file can reuse something that already exists.
export async function scanReuse({ repositoryRoot, workflowRelative, writes }) {
  const targets = writes.filter((write) => write.class === 'file' && write.action === 'create');
  if (targets.length === 0) return [];
  const { files, complete } = await listFiles(repositoryRoot, workflowRelative);
  const entries = [];
  for (const write of [...targets].sort((left, right) => compareStrings(left.path, right.path))) {
    const matches = files.filter((path) => path !== write.path && baseName(path) === baseName(write.path)).sort(compareStrings);
    for (const path of matches.slice(0, REUSE_SCAN_LIMITS.per_write)) {
      entries.push({ source: 'filename_match', kind: 'candidate', for_write: write.path, path, label: LABEL.candidate });
    }
    if (matches.length > REUSE_SCAN_LIMITS.per_write) entries.push({ source: 'filename_match', kind: 'more_omitted', for_write: write.path, path: null, label: LABEL.more_omitted });
  }
  if (!complete) entries.push({ source: 'filename_match', kind: 'scan_incomplete', for_write: null, path: null, label: LABEL.scan_incomplete });
  return entries;
}
