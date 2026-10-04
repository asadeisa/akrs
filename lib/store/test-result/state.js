// The pure core of the current-result projection (P2-W07): where a Plan stands with the Tester, derived from facts the caller has
// already read. A result is current exactly when its tested snapshot and contract hash are the ones measured now; a pass is never
// carried forward.
const summarize = (value, snapshot, hash) => ({
  id: value.id, ts: value.ts, verdict: value.verdict, tested_snapshot: value.tested_snapshot, contract_hash: value.contract_hash,
  current: value.tested_snapshot === snapshot && value.contract_hash === hash,
});

// facts: { contract|null, hash, snapshot, results: stored results in ledger order, runs: [{ current }], lease: { state }, blocked }
// -> { state, required, latest }
export function deriveTesterState({ contract, hash, snapshot, results = [], runs = [], lease = { state: 'none' }, blocked = false }) {
  const last = results.at(-1);
  const latest = last === undefined ? null : summarize(last, snapshot, hash);
  if (contract === null || contract === undefined) return { state: 'unverified', required: true, latest };
  if (contract.policy === 'none') return { state: 'not_required', required: false, latest };
  if (latest !== null && latest.current) return { state: latest.verdict === 'pass' ? 'passed' : 'failed', required: true, latest };
  if (latest !== null && latest.verdict === 'pass') return { state: 'stale', required: true, latest };
  if (blocked) return { state: 'unverified', required: true, latest };
  if (lease.state === 'fresh' || runs.some(({ current }) => current === true)) return { state: 'testing', required: true, latest };
  return { state: 'ready_for_test', required: true, latest };
}
