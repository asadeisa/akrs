// F8 (P1-W04, with A1 F17): the frozen request-ID journal decisions. Everything here is documentation that the
// tests pin down; the rest of lib/store/journal implements it and must not drift from it.
export const JOURNAL_OP_SCHEMA = 'akrs.op/v1';
export const JOURNAL_REQUEST_SCHEMA = 'akrs.op-request/v1';
export const JOURNAL_REPLAY_SCHEMA = 'akrs.op-replay/v1';
export const JOURNAL_REPLAY_AGAIN_SCHEMA = 'akrs.op-replay-again/v1';
export const JOURNAL_INDEX_SCHEMA = 'akrs.op-index/v1';
export const JOURNAL_PENDING_SCHEMA = 'akrs.op-pending/v1';

export const OP_STATES = Object.freeze(['prepared', 'committed', 'failed']);
export const OP_KEYS = Object.freeze([
  'id', 'hash', 'ts', 'request_id', 'command', 'target', 'request_hash', 'replay_key', 'state',
  'expected_snapshot', 'before', 'after', 'changed', 'packet_hash', 'packet', 'transaction', 'draft',
]);
export const TARGET_KEYS = Object.freeze(['road', 'plan']);
export const JOURNAL_FAULT_POINTS = Object.freeze(['after_prepared', 'after_apply', 'after_committed', 'after_index']);
export const DEDUPE_MODES = Object.freeze(['projection', 'append', 'none']);
export const JOURNAL_ORDER = Object.freeze([
  'acquire lock', 'recovery check', 'authorize', 'caller-ID conflict check', 'replay check', 'validate',
  'append prepared', 'apply', 'append committed', 'write index', 'release lock',
]);

