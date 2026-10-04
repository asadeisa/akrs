// P1-W12 frozen decisions for the git adapter, the control-plane posture and the report-only Road audit. Documentation
// the tests pin down; the rest of lib/store/git implements it. Decisions beyond the packet text are marked (decision).
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const GIT_FINDING_CODES = Object.freeze({ change: 'AKRS-G001', absent: 'AKRS-G002', posture: 'AKRS-G003' });
export const POSTURES = Object.freeze(['tracked', 'ignored', 'mixed', 'not_git']);
export const POSTURE_REASONS = Object.freeze(['not_git', 'git_unavailable']);
export const AUDIT_STATUSES = Object.freeze(['clean', 'findings', 'skipped']);
export const AUDIT_SKIP_REASONS = Object.freeze(['posture_ignored', 'not_git', 'git_unavailable']);
export const AUDIT_CATEGORIES = Object.freeze([
  'undeclared', 'declared', 'missing_declared', 'pre_existing', 'test', 'workflow', 'evidence', 'agent_adapter', 'workflow_draft', 'workflow_cache',
]);

// Workflow-relative artifacts the posture looks at (the same set every writer owns); drafts, .cache and .ops are the
// snapshot- and audit-excluded namespaces.
export const WORKFLOW_DIRECTORIES = Object.freeze(['roads', 'plans', 'tasks', 'memory', 'log', 'scope', 'verifications']);
export const WORKFLOW_FILES = Object.freeze(['executors.json', 'state.json', 'STATE.md']);
export const DRAFT_NAMESPACES = Object.freeze(['drafts']);
export const CACHE_NAMESPACES = Object.freeze(['.cache', '.ops']);
export const EVIDENCE_PATTERN = /^verifications\/[^/]+\/evidence\//;

// Files `agents setup` manages (P2-W16 extends this list); they never count as undeclared product changes.
export const AGENT_ADAPTER_FILES = Object.freeze(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md']);
export const AGENT_ADAPTER_DIRECTORIES = Object.freeze(['.claude', '.codex', '.cursor', '.gemini', '.windsurf']);
export const TEST_DIRECTORIES = Object.freeze(['test', 'tests', '__tests__']);
export const TEST_FILE_PATTERN = /\.(?:test|spec)\.[^./]+$/;

export const GIT_AUDIT_POLICY = deepFreeze({
  adapter: 'git is invoked with argv arrays (no shell), LC_ALL=C and --no-optional-locks, and only ever reads: rev-parse, status --porcelain=v1 -z, ls-files -z, check-ignore -z. Stable porcelain output is parsed, never localized prose. Paths are NFC-agnostic bytes as git reports them (core.quotepath is irrelevant with -z), relative to the repository root the CLI resolved (a root below the git top level has its prefix stripped; entries outside it are dropped).',
  posture: '`readPosture` classifies the control plane from the workflow artifact files on disk (roads, plans, tasks, memory, log, scope, verifications, executors.json, state.json, STATE.md; drafts/.cache/.ops excluded): tracked files are in git, ignored files are matched by an ignore rule and not tracked, the rest are new untracked files that a commit would add. (decision) tracked = nothing ignored; ignored = ignored files and nothing tracked or addable; mixed = ignored files beside tracked or addable ones; not_git = no repository (or no git program). An empty workflow is tracked.',
  doctor: '`doctor` is a query that reports the posture (named files for ignored and mixed). tracked is ok; ignored, mixed and not_git are a warning (AKRS-G003) with remediation. The rest of doctor arrives with P2-W09.',
  audit: '`audit --git --road <id>` is a query: it reads `git status` once and classifies every changed path against the Road. It never writes a byte of the working tree. (decision) Flags: --git (required), --road <id> (required), --pre-existing <path> (repeatable): the paths that were already dirty before the Road started (the activation baseline P2-W05 will supply).',
  categories: 'undeclared (changed, not declared by the Road writes: also flags forbidden and case mismatches), declared (changed and declared), missing_declared (a declared `file` write with no change), pre_existing (in the baseline), test (undeclared test files), workflow (other workflow changes), evidence (verifications/*/evidence/**), agent_adapter, workflow_draft and workflow_cache (A1: excluded namespaces).',
  precedence: '(decision) workflow_draft/workflow_cache, then pre_existing, agent_adapter, evidence, workflow, declared, test, undeclared. A pre-existing dirty file stays pre_existing even if the Road also edited it (it cannot be told apart without content baselines).',
  matching: 'A change is declared when it equals a declared `file` write, lies under a declared `dir`, or matches a declared `glob` with the exact P1-W01 glob grammar. forbidden patterns are matched the same way. Case: a change equal to a declared file only ignoring case is NOT declared; it stays undeclared with case_mismatch and declared_as so the difference stays visible.',
  states: 'Each entry carries staged, unstaged and untracked flags from the porcelain XY code; entries are sorted by code point order of the path, so the report is deterministic. A rename lists the new path with renamed_from.',
  skipped: 'Non-git and ignored posture: the audit is `skipped` with a reason and a warning finding, never a pass. mixed posture still audits, with the posture warning. Exit code is 0 for ok and warning.',
  findings: 'AKRS-G001 one per undeclared change (reason undeclared | forbidden | case_mismatch), AKRS-G002 one per declared file write that did not change, AKRS-G003 the posture warning. All are warnings.',
});
