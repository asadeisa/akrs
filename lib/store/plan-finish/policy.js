// P2-W08: the frozen decisions of `plan finish`, the Plan close gate. Documentation that the tests pin down; gate.js and
// index.js implement it. Decisions beyond the packet text are marked (decision).
const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
};

// The one new permanent code of the T family for the close gate: one finding names one blocker.
export const PLAN_FINISH_FINDING_CODE = 'AKRS-T007';
export const PLAN_FINISH_REASONS = Object.freeze([
  'already_closed', 'evidence_changed', 'evidence_missing', 'evidence_type_missing', 'finding_open', 'ledger_unusable', 'measurement_missing',
  'measurement_over_budget', 'no_roads', 'not_a_plan', 'plan_file_missing', 'plan_unverified', 'question_open', 'road_not_done', 'road_unverified',
  'run_failed', 'run_missing', 'seam_owner_missing', 'seam_owner_not_done', 'seam_unowned', 'tester_failed', 'tester_missing', 'tester_stale',
  'tester_unverified', 'unknown_plan',
]);

export const PLAN_FINISH_POLICY = deepFreeze({
  gate: 'A closed gate evaluator returns EVERY blocker, never the first only, in code point order of reason then subject. It runs once to preview (a dry run, which writes nothing) and again under the repository lock inside the transaction render, so the close judges the Plan as it is when it is written. Any blocker refuses the close as blocked (exit 1), one AKRS-T007 finding per blocker, and nothing is written.',
  required_roads: '(decision) The required Roads are every Road that declares this Plan. Each must verify and be DONE; a Plan with no Road cannot close (no_roads). A Road that no longer verifies is road_unverified, never skipped.',
  tester: 'The Tester proof is the current-result projection of P2-W07: the latest result must be a pass whose tested snapshot and contract hash are the ones measured now. A missing result is tester_missing, a fail or blocked result tester_failed, a pass that is no longer current tester_stale (the CLI never carries a pass forward), a missing or unverifiable contract or a blocked packet tester_unverified. The none policy needs no pass; every other gate still applies. (decision) A Plan needs a verification contract to close: without one the Tester proof is tester_unverified.',
  evidence: '(decision) A current pass is re-checked at close, because evidence is excluded from every snapshot and could change silently: every declared evidence type still has an entry, every evidence file still exists (evidence_missing) with the sha256 recorded in the result (evidence_changed), every declared measurement is present and within its budget as the CLI computes it, and for a contract with a scenario the run the pass references still exists and passed (run_missing, run_failed).',
  findings: '(decision) An open Tester finding is one whose latest status, by finding ID over the whole results ledger, is open; a later result resolves it by carrying the same ID as resolved. An open finding pointer in the Plan file (`findings`) also blocks, and is named result:finding. Results stay the evidence owner: the Plan file pointers are only read here.',
  seams_questions: '(decision) A seam with no owner is seam_unowned; a seam owned by a Road that does not exist is seam_owner_missing and by a Road that is not DONE is seam_owner_not_done; a seam owned by a wiring intent is accepted. Any open Plan question blocks (question_open); a resolved question needs no further record here.',
  closure: '(decision) A close is ONE journaled transaction under the repository lock: it replaces plans/<plan>.json with closure {status closed, at, operation} and appends the Plan DONE record to the closure ledger. The operation reference is {request, run}: the request ID of the close and a run ID drawn while rendering (the packet run ID is drawn after the write, so it cannot be named inside it). Both files name the same operation. The same request is a noop; another request on a closed Plan is already_closed. Nothing else changes: results, Roads, contract and evidence stay as they were.',
  snapshot: 'A close needs an explicit --if-snapshot (a dry run needs none): the snapshot of the Plan close projection (plan, contract, handoffs, product, reads, results, Roads). `plan finish --dry-run` names it and lists the blockers. A snapshot that no longer matches under the lock is blocked (AKRS-C013) and writes nothing.',
  stale: 'No stale pass is carried forward automatically: the gate re-measures the Tester packet snapshot and contract hash on every evaluation, so a product, workflow or SOT change after the pass makes it stale, and only a new pass closes the Plan. (decision) The close itself rewrites the Plan file, which the Tester packet snapshot measures, so after a close the current-result projection reports the pass as stale; a consumer reads the Plan closure state first (status and next, P2-W09). Closing never appends or edits a result.',
  roles: '(decision) The manifest declares the Leader as the role of plan finish; as for every earlier writer no adapter enforces roles yet.',
  state: '(decision) STATE.md is derived from the committed workflow, so the packet points at `state render` as the next command instead of writing a second derived file.',
});
