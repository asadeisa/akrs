// P2-W12: the Worker and Leader intent commands. Constants and frozen decisions only; the tests pin them and the rest of
// lib/store/intents implements them. Every intent composes primitives that already exist (road-details, verify, audit, road finish,
// test handoff, the lease store, the scope ledger); none adds a second domain rule.
export const INTENT_FINDING_CODE = 'AKRS-R026';
export const WORK_SCHEMA = 'akrs.work/v1';
export const DONE_SCHEMA = 'akrs.done/v1';
export const YIELD_SCHEMA = 'akrs.yield/v1';
export const BOOT_SCHEMA = 'akrs.boot/v1';
export const GUARD_PACKET_SCHEMA = 'akrs.guard-check/v1';
export const INTENTS = Object.freeze(['work', 'done', 'yield', 'guard']);
export const INTENT_REASONS = Object.freeze([
  'class_mismatch', 'executors_unusable', 'holder_unresolved', 'lease_corrupt', 'lease_missing', 'needs_split', 'no_ready_road',
  'not_active', 'road_ambiguous', 'road_unverified', 'snapshot_unstable', 'cli_owned', 'forbidden', 'outside_writes',
]);
export const CLAIM_ACTIONS = Object.freeze(['claimed', 'refreshed', 'taken_over', 'unchanged']);
export const QUESTION_KINDS = Object.freeze(['classify_executors', 'no_worker_for_class', 'yielded_road']);
export const KERNEL_FILES = Object.freeze({ core: 'kernel/CORE.md', leader: 'kernel/leader.md' });
export const DONE_FLAGS = Object.freeze(['--result', '--reach', '--expect']);

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
};

export const INTENT_POLICY = deepFreeze({
  decisions: {
    composition: '(decision) Each intent is a composition in core over existing handlers and returns ONE packet whose data embeds the sub-results (the Worker packet of road-details, the finish evidence of road finish, the handoff record) instead of re-rendering prose. No intent adds a domain rule.',
    holder: '(decision) The holder is the executor ID: --executor, then AKRS_EXECUTOR, then the only Worker executor (the lease store rule). Anything unresolved is a blocked packet that names the choices and the command.',
    work_choice: '(decision) `work` with no Road takes the next ACTIVE, ready Road of the executor\'s class that is free or already its own (its own first, then Road ID order); a Road that needs a split is never chosen. `work <road>` names a Road explicitly and is refused as class_mismatch when the Road\'s class is not the executor\'s: the Leader dispatched it to another class. It never activates a Road: a QUEUED Road is refused as not_active.',
    work_claim: '(decision) The claim, the guard allowlist and the packet are one journaled step under the repository lock (a lease_store exception of the transaction policy). Repeating `work` on the holder\'s own unchanged lease is a `noop` claim that still returns the fresh packet; a changed contract refreshes the lease to the new projection (`refreshed`). Another holder gets `blocked` (AKRS-C012) naming the holder; `--takeover` is the explicit replacement and starts the failed-done count again.',
    work_empty: '(decision) Nothing ready is a `blocked` packet (AKRS-R026 no_ready_road) with every candidate Road and the reason it was not taken, never an empty ok.',
    guard_file: '(decision) `.ops/leases/<road>.guard.json` holds the holder, the workflow folder, the declared writes and `forbidden`; it is written by `work` and removed with the lease, however the lease ends. `akrs-guard` reads only it.',
    guard_rules: '(decision) CLI-owned workflow state is denied to everybody who asks (anything under the workflow folder except drafts/), because the amendment says "always"; every other path is allowed unless the caller is a lease holder (--executor or AKRS_EXECUTOR) and the path is outside the declared writes or under forbidden. No identity and no lease allow, so the Leader, Tester and human sessions are never blocked. A path the guard cannot judge, and a crash of the guard, allow: audit is the backstop.',
    done_flow: '(decision) `done` reads the lease (holder, fresh), builds the handoff, runs the declared checks and the audit UNLOCKED (the road-finish evidence step), then under the lock re-checks the lease projection and applies the handoff record, the DONE status and the closure in ONE transaction. Any failure finishes nothing and names every blocker. The expected snapshot is the lease projection (the lease row of the snapshot table), so the holder\'s own edits never stale it.',
    done_input: '(decision) --result, --reach (repeatable) and --expect are required unless the baton comes from --input <path>; a missing one is a usage error that names it. The CLI fills Road, snapshot and readiness of the handoff.',
    done_stale: '(decision) A changed contract projection is `blocked` (AKRS-C013, source lease) with the delta and the fresh Worker packet, so the agent sees the new contract in the same answer; the lease itself is refreshed by `work`.',
    done_audit: '(decision) Without git (not_git or an ignored control plane) the audit is `skipped`: the packet says so with the posture warning, and it is never counted as a pass.',
    done_failures: '(decision) A done refused after its checks and audit ran counts as a failure in .ops/leases/<road>.done.json; at the class limit (done_failures_before_yield) next_commands include `yield`. The count belongs to the lease and starts again with a new holder.',
    yield: '(decision) `yield <road> --reason` records a yield record in the Road\'s scope ledger and releases the lease in one transaction. The Road `needs_split` while the Road\'s contract hash is still the one recorded (a Road update, a reopen or a move decides it); a yield record whose hash does not verify holds nothing; the Leader sees it in boot as a question. Yield never waits on a stale lease: it is the escape hatch.',
    boot: '(decision) `boot` is a Leader query: the kernel files (kernel/CORE.md and kernel/leader.md of the workflow, absent when the Kernel was not generated yet), the workflow counts, questions_for_user (executors not classified, a Road class without a Worker, a yielded Road), class-fit blockers, Roads that need a split and pending scope requests, with the legal next commands. It writes nothing.',
  },
});
