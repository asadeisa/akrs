// P2-W06: the frozen decisions of the Tester packet. Documentation that the tests pin down; index.js implements it.
const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
};

export const TESTER_FINDING_CODE = 'AKRS-T003';
export const NEVER_EDIT = 'Never edit product code.';

export const TEST_DETAILS_POLICY = deepFreeze({
  query: '(decision) test-details is a read-only query over the Tester packet projection (plan, plan-contract, plan-handoffs, plan-product, plan-reads, plan-roads). It writes nothing: no lease, no cache, no journal. The key is a Plan ID, or in the no-Plan tier the ID of the single Road.',
  blocked: '(decision) A packet is blocked, never silently partial: a missing or unverified contract returns only the identity and the blocker; any other blocker (a Road that is missing, unverified or not DONE, a Road without a handoff or whose latest handoff is not ready, an unresolved read, no acceptance, no launch, measurement or evidence type where the policy needs one, an unusable ledger, a workflow that changed while it was read) is returned beside the complete packet with status blocked. Policy none needs no Tester pass and has no blocker once its contract verifies.',
  diff: '(decision) The plan asks for a pinned product diff but defines no base to diff against. The diff is the inventory of the Plan\'s declared product writes exactly as the snapshot projection (plan-product) measures them: path, kind and content hash pinned to tested_snapshot, the Roads that declare each path, and the declared files that are absent. No source text is copied.',
  checks: '(decision) Road checks are listed with their declared argv and timeout. A check carries last_result only when the latest Tester result names it (passed, exit code, whether that result is current); mechanical `verify` results are never persisted, so none are invented.',
  previous: 'Failed and blocked results are listed as previous failures with `current` (same tested snapshot and contract hash as now) and counts_as_pass false; a pass is never carried forward. results.jsonl is not a snapshot input of the Tester packet (plan-results belongs to the close gate).',
  permissions: 'The Tester never receives a product write permission: the packet names exactly two writes, evidence under verifications/<key>/evidence and the structured result, and always leads its boundaries with the no-product-edit rule.',
  lease: '(decision) The Tester lease is only read (none, fresh, stale). The packet offers `test run` when the contract has a scenario to run; it offers no `test result` command, because a verdict is the Tester\'s to choose and no runnable command can invent it. The `runs` slot lists the latest runs, and the `result` slot is the current-result projection of P2-W07 (unverified, ready_for_test, testing, failed, passed, stale, not_required).',
  tester: '(decision) The Tester executor is resolved like a Worker holder (the only executor of role tester, or AKRS_EXECUTOR). A weak class makes test run mandatory before test result.',
  changed: 'The command snapshot is measured before and after the read; a difference is the blocker changed_during_query and the packet stays pinned to the first measurement.',
});
