// F7 (P1-W03): the frozen repository-lock decisions. Everything here is documentation that the tests pin down;
// repository-lock.js implements it and must not drift from it.
export const LOCK_OWNER_SCHEMA = 'akrs.lock-owner/v1';
export const LOCK_OWNER_KEYS = Object.freeze(['schema', 'pid', 'host', 'run_id', 'command', 'acquired_at']);
export const LOCK_FINDING_CODE = 'AKRS-C009';
export const LOCK_BLOCKED_REASONS = Object.freeze(['held', 'corrupt', 'foreign_host']);

export const LOCK_DEFAULT_TIMEOUT_MS = 5000;
export const LOCK_DEFAULT_RETRY_MS = 25;
export const LOCK_OPS_DIRECTORY = '.ops';
export const LOCK_DIRECTORY = 'lock';
export const LOCK_OWNER_FILE = 'owner.json';
export const LOCK_DISPLAY_PATH = `${LOCK_OPS_DIRECTORY}/${LOCK_DIRECTORY}`;

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const LOCK_POLICY = deepFreeze({
  location: LOCK_DISPLAY_PATH,
  owner_file: LOCK_OWNER_FILE,
  acquisition: 'Atomic non-recursive mkdir of <workflow>/.ops/lock after <workflow>/.ops exists (created first, recursively). EEXIST means the lock is held; the directory is the lock, so no check-then-create window exists.',
  owner_record: {
    schema: LOCK_OWNER_SCHEMA,
    keys: LOCK_OWNER_KEYS,
    encoding: 'Canonical JSON (two-space indent, trailing newline), written to owner.json.tmp-<run_id> inside the lock directory, fsynced and closed, then renamed to owner.json. No file handle is held across the critical section.',
    pid: 'process.pid of the acquirer (positive integer).',
    host: 'os.hostname() of the acquirer; a pid is only meaningful on the host that issued it.',
    run_id: 'ULID from the injected run-ID provider; identifies this acquisition and is the release/break token.',
    command: 'The command that holds the lock (1 to 200 characters, no control characters).',
    acquired_at: 'RFC 3339 UTC timestamp with milliseconds from the injected clock.',
    confinement: 'The record lives only under git-ignored .ops, which no snapshot projection reads. It is never written into canonical workflow artifacts. Lock facts handed to packets use the workflow-relative path .ops/lock and never an absolute machine path.',
  },
  containment: 'The path service must accept <workflow>/.ops/lock inside the repository. In addition .ops and .ops/lock must not be symbolic links or Windows junctions (lstat), .ops must be a directory whose real path stays inside the workflow root, otherwise PathSafetyError is thrown before anything is created. The lock never follows links, even inside the workflow.',
  mid_acquire_window: 'Between the mkdir and the owner.json rename the directory has no readable owner. A lock directory with a missing, partial or corrupt owner record is "corrupt" and blocks safely; it is never auto-stolen. A contender that sees such a directory keeps waiting inside its own wait budget and reports corrupt only if it is still unreadable at timeout.',
  wait: {
    default_timeout_ms: LOCK_DEFAULT_TIMEOUT_MS,
    default_retry_ms: LOCK_DEFAULT_RETRY_MS,
    jitter: 'delay = round(retry_ms * (0.5 + random())), clipped to the remaining budget; random, clock and sleep are injectable.',
    on_timeout: 'Return a stable blocked result (never throw) with an AKRS-C009 finding whose detail is { holder: {pid, host, run_id, command, acquired_at} | null, reason }.',
  },
  blocked_reasons: LOCK_BLOCKED_REASONS,
  finding_code: LOCK_FINDING_CODE,
  stale_proof: {
    by_age_alone: false,
    requires_same_host: true,
    requires_dead_pid: true,
    probe: 'process.kill(pid, 0): ESRCH proves death; success and EPERM mean alive; any other error is treated as alive. The probe is injectable.',
    foreign_host: 'An owner whose host differs from this host is never auto-recovered and its pid is never probed.',
    own_pid: 'An owner whose pid is this process is never recovered.',
  },
  pid_reuse: 'A live pid is never evicted, even if the operating system reused it for an unrelated process after the original holder died. This is deliberately conservative: the lock stays held and the human recovers it with breakLock.',
  recovery: {
    stale_directory_prefix: 'lock.stale-',
    claim_directory_prefix: 'lock.recover-',
    rule: 'The recoverer claims the stale owner by mkdir of .ops/lock.recover-<stale run_id> (the name is unique per owner, so a slow contender can never claim a successor; a busy claim means wait), re-reads the owner under the claim, renames .ops/lock to .ops/lock.stale-<recoverer run_id> (losers of any rename see ENOENT, ENOTEMPTY, EEXIST or EPERM and simply retry acquisition), verifies the moved owner record is still the one judged stale (a different record is restored and treated as held), removes the stale directory, releases the claim and retries mkdir.',
    claim_crash: 'A recoverer that dies between claiming and renaming strands only its claim: the lock of that exact owner stays held until breakLock names it, which also removes the claim. A claim left after a completed recovery is inert garbage under .ops.',
    recorded_as: 'Acquire results carry recovered: {pid, host, run_id} of the evicted owner, or null.',
    residual_risk: 'Only a human breakLock (or a probe that wrongly reports a live process dead, which the proof rules out) can remove a lock this protocol did not judge; the post-rename verification, the restore step and the owner-write retry remain as defence in depth.',
  },
  release: 'release() renames .ops/lock to .ops/lock.release-<run_id> and removes it, only if owner.json still carries this acquirer\'s run_id (otherwise { released: false, reason: "not_owner" }). The rename frees the lock in one step, so a waiter never sees a half-removed lock. Calling release again returns the first outcome. withRepositoryLock releases in finally on success and on a thrown failure.',
  manual_recovery: 'breakLock({ workflowRoot, expectedRunId }) removes the lock only when the current owner run_id equals expectedRunId. expectedRunId null removes a lock whose owner record stays unreadable after a settle delay and nothing else. Anything else is refused with a reason. The CLI command that calls it belongs to a later packet.',
  windows: 'No file handle is open across the critical section (write, fsync, close). rename and rmdir are retried on EPERM/EBUSY/EACCES with exponential backoff; a still-failing mkdir/rename is treated as lost the race. Junctions are detected as symbolic links by lstat.',
  snapshots: 'The lock, its owner record and every stale/release/break directory live under <workflow>/.ops, which no snapshot projection reads, so taking, holding or recovering the lock never changes a snapshot.',
  reusable_root: 'Every function also accepts lockRoot, an already validated absolute directory, in place of repositoryRoot/workflowRoot; the lock is then <lockRoot>/.ops/lock. The user-config registry lock will use this.',
});
