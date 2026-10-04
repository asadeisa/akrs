// P2-W05: the closed Road lifecycle. One table owns every legal status change; the lifecycle commands are the only
// writers of `status` (road update refuses it), and each transition names what it needs. Everything here is documentation
// that the tests pin down; the rest of lib/store/lifecycle implements it.
export const LIFECYCLE_FINDING_CODE = 'AKRS-R025';

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
};

// manifest command id -> { verb, from, to, requires, releases_lease }
export const LIFECYCLE_TRANSITIONS = deepFreeze({
  'road-activate': { verb: 'activate', from: ['QUEUED'], to: 'ACTIVE', requires: ['ready'], releases_lease: false },
  'road-finish': {
    verb: 'finish', from: ['ACTIVE'], to: 'DONE', requires: ['checks_pass', 'audit_clean', 'no_blocking_scope_request'], releases_lease: true,
  },
  'road-reopen': { verb: 'reopen', from: ['ACTIVE', 'DONE'], to: 'QUEUED', requires: [], releases_lease: true },
});

export const LIFECYCLE_READINESS_REASONS = Object.freeze([
  'class_fit', 'dependency_cycle', 'dependency_missing', 'dependency_not_done', 'executor_class_missing', 'executors_unusable',
  'no_executor_for_class', 'read_unresolved', 'road_unverified', 'snapshot_unstable',
]);
export const LIFECYCLE_TRANSITION_REASONS = Object.freeze([
  'checks_not_passed', 'illegal_transition', 'road_ambiguous', 'road_missing', 'scope_request_pending', 'undeclared_change',
]);
export const LIFECYCLE_REASONS = Object.freeze([...LIFECYCLE_READINESS_REASONS, ...LIFECYCLE_TRANSITION_REASONS].sort());

export const LIFECYCLE_POLICY = deepFreeze({
  decisions: {
    table: '(decision) The plan names the four commands but not the edges. The closed table is: activate QUEUED -> ACTIVE (the Leader\'s dispatch decision), finish ACTIVE -> DONE, reopen DONE -> QUEUED and ACTIVE -> QUEUED (taking a Road back from its Worker). Nothing else is legal; a Road in any other status is refused as illegal_transition with the status named.',
    check: '(decision) `road check` is a query: it reads the Leader readiness of the Road packet (the one source road-details --role leader uses), lists the legal transitions and what each requires, and writes nothing. It is `blocked` only when a QUEUED Road is not ready.',
    readiness: '(decision) Activation is blocked by every readiness blocker: an unverified or unreadable Road, an unstable snapshot, an unusable executor registry, a missing or unfinished dependency or one in a cycle, an unresolved read, a class-fit verdict other than fits (which includes needs_split), a Road with no executor class, and a class with no Worker executor. Dependency readiness (every dependency DONE) is not graph validity (no cycle, no missing Road).',
    finish_evidence: '(decision) finish runs the declared checks through the verify runner and the Road audit BEFORE it takes the lock (an execution never holds the lock), then re-judges everything that is state under the lock. Any declared check that did not pass, any undeclared or forbidden change, and any pending blocking scope request block it. A skipped audit (not a git repository, ignored control plane) is reported with its warning and does not block; a Road with no declared check has nothing to run. A dry run runs nothing and says so.',
    closure: '(decision) finish appends the DONE closure of the Road in the same transaction as the status change. The ledger records a Road once, so finishing a reopened Road does not append a second DONE record: the packet says `already_recorded`. reopen never edits the ledger.',
    lease: '(decision) finish and reopen release the Road lease right after the transaction commits, under the same repository lock. A crash in that narrow window leaves a lease that is already stale (the Road changed) and `lease release` clears it; the transaction manifest cannot hold .ops files.',
    snapshot: '(decision) activate, finish and reopen need an explicit --if-snapshot (a dry run never does). The lease-implied form belongs to the Worker intent commands of P2-W12 over these primitives.',
    roles: '(decision) The manifest declares the Leader as the role of activate, reopen and lease release and any role for finish, but no adapter enforces roles yet (no executor identity or authentication is invented), as for every earlier writer.',
    state: '(decision) STATE.md is derived from the committed workflow, so it cannot be rendered inside the transaction that changes it; the packets point at `state render` as the next command instead of writing a second derived file.',
    baseline: '(decision) No activation baseline of dirty files is stored (the closed Road schema and the transaction manifest have no place for it, and none is invented): finish takes the repeatable --pre-existing <path> flag the audit already has.',
  },
});
