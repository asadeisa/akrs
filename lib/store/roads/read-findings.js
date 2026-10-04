// Read-window problems of a list of reads as plain facts { path, pointer, reason, explanation }, for writers that report
// them under their own finding code (the Tester contract). Same projection and same tolerance as a Road read: a
// whole-file read may name a file that does not exist yet.
import { projectReadWindows } from './read-windows.js';

const EXPLANATIONS = {
  case_mismatch: 'differs in case from the file system entry',
  missing: 'does not exist',
  not_file: 'is a directory, but a read window needs a file',
  not_text: 'is not UTF-8 text, so it has no lines',
  unsafe: 'is not a safe repository path (it resolves outside the repository)',
};

export async function readWindowFindingsOf({ repositoryRoot, workflowRoot, reads }) {
  const windows = await projectReadWindows({ repositoryRoot, workflowRoot, road: { reads, writes: [] } });
  const problems = [];
  for (const window of windows) {
    const { status } = window;
    if (status === 'ok' || status === 'own_write') continue;
    if (status === 'missing' && window.lines === null) continue;
    problems.push({
      path: window.path,
      pointer: status === 'out_of_range' ? `/reads/${window.index}/lines` : `/reads/${window.index}/path`,
      reason: status,
      explanation: status === 'out_of_range' ? `has ${window.line_count} lines, so the declared window ends past the last line` : EXPLANATIONS[status],
    });
  }
  return problems;
}
