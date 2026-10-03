// F9 (P1-W05): the frozen transaction decisions. Everything here is documentation that the tests pin down; the rest
// of lib/store/transactions implements it and must not drift from it. Later writers do not bypass it: every command
// of TRANSACTIONAL_COMMANDS writes through runTransactionalMutation, and every other row of the command table is
// either a documented exception or not a mutation.
export const TRANSACTION_MANIFEST_SCHEMA = 'akrs.tx/v1';
export const TRANSACTION_STATES = Object.freeze(['staging', 'prepared', 'applying', 'committed']);
export const TRANSACTION_OPERATION_TYPES = Object.freeze(['create', 'replace', 'append', 'move', 'delete']);
export const TRANSACTION_MANIFEST_KEYS = Object.freeze([
  'schema', 'id', 'request_id', 'command', 'state', 'operations', 'directories', 'progress', 'created_at', 'committed_at',
]);
export const TRANSACTION_OPERATION_KEYS = Object.freeze(['index', 'type', 'path', 'to', 'before_hash', 'after_hash']);

export const TRANSACTION_DIRECTORY = 'tx';
export const TRANSACTION_DISPLAY_PATH = '.ops/tx';
export const MANIFEST_FILE = 'manifest.json';
export const PACKET_FILE = 'packet.json';
export const BEFORE_DIRECTORY = 'before';
export const AFTER_DIRECTORY = 'after';

// Where the coordinator fires its boundary hook while it runs a transaction, in order. `operation_applied` and the
// two image boundaries repeat once per operation. A hook that throws before `commit_marker` is a write failure
// (rolled back in process); from `journal_prepared` on, and from `commit_marker` on, it behaves like a crash.
export const TRANSACTION_BOUNDARIES = Object.freeze([
  'before_image_written',
  'after_image_written',
  'manifest_staged',
  'manifest_prepared',
  'journal_prepared',
  'operation_applied',
  'packet_written',
  'commit_marker',
  'journal_committed',
  'journal_indexed',
  'cleanup_started',
  'cleanup_images_removed',
  'cleanup_finished',
]);

// Boundaries of the recovery itself, so that a crash during recovery is testable too.
export const TRANSACTION_RECOVERY_BOUNDARIES = Object.freeze([
  'recovery_started',
  'recovery_step',
  'recovery_completed',
  'recovery_cleanup',
]);

export const TRANSACTION_FINDING_CODES = Object.freeze({
  recovery_blocked: 'AKRS-C014',
  invalid_change_set: 'AKRS-C015',
});

export const RECOVERY_BLOCK_REASONS = Object.freeze([
  'committed_without_journal', 'directory_missing', 'image_corrupt', 'image_missing', 'journal_mismatch',
  'manifest_corrupt', 'packet_corrupt', 'packet_missing', 'scratch_unsafe', 'target_unexpected',
]);

// Every mutation row of COMMAND_SNAPSHOT_TABLE that changes workflow artifacts. `road-check` is NOT here: it reports
// readiness without mutation (P2-W05); if it ever writes, it must be added. `state-render` is: STATE.md is a workflow
// file, only caches under .cache are `derived_write`. `init-scaffold` needs an existing (empty) workflow root.
export const TRANSACTIONAL_COMMANDS = Object.freeze([
  'done', 'executor-remove', 'executor-set', 'init-scaffold', 'log-append', 'memory-add', 'plan-finish',
  'road-activate', 'road-finish', 'road-move', 'road-new', 'road-reopen', 'road-update', 'scope-approve',
  'scope-reject', 'scope-request', 'state-render', 'state-set', 'task-new', 'test-define', 'test-handoff',
  'test-result', 'yield',
]);

