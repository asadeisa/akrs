// P2-W07: the frozen decisions of `test result` and of the current-result projection. Documentation that the tests pin down;
// index.js, judge.js and projection.js implement it. Decisions beyond the packet text are marked (decision).
const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
};

// The one new permanent code of the T family: a Tester result was refused by its gate and nothing was written.
export const RESULT_FINDING_CODE = 'AKRS-T006';
export const RESULT_GUARD_REASONS = Object.freeze([
  'acceptance_contradicts', 'check_failed', 'check_undeclared', 'contract_missing', 'contract_unverified', 'evidence_missing',
  'evidence_type_missing', 'evidence_undeclared', 'finding_open', 'lease_missing', 'lease_stale', 'ledger_unusable', 'measurement_inconsistent',
  'measurement_missing', 'measurement_over_budget', 'measurement_undeclared', 'packet_blocked', 'policy_none', 'run_blocked', 'run_failed',
  'run_missing', 'run_required', 'run_stale', 'unknown_plan',
]);
export const TESTER_STATES = Object.freeze(['unverified', 'ready_for_test', 'testing', 'failed', 'passed', 'stale', 'not_required']);

export const RESULT_POLICY = deepFreeze({
  identity: '(decision) The CLI fills plan, tested snapshot, contract hash, run, id, hash and timestamp; the Tester never types a hash. tested_snapshot is the snapshot the Tester packet pinned (the `test-details` command snapshot measured now, under the lock), so a result is current exactly when `test-details` says it is: it names the same Plan, product, reads, Roads, handoffs and contract. A closed input key for any of these is a schema error (AKRS-T001, exit 2).',
  flat: '(decision) `test result <plan> --verdict pass|fail|blocked --because "<why>"` is the short form: the CLI fills user_acceptance (pass is answer yes, fail and blocked are answer no, with the Tester\'s reason), no checks, no measurements, no findings, and the evidence of the referenced run limited to the evidence types the contract declares. Everything else is the full JSON form (--input or --json -): the Tester states checks, measurements, evidence paths and types, findings and the acceptance answer, and the CLI measures bytes and sha256 of every evidence file itself.',
  pass: 'A pass is recorded only when every gate holds: the Tester packet is not blocked; every check the Tester reports is one a Road declares and passed (a Road is DONE only after its own checks passed, so the Tester is not made to re-run them); every declared measurement is present, in its declared unit and within budget; every declared evidence type has a file; no finding is open; the acceptance answer is yes; and, when the contract has a scenario to run, a current run of that scenario passed. Each failed gate is its own AKRS-T006 reason; nothing is written (status blocked, exit 1).',
  run: '(decision) The run a result references is the latest run record of the Plan. It is referenced only while it is current (its snapshot is the Tester lease snapshot measured now and its contract hash is the contract hash now). A pass needs it to exist, to be current and to be passed (a failed hard step or budget is run_failed, a run that could not run in full is run_blocked, an older snapshot is run_stale). A fail or blocked result may be recorded without a run, except for a weak Tester executor, which must run first (run_required). A result never changes a run record.',
  lease: '(decision) For a pass that needs a run, the Tester lease created by `test run` must still be held and fresh: a lease that is gone is lease_missing and one over an older Plan is lease_stale. The lease is read, never claimed or changed here.',
  evidence: 'Evidence entries are paths and types, never embedded data. The path must be under verifications/<plan>/evidence/ of THIS Plan, name a regular file with no link on the way (otherwise evidence_missing), and be of a type the contract declares (otherwise evidence_undeclared). The CLI measures bytes and sha256 of the file under the lock.',
  measurements: 'A measurement must be one the contract declares, in its unit; within_budget must equal what the CLI computes from the value and the declared budget and direction (max: value <= budget, min: value >= budget), otherwise measurement_inconsistent. An over-budget measurement is a legal fail result and never a pass.',
  checks: '(decision) A check the Tester reports must be one a Road of the Plan declares (by name); a result is never accepted as satisfying a check nobody declared. Checks are optional on a pass (Road checks are proven when the Road is finished), but a reported check that did not pass forbids a pass (check_failed).',
  append: 'The record is one canonical line appended to <key>/results.jsonl in one transaction under the repository lock, journaled with dedupe `append`: an identical document is a noop that offers --again; a retry with the same request ID replays the first answer. The ledger must read back cleanly before it takes a record (ledger_unusable). Earlier records are never rewritten.',
  state: '(decision) The current-result projection answers unverified (no verified contract or a blocked packet), ready_for_test, testing (a fresh Tester lease or a current run), failed (the latest result is a current fail or blocked), passed (the latest result is a current pass), stale (the latest result is a pass whose snapshot or contract hash is no longer current), and not_required for the none policy. The CLI never carries a pass forward: a relevant change makes it stale by itself. A stale fail simply returns the Plan to ready_for_test.',
  claims: 'A result never claims that a Plan is closed and offers no next command that closes it; closing is `plan finish` (P2-W08), which reads the projection.',
});
