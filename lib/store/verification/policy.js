// P1-W10 frozen decisions for the Tester sources: the Plan verification contract and the Worker handoff ledger.
// Everything here is documentation that the tests pin down; the rest of lib/store/verification implements it.
// Decisions beyond the packet text are marked (decision).
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const VERIFICATION_DIRECTORY = 'verifications';

// One new permanent code (T family): a Tester source write was refused by its guard.
export const TESTER_GUARD_CODE = 'AKRS-T002';
export const TESTER_GUARD_REASONS = Object.freeze([
  'ledger_unusable', 'no_change', 'read_unresolved', 'road_missing', 'road_not_started', 'road_unverified', 'road_wrong_plan',
  'snapshot_required', 'unknown_plan',
]);

export const VERIFICATION_STORE_POLICY = deepFreeze({
  location: '<workflow>/verifications/<key>/contract.json and handoff.jsonl. The key is the Plan ID, or in the no-Plan tier the ID of the single Road (Q13). results.jsonl and evidence/ belong to P1-W15/P2.',
  contract: 'The stored contract is exactly what the Leader supplied plus the CLI-owned `meta` {generator, content_hash}: nothing is invented, defaulted or reordered beyond the codec (set arrays are code-point sorted, ordered arrays keep their order). Policy rules (live and measured need launch data, measured needs measurements, ...) are the P1-W01 schema.',
  identity: '(decision) The key must name a known Plan or Road: plans/<key>.json exists, or some Road declares plan <key> (a Plan file need not exist yet), or a Road with ID <key> has no Plan (the no-Plan tier, where `roads` is exactly [key]). Otherwise unknown_plan. `plan` inside the document must equal the key.',
  roads: 'Every applicable Road must exist, be readable, and belong to the Plan (plan equals the key); in the no-Plan tier the only applicable Road is the keyed Road itself.',
  reads: 'Ordered source windows are validated like Road reads (containment, case, an existing UTF-8 text file whose line count covers a window; a whole-file read may name a file that does not exist yet) and stored in the Leader\'s order. Nothing from a source file is copied.',
  replace: 'Creating a contract needs no snapshot (the full state is revalidated under the lock). Replacing an existing one needs `--if-snapshot` (explicit; the lease form arrives with P1-W15); a dry run never does. An identical replacement is refused as no_change.',
  handoff: 'A handoff is a Worker append to <key>/handoff.jsonl: {id, hash, ts, road, snapshot, result, reach, expect, ready}. The Worker supplies road, result, reach[] and expect (flat flags, --input or --json -); the CLI fills id, hash, ts, the Road-scoped snapshot at the time of the handoff and `ready`. A hash or snapshot in the input is a schema error.',
  ready: '(decision) `ready` is true unless the Road still has a pending BLOCKING scope request (the Worker was told to stop, so the baton is not ready). A QUEUED Road has nothing to hand off and is refused as road_not_started.',
  acceptance: 'A handoff never changes acceptance: it writes only handoff.jsonl and never touches the contract or the Road.',
  duplicates: 'dedupe "append": an exact duplicate (same normalized document) of a committed handoff replays as noop offering --again; --again appends a deliberate duplicate.',
  ledger: 'Before a handoff is appended handoff.jsonl must read back through the codec (UTF-8, strict JSON lines, closed schema, unique ids, final newline); otherwise it is refused as ledger_unusable and nothing is written.',
  projection: 'readVerification returns the contract (declared or unverified), the handoffs in ledger order and the issues of both: the internal API Phase-2 test-details builds on. It never renders a prompt and never writes.',
  evidence: 'The contract names evidence TYPES only; evidence files are referenced by path and metadata in results (P2) and are never embedded.',
  roles: '(decision) test define is `leader`, test handoff is `worker`; as in the other Phase 1 writers no adapter enforces roles in this packet.',
});