export const TRANSACTION_EXCEPTIONS = Object.freeze({
  'agents-setup': Object.freeze({
    reason: 'agent_config',
    store: 'Per-agent managed configuration blocks in the repository (managed-block store, P2-W16); not workflow artifacts.',
  }),
  init: Object.freeze({
    reason: 'doctrine_install',
    store: 'The docs/akrs doctrine install store of P0-W06 (staged copy, hash-checked); not workflow artifacts.',
  }),
  'lease-release': Object.freeze({
    reason: 'lease_store',
    store: 'The .ops/leases store under the repository lock (F17); runs through runJournaledMutation with the transaction recovery hooks, so it never starts beside an unrecovered transaction.',
  }),
  postinstall: Object.freeze({
    reason: 'doctrine_install',
    store: 'The docs/akrs doctrine install store of P0-W06 (never overwrites local edits); not workflow artifacts.',
  }),
  'projects-add': Object.freeze({
    reason: 'user_config',
    store: 'The user-level projects registry with its own lock (P2-W17); outside every workflow root.',
  }),
  'projects-remove': Object.freeze({
    reason: 'user_config',
    store: 'The user-level projects registry with its own lock (P2-W17); outside every workflow root.',
  }),
  sync: Object.freeze({
    reason: 'doctrine_install',
    store: 'The docs/akrs doctrine install store of P0-W06 (explicit sync); not workflow artifacts.',
  }),
  work: Object.freeze({
    reason: 'lease_store',
    store: 'The .ops/leases store under the repository lock (F17); claims a lease and writes no workflow artifact; runs through runJournaledMutation with the transaction recovery hooks.',
  }),
});

