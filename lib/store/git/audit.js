// `audit --git --road`: the report-only comparison of one Road's declarations with the repository changes.
import { GIT_FINDING_CODES } from './policy.js';
import { readRoad } from '../roads/repository.js';
import { createPathService } from '../path-service.js';
import { classifyChanges } from './classify.js';
import { readPosture } from './posture.js';
import { readChanges } from './status.js';

export function postureFinding(posture) {
  const files = posture.posture === 'ignored' ? posture.ignored : posture.ignored.slice(0, 5);
  const messages = {
    ignored: `The control plane (akrs/) is ignored by git (${posture.ignored.length} file(s), e.g. ${files.slice(0, 3).join(', ')}): commands that need committed workflow state refuse, and a worktree or CI job would not see it.`,
    mixed: `The control plane (akrs/) is partly tracked and partly ignored: ${posture.ignored.length} ignored (e.g. ${files.slice(0, 3).join(', ')}) beside ${posture.tracked.length} tracked.`,
    not_git: 'The project is not a git repository, so there is no tracked state and no audit.',
    git_unavailable: 'The git program could not be started, so there is no posture and no audit.',
  };
  const key = posture.posture === 'not_git' && posture.reason === 'git_unavailable' ? 'git_unavailable' : posture.posture;
  return {
    code: GIT_FINDING_CODES.posture,
    severity: 'warning',
    message: messages[key],
    file: files[0] ?? null,
    line: null,
    detail: { posture: key, ignored: posture.ignored.length, tracked: posture.tracked.length },
  };
}

// options: { repositoryRoot, workflowRoot, road, preExisting? } -> { problem } | the audit report
export async function auditRoad({ repositoryRoot, workflowRoot, road: id, preExisting = [] }) {
  const found = await readRoad({ repositoryRoot, workflowRoot, id });
  if (found === null) return { problem: 'road_missing' };
  if (found.meta_state !== 'declared') return { problem: 'road_unverified', issues: found.issues };
  const posture = await readPosture({ repositoryRoot, workflowRoot });
  const base = { road: id, posture: posture.posture, pre_existing_baseline: [...preExisting].sort() };
  const empty = { categories: null, counts: null };
  const findings = [];
  if (posture.posture === 'not_git' || posture.posture === 'ignored') {
    const reason = posture.posture === 'ignored' ? 'posture_ignored' : (posture.reason === 'git_unavailable' ? 'git_unavailable' : 'not_git');
    return { audit: { ...base, status: 'skipped', reason, ...empty }, findings: [postureFinding(posture)] };
  }
  if (posture.posture === 'mixed') findings.push(postureFinding(posture));
  const read = await readChanges({ repositoryRoot });
  if (read.changes === null) {
    return { audit: { ...base, status: 'skipped', reason: 'git_unavailable', ...empty }, findings: [postureFinding({ ...posture, posture: 'not_git', reason: 'git_unavailable' })] };
  }
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const { categories } = classifyChanges({
    changes: read.changes, road: found.road, workflowRelative: service.workflow_relative_path, preExisting,
  });
  for (const entry of categories.undeclared) {
    const reason = entry.forbidden ? 'forbidden' : (entry.case_mismatch ? 'case_mismatch' : 'undeclared');
    const message = {
      forbidden: `${entry.path} changed but the Road forbids it.`,
      case_mismatch: `${entry.path} changed but the Road declares ${entry.declared_as} (case differs).`,
      undeclared: `${entry.path} changed but the Road does not declare it.`,
    }[reason];
    findings.push({ code: GIT_FINDING_CODES.change, severity: 'warning', message, file: entry.path, line: null, detail: { reason, path: entry.path, declared_as: entry.declared_as } });
  }
  for (const entry of categories.missing_declared) {
    findings.push({
      code: GIT_FINDING_CODES.absent, severity: 'warning', message: `${entry.path} is declared (${entry.action}) but has no change.`, file: entry.path, line: null,
      detail: { reason: 'declared_absent', path: entry.path, action: entry.action },
    });
  }
  const counts = Object.fromEntries(Object.entries(categories).map(([name, list]) => [name, list.length]));
  const clean = categories.undeclared.length === 0 && categories.missing_declared.length === 0;
  return { audit: { ...base, status: clean ? 'clean' : 'findings', reason: null, categories, counts }, findings };
}