export const JOURNAL_DIRECTORY = 'journal';
export const JOURNAL_DISPLAY_PATH = '.ops/journal';
export const DEFAULT_MAX_OPS = 1000;
export const DEFAULT_MAX_AGE_DAYS = 30;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const JOURNAL_FINDING_CODES = Object.freeze({
  request_conflict: 'AKRS-C010',
  recovery_required: 'AKRS-C011',
  stale_snapshot: 'AKRS-C013',
});

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const JOURNAL_POLICY = deepFreeze({
  op_schema: JOURNAL_OP_SCHEMA,
  request_schema: JOURNAL_REQUEST_SCHEMA,
  replay_schema: JOURNAL_REPLAY_SCHEMA,
  replay_again_schema: JOURNAL_REPLAY_AGAIN_SCHEMA,
  index_schema: JOURNAL_INDEX_SCHEMA,
  pending_schema: JOURNAL_PENDING_SCHEMA,
  location: JOURNAL_DISPLAY_PATH,
  layout: {
    ops: 'ops/<request_id>.jsonl: one file per request, append-only akrs.op/v1 state records.',
    index: 'by-key/<replay_key hex>.json: akrs.op-index/v1 { schema, replay_key, request_id }, the newest committed request for that replay key. Written in the same locked step after the committed record and always rebuildable from ops/*.',
    dirty: 'index.dirty (directly under .ops/journal): a flag file created and fsynced BEFORE the committed record is appended and removed AFTER the index entry is written. If it survives, a crash happened inside that window; the next mutation (under the lock) rebuilds the whole index from ops/* and clears it.',
    pending: 'pending/<request_id>.json: akrs.op-pending/v1 { schema, request_id, transaction }, a hint list of ops that hold a transaction. Written (temp + fsync + rename) BEFORE the prepared record and removed after the committed or failed record, so it is a superset of the truth; every reader re-verifies a marker against the op file and deletes stale ones. Only operations that begin a transaction create one.',
    creation: 'Directories are created lazily at the first write that needs them, one segment at a time, each lstat-checked (no links, no escape).',
  },
  request_id: {
    format: 'ULID (26 Crockford base32 characters, first character 0-7).',
    caller_supplied: 'Strict semantics. An invalid ID is a usage error (exit 2, AKRS-C001) and consumes nothing.',
    generated: 'When the caller supplies none the CLI generates one with the injected providers.runId() before taking the lock, and reports it through onRequestId immediately before the first journal write (never for replays, dry runs or rejected requests, which write nothing).',
    dry_runs: 'A dry run is never journaled and never consumes an ID: it takes no lock, generates nothing, calls authorize and validate with request_id null, and never calls apply.',
  },
  request_hash: {
    purpose: 'Caller-supplied-ID conflict check: same ID and a different request_hash is a usage error (AKRS-C010, exit 2) that writes nothing.',
    material: '{ schema: "akrs.op-request/v1", command, target, input, expected_snapshot|null } as closed canonical compact JSON, hashed with contentHash.',
    target: 'A closed { road: <id>|null, plan: <id>|null } object; missing keys mean null. A bare string target is refused so a Road and a Plan ID can never be confused.',
    input: 'The normalized input value: canonical JSON from the input channel (integers only, object keys sorted by code point, arrays in authored order). The journal stores only the hashes, never the input, prompt bodies or product contents.',
    expected_snapshot: 'Only an EXPLICIT --if-snapshot is hashed. A lease-implied expected snapshot is null here: it is re-derived on every attempt and advances with the holder\'s own commit, so hashing it would turn a harmless retry into a conflict.',
  },
  replay_key: {
    purpose: 'The A1 replay rule for generated IDs.',
    material: '{ schema: "akrs.op-replay/v1", command, target, input } as closed canonical compact JSON, hashed with contentHash. The expected snapshot is deliberately not part of it.',
    again_salt: 'saltReplayKey(replay_key, new_request_id) = contentHash of the closed compact { schema: "akrs.op-replay-again/v1", replay_key, request_id }. The --again op is stored under the salted key, so it never matches (or hides) the original; request_hash stays unsalted.',
  },
  replay: {
    generated_id: 'dedupe "projection" (default): replay as noop ONLY if a committed op exists for the replay key AND the current projection snapshot (computed by the caller for the command\'s table row) equals that op\'s recorded after. Only the newest committed op per key (the index entry) is considered. Otherwise the request is new and is applied again.',
    caller_supplied_id: 'Same ID + same request_hash + a committed op replays as noop. The projection condition is NOT required: the caller named the operation explicitly, and a crash-after-commit retry must not depend on nobody else having touched the workflow since.',
    re_validated_on_replay: 'Only the cheap authorize gate (role/ownership). A replay never re-runs validate (schema, lifecycle, expected snapshot): nothing is written, so there is nothing to protect, and a different role still cannot replay someone else\'s operation.',
    lookup: 'Index entry first, verified against the op file. A corrupt or dangling entry, a set dirty flag, or a by-key directory that is missing while ops exist fall back to scanning ops/* (and the entry is repaired under the lock). A single entry file that was simply deleted while the index is otherwise intact is a trusted miss: scanning every op on every fresh request cost 150 ms at 500 ops, so a human who deletes index files runs rebuildJournalIndex.',
  },
  replay_packet: {
    original: ['command', 'request_id', 'data', 'findings', 'next_commands'],
    status: 'noop',
    new: ['run_id', 'timestamp'],
    snapshot: '{ before: current, after: current } where current is the measurement taken for this call (equal to the recorded after for a generated-ID replay).',
    changed: [],
    outside_the_packet: 'The closed packet schema gets no new keys. The result carries replayed: { request_id, committed_at } beside the packet.',
    exit_code: 'Set by the journal only for packets it builds itself (usage 2, blocked 1); null for pass-through packets, whose exit code the adapter derives from the packet.',
  },
  states: OP_STATES,
  state_machine: 'prepared -> prepared | committed | failed; failed -> prepared; committed -> nothing. The first record is prepared. Anything else is a corrupt journal.',
  retry: {
    failed_or_prepared_without_transaction: 'Retryable with the same ID: a new prepared record is appended. A mutation whose apply can be interrupted halfway must therefore be idempotent or use a transaction (P1-W05).',
    prepared_with_transaction: 'Blocked as recovery required (AKRS-C011). P1-W05 owns recovery. The hook point is the `recover` option: it receives { request_id, transaction, record } and may return { status: "rolled_back" }, after which the journal appends a failed record and carries on. Any other answer keeps the block. Recovery blocks EVERY mutation, not only the same ID, because the transaction protocol never begins an unrelated mutation while recovery is required. P1-W05 adds one more answer, { status: "committed", packet }: the transaction was rolled forward, so the journal appends the committed record from that stored final packet (index and pending marker as for a normal commit) and carries on. A blocking answer may carry { findings }, which join the blocked packet after AKRS-C011. The optional `sweep` option runs under the same lock after the unresolved ops are settled and may return { findings } for transaction scratch the journal does not hold; settleRecovery() performs the same settling without a mutation.',
    validation_failure: 'authorize/validate/expected-snapshot rejections write nothing: no journal file, no ID consumed.',
    packet_encoding: 'The committed record stores the final packet through the closed canonical codec: integers only (no floats), no index-like or __proto__/constructor object keys. A packet that cannot be encoded is a programming error: it is recorded as failed (apply has already run) and the TypeError is thrown before anything is committed.',
    corrupt_journal: 'A record that fails its hash, schema, request-ID or state-machine check throws JournalCorruptError (exit 4 class, workflow-relative path in the error). The journal fails closed: it is never replayed from or silently repaired. A human moves the named file aside.',
    apply_failure: 'A thrown apply or an apply that returns an error or blocked packet appends failed and stays retryable. A thrown error is re-thrown unchanged.',
  },
  executions: 'dedupe "none" (test run, verify, page): never deduplicated and NOT recorded. The journal only provides the lock, the recovery check, authorize, validate and apply; no journal file is read or written and a repeated caller ID is simply another run.',
  appends: 'dedupe "append" (memory add, log append, test handoff): an exact duplicate (same command, target, input) replays as noop whether or not the projection moved on, because the helper findCommittedAppend takes no snapshot. The replay packet appends the caller\'s replayNextCommands so the agent is offered --again. --again (again: true) performs a new op under the salted replay key.',
  missing_draft: 'Committed ops record the draft path (a repository-relative string, never its content). resolveFromJournal({ command, target, draftPath, currentSnapshot?, replayKey? }) finds the newest committed op for that path before the caller raises a usage error for a missing draft, and reports projection_matches so the caller can apply the replay rule. replayKey narrows the match when the caller can still compute it (the brief called this input_hash).',
  expected_snapshot: 'The built-in check compares the explicit expectedSnapshot with the current command-row snapshot under the lock and answers blocked (AKRS-C013). Lease-implied guards are the caller\'s validate step (checkLease).',
  order: JOURNAL_ORDER,
  durability: {
    state_records: 'append + fsync of one compact canonical line, under the lock. A torn last line is ignored by readers and truncated before the next append.',
    index_and_marker: 'temp file + fsync + rename + directory fsync.',
    fault_points: JOURNAL_FAULT_POINTS,
    after_commit: 'options.afterCommit({ request_id, transaction, packet, command }) runs after the index entry is written and before retention; the transaction coordinator removes its scratch directory there. A throw from it behaves like a crash.',
    fault_hook: 'options.faults is { <point>: (context) => void | Promise<void> }; a hook may throw to simulate a crash. Unknown point names are a TypeError. Hooks sit outside the failed-record handling, so a throw behaves like a crash: no failed record is written.',
  },
  retention: { max_ops: DEFAULT_MAX_OPS, max_age_days: DEFAULT_MAX_AGE_DAYS },
  retention_rule: {
    rule: 'Finished ops (committed or failed) are ranked newest first by their last record timestamp. An op is pruned only when it is BOTH beyond the newest max_ops AND at least max_age old (kept if it is within either bound). Prepared ops are never pruned. The op being committed is never pruned by its own commit. Pruning runs only under the lock, removes the matching index entries, and is injectable: retention { maxOps, maxAgeMs }.',
    cost: 'Nothing is read while the number of op files is at most max_ops. The automatic check after a commit also runs only when the op count is a multiple of max(1, floor(max_ops / 20)), so a repository at the limit pays one scan per ~50 commits, not one per commit; pruneJournal itself always checks.',
  },
  fault_points: JOURNAL_FAULT_POINTS,
  dedupe_modes: DEDUPE_MODES,
  finding_codes: JOURNAL_FINDING_CODES,
  confinement: 'Everything lives under git-ignored <workflow>/.ops/journal, which no snapshot projection reads, so journaling never changes a command snapshot. Records hold hashes, snapshots, workflow-relative changed paths, the draft path and the final packet; never input bodies, prompts or product contents. Errors and findings carry workflow-relative paths only.',
});
