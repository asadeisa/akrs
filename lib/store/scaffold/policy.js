// P1-W13 frozen decisions for `init --scaffold`. Documentation the tests pin down; the rest of lib/store/scaffold
// implements it. Decisions beyond the packet and A1 text are marked (decision).
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const SCAFFOLD_FINDING_CODE = 'AKRS-S010';
export const SCAFFOLD_REASONS = Object.freeze(['target_exists']);
export const SCAFFOLD_TIERS = Object.freeze(['no_plan', 'plan']);
export const GITIGNORE_FILE = '.gitignore';
export const GITIGNORE_BLOCK_ID = 'akrs';
export const GITIGNORE_LINES = Object.freeze(['akrs/drafts/', 'akrs/.ops/', 'akrs/.cache/']);
export const CLASSIFY_QUESTION = 'Which model(s) will execute this work as Worker and as Tester, and how do you classify each: weak, medium, or frontier?';

export const SCAFFOLD_POLICY = deepFreeze({
  tiers: '`init --scaffold` creates the smallest honest workflow. Without --plan it is the no-Plan tier: Road R1, Task T1 and a verification contract keyed by the Road. With --plan <id> it is the Plan tier: plans/<id>.json, Road R-<id>-1 in roads/<id>/, Task T-<id>-1 and a contract keyed by the Plan. --road <id> names the Road (the Task ID follows: R1 -> T1, R-P1-1 -> T-P1-1, R-ONE -> T-ONE).',
  machine_fields: 'data.scaffold = { tier: no_plan | plan, plan_id (null in the no-Plan tier), road_id, task_id, key (the verification key), files (workflow-relative, code point order) }: package smoke tests and agents read these, they never guess identifiers.',
  writers: 'The files are built with the same builders the writers use (buildStoredRoad/renderRoad, renderTaskScaffold, buildStoredVerification, buildStoredState + renderStateMarkdown, the Plan codec) and written in ONE transaction, so a crash leaves the old or the complete new state. No divergent template format exists.',
  content: '(decision) The Road is QUEUED with one declared write (README.md, modify), one check (node --version), steps, acceptance and no executor_class; the contract has policy none; the State is mode 0, role leader, pointing at the Task with a next step that names the open executor question. Nothing is invented beyond that.',
  executors: 'Executors are written only from explicit input (`executor set`), never by the scaffold. The result reports the unclassified executor as an open question (data.questions_for_user) and validate reports AKRS-S006 until the user has classified them.',
  log: '(decision) No closure record is written: a closure for work that has not happened would be false. The ledger starts with the first real `log append`; validate reports the log check as not_applicable.',
  targets: 'The workflow folder is created when missing (not on a dry run). Any scaffold target that already exists refuses the whole command (AKRS-S010 target_exists) and nothing is written. --force turns exactly those targets from create into replace: no other file is touched or removed.',
  gitignore: 'A managed block `akrs` (hash style) with akrs/drafts/, akrs/.ops/ and akrs/.cache/ is added to the repository .gitignore through the managed-block primitive: created, updated or unchanged; a block edited by hand is never overwritten (outcome conflict, the file stays as it is). It is applied under the lock just before the transaction and never on a dry run; it is reported in data.gitignore, not in `changed` (it lives outside the workflow root).',
  determinism: 'The result depends only on the flags and the provider clock: two runs with the same inputs write identical bytes.',
  roles: '(decision) init --scaffold is `leader`; no adapter enforces roles in this packet. No MCP tool (bootstrap is a terminal action).',
});