// Rows of the command table that never write workflow artifacts: queries, executions (`test-run`, `verify`),
// read-only readiness checks and derived caches (`page`, `view`). Writing drafts (`road-fit --write-drafts`,
// `template --to-draft`) is scratch under drafts/, which is outside the transaction namespace by design.
export const TRANSACTION_NON_MUTATIONS = Object.freeze([
  'agents-doctor', 'agents-list', 'audit', 'boot', 'doctor', 'executor-list', 'explain', 'graph', 'guard', 'help',
  'log', 'mcp', 'next', 'page', 'projects-list', 'reuse-scan', 'road-check', 'road-details', 'road-fit', 'scope-list',
  'stale', 'status', 'status-all-projects', 'template', 'test-details', 'test-run', 'validate', 'verify', 'version',
  'view', 'watch', 'where',
]);

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const TRANSACTION_POLICY = deepFreeze({
  manifest_schema: TRANSACTION_MANIFEST_SCHEMA,
  location: TRANSACTION_DISPLAY_PATH,
  states: TRANSACTION_STATES,
  operation_types: TRANSACTION_OPERATION_TYPES,
  manifest_keys: TRANSACTION_MANIFEST_KEYS,
  operation_keys: TRANSACTION_OPERATION_KEYS,
  layout: {
    directory: '<workflow>/.ops/tx/<tx_id>/ where tx_id is a ULID from providers.runId(); created one segment at a time through the contained .ops helpers (no links, no escape).',
    manifest: 'manifest.json: closed akrs.tx/v1 { schema, id, request_id, command, state, operations[], directories[], progress, created_at, committed_at|null }, canonical two-space JSON, always replaced atomically (temp file inside the transaction directory, fsync, rename, directory fsync). `directories` is the one field beyond the lead brief: the workflow-relative directories that were absent at prepare time and that the operations create, so a restore removes exactly those (a byte-tree compare counts directories).',
    operation: 'Closed { index, type, path, to|null, before_hash|null, after_hash|null }. Paths are workflow-root-relative, forward-slash, validated by the path service. Hashes are sha256 of the exact bytes (no newline normalisation).',
    images: 'before/<index> holds the target bytes before the operation (replace, append, move, delete); after/<index> holds the bytes after it (create, replace, append, move). A create has no before image, a delete no after image. Images are written once, with fsync, before the staging manifest.',
    packet: 'packet.json: the final akrs.packet/v2 packet (snapshot.after already computed), written atomically after the last operation and BEFORE the commit marker. A roll forward finishes the journal commit from it.',
    scratch: 'A temporary apply file apply-<index>.tmp lives inside the transaction directory and is renamed over the target; a crash therefore never leaves a stray temp file in the artifact tree. .ops lives inside the workflow root, so the rename stays on one filesystem.',
  },
  targets: {
    allowed: 'Workflow artifacts only: every operation path (and every move destination) is relative to the workflow root. Road, Task, scope, plans, verifications, state, STATE.md, executors, log and memory all live there.',
    refused: [
      '.ops (the CLI scratch, journal, lock and leases), .cache, evidence under verifications/<plan>/evidence',
      'drafts/ except `delete` of an existing draft (A1 §4: a successful --input removes the draft and lists both paths in changed)',
      'archived ledgers LOG-<n>.md (read-only), links, directories, anything that resolves outside the workflow root',
      'a path that is not normalized, absolute, drive-relative, a glob, contains NUL, backslashes or a colon',
    ],
    containment: 'The path service must accept the path inside the repository, AND the nearest existing ancestor must resolve inside the workflow root (a link from the workflow to another repository folder is refused). The target itself must not be a link or a directory.',
    duplicates: 'A path may appear in at most one operation, as source or as destination.',
    repository_outside_workflow: 'Not writable by a transaction: product files are the Worker\'s, never the CLI\'s.',
  },
  operations: {
    create: 'The target must be absent; missing parent directories are created (and recorded in `directories`).',
    replace: 'The target must be an existing file; after image = new bytes.',
    append: 'The render supplies the bytes to add (non-empty); the coordinator builds after = before + added, so the before bytes are an exact prefix. The file is replaced atomically (no in-place append), which keeps every operation all-or-nothing. A missing target is an error: use create. JSONL rotation is an append (or replace) of the full segment plus a create of the next one, in one manifest.',
    move: 'path -> to, no content change (before_hash == after_hash); the destination must be absent. Applied as: write the destination atomically, then remove the source.',
    delete: 'The target must be an existing file; before image kept; after state is absent.',
    minimum: 'A transaction has at least one operation; a render that returns none is a programming error (TypeError). Commands that only touch .ops stores use the journal recovery hooks instead.',
    order: 'Operations are applied in index order and restored in reverse index order.',
    check_at_apply: 'Immediately before it is applied, each target is re-checked against its before hash; a mismatch (a non-CLI writer under the lock) rolls the transaction back.',
  },
  order: [
    'acquire lock',
    'recover every incomplete transaction',
    'journal conflict and replay check',
    'render and validate the full proposed tree',
    'write before and after images and the staging manifest (fsync)',
    'mark the manifest prepared',
    'append the journal prepared record (carries the transaction ID)',
    'apply the operations in order, durable progress after each',
    'compute the after snapshot and write packet.json',
    'write the commit marker (manifest state committed)',
    'append the journal committed record',
    'remove the transaction directory',
    'release lock',
  ],
  state_machine: 'staging -> prepared -> applying -> committed -> directory removed. `progress` is the count of operations applied, rewritten durably after each one (informational: recovery trusts file hashes, never the counter). The commit marker is the manifest state `committed` with committed_at set and progress equal to the operation count; it is the single commit point.',
  recovery: {
    when: 'Under the repository lock, at the start of every mutating command (journal recovery gate), BEFORE authorize, the caller-ID conflict check and the replay check. Standalone: recoverTransactions(). A mutation never begins while a transaction needs recovery.',
    rule: {
      no_manifest_or_staging: 'The directory is discarded (a manifest write that never completed leaves only manifest.json.tmp-*). No target was touched because applying starts only after the manifest is prepared.',
      prepared_or_applying: 'RESTORE: for every operation, in reverse order, bring the target back to its before image (before_hash null means absent). A target that already equals the before image needs nothing; one that equals the after image is restored from the before image after that image is verified against its hash; anything else blocks. Directories listed in the manifest are removed when empty. The journal hook answers rolled_back, the journal appends failed and the request is retryable.',
      committed: 'ROLL FORWARD: every target must equal its after image; one that equals the before image is re-applied from the after image (verified against its hash first); anything else blocks. The journal commit is then finished from packet.json (the journal hook answers committed with that packet) and the directory is removed.',
      proof_before_writes: 'Both directions first PROVE every step (target state and every image they need) and only then write, so a blocked recovery has changed no byte.',
      idempotent: 'Every step is derived from file hashes, so a recovery that is itself killed simply runs again.',
    },
    orphans: 'A directory the journal does not hold (no prepared record, a failed record, or a committed record whose cleanup was cut short) is swept by the same rule: discard or restore; a committed one is only removed when the journal records that very transaction as committed, otherwise it blocks (committed_without_journal).',
    in_process_failure: 'A failure while staging or applying (before the commit marker) restores in process through the same routine, removes the directory and rethrows the original error; the journal records failed. If the restore itself fails, the directory stays for the next mutation. If the manifest turns out to be committed, nothing is undone.',
  },
  corruption: {
    manifest: 'A manifest.json that exists but does not parse, is not a closed akrs.tx/v1 manifest, or names another directory is corrupt: every mutation is blocked (AKRS-C014 manifest_corrupt), nothing is written and nothing is guessed. Because every manifest write is an atomic rename, a crash cannot produce one; only manifest.json.tmp-* leftovers (a write that never completed) are discarded.',
    images: 'A staged image is trusted only if its bytes hash to the manifest hash. Missing or mismatching images block recovery only when the target is not already in the required state.',
    packet: 'A committed manifest whose packet.json is missing, unparseable, invalid or for another request blocks (packet_missing, packet_corrupt); the journal commit is never reconstructed.',
    journal: 'A journal-owned transaction whose directory is missing is blocked (directory_missing); a missing or staging manifest behind a prepared journal record is blocked too, because the journal record is only written after the manifest is prepared.',
    blocked_result: 'The blocked packet carries AKRS-C011 (recovery required, journal) and AKRS-C014 (reason, path, transaction). Manual recovery is the documented remediation; the CLI never deletes .ops/tx or .ops/journal itself.',
  },
  fsync: {
    files: 'Every image, the staging and prepared manifests, every progress update, packet.json, the commit marker and every applied target are written with file data fsync (open, write, fsync, close) before the next step.',
    directories: 'On POSIX the containing directory is fsynced after a file is created, renamed or removed (images, manifest and target renames, created directories, removals).',
    windows: 'A directory cannot be opened on Windows, so directory fsync is skipped there (NTFS journals metadata); file fsync still runs.',
    rename: 'rename is retried with exponential backoff on EPERM, EBUSY and EACCES, like the lock module.',
  },
  boundaries: {
    recorded: TRANSACTION_BOUNDARIES,
    recovery: TRANSACTION_RECOVERY_BOUNDARIES,
    hook: 'options.boundary({ point, index, request_id, transaction, command, ... }) is awaited at every boundary, after the step it names is durable. The crash tests SIGKILL the process inside it. A throw before `journal_prepared` (staging) or between `journal_prepared` and `commit_marker` (applying, packet.json) is a write failure: the transaction is restored in process, its directory removed and the error rethrown (the journal records failed once it holds a prepared record). A throw AT `journal_prepared`, from `commit_marker` on, and inside recovery behaves like a crash: nothing further is done in process and the next mutation recovers.',
  },
  journal: {
    prepared: 'The journal prepared record (and its pending marker) is written after the manifest is prepared and carries the transaction ID; the commit marker precedes the journal committed record.',
    hooks: 'The coordinator drives runJournaledMutation with beginTransaction (stage + prepare), apply (operations, packet, commit marker), recover (journal-owned transactions), sweep (orphans) and afterCommit (cleanup). Other journal callers (the lease-only commands) pass createTransactionRecovery() recover and sweep so they obey the same recovery gate.',
    recover_answers: '{ status: "rolled_back" } -> journal appends failed; { status: "committed", packet } -> journal appends committed from the stored packet, writes the index and carries on; anything else keeps the block, optionally with findings.',
  },
  snapshots: 'Transaction scratch lives under .ops/tx, which no snapshot projection reads, so staging, preparing and recovering never change a snapshot. packet.snapshot.after is a fresh commandSnapshot of the command row (or the caller\'s currentSnapshot) measured after the last operation and before the commit marker; snapshot.before is the measurement the journal took before validation.',
  windows: 'No shell is involved anywhere; file handles are closed before renames; rename retries on EPERM/EBUSY/EACCES; directory fsync is skipped.',
  commands: {
    transactional: TRANSACTIONAL_COMMANDS,
    exceptions: TRANSACTION_EXCEPTIONS,
    non_mutations: TRANSACTION_NON_MUTATIONS,
    rule: 'Every row of COMMAND_SNAPSHOT_TABLE is in exactly one of the three lists, and every enabled manifest command with mutability "mutation" is transactional or an exception. A new mutation row must be added to one of them.',
  },
  finding_codes: TRANSACTION_FINDING_CODES,
});
