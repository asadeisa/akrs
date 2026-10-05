// F17 (P1-W04, A1 section 3.1): the frozen lease-store decisions. Store API only: no command creates leases yet
// (P2-W01 `work` and `test run` will). The tests pin this record down; store.js implements it.
export const LEASE_SCHEMA = 'akrs.lease/v1';
export const LEASE_KINDS = Object.freeze(['road', 'plan']);
export const LEASE_KEYS = Object.freeze([
  'schema', 'kind', 'target', 'holder', 'snapshot', 'inventory', 'acquired_at', 'refreshed_at', 'request_id',
]);
export const INVENTORY_KEYS = Object.freeze(['projection', 'key', 'kind', 'value']);
export const LEASE_DIRECTORY = 'leases';
export const LEASE_FILE_SUFFIX = '.lease.json';
// P2-W12: the two sidecars `work` keeps beside a Road lease directly under .ops/leases (never inside road/ or plan/). They live and die
// with the lease: releasing a Road lease, however it happens, removes both.
export const GUARD_FILE_SUFFIX = '.guard.json';
export const DONE_STATE_SUFFIX = '.done.json';
export const LEASE_ENV_VARIABLE = 'AKRS_EXECUTOR';
export const LEASE_FINDING_CODES = Object.freeze({ held_by_another: 'AKRS-C012', stale: 'AKRS-C013' });

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const LEASE_POLICY = deepFreeze({
  schema: LEASE_SCHEMA,
  location: '.ops/leases',
  files: {
    road: '.ops/leases/road/<road id>.lease.json: one lease per Road.',
    plan: '.ops/leases/plan/<plan id>.lease.json: one Tester lease per Plan.',
  },
  kinds: LEASE_KINDS,
  file_suffix: LEASE_FILE_SUFFIX,
  guard_allowlist: '.ops/leases/<road>.guard.json (decided by P2-W12, written by `work`). It sits directly under .ops/leases, never inside the road/ or plan/ directories, and ends in .guard.json, so it can never collide with a lease file or be read as one.',
  record: {
    keys: LEASE_KEYS,
    kind: 'road | plan.',
    target: 'The Road or Plan ID; also the file name stem.',
    holder: 'An executor ID (an ID in the executors file).',
    snapshot: 'The lease projection snapshot at the last claim/refresh: LEASE_CONTRACT_PROJECTION for a Road, TESTER_LEASE_PROJECTION for a Plan. It is NOT the command-row snapshot.',
    inventory: 'The lease projection inventory at that moment, entries { projection, key, kind, value } with hashes and tokens only, never file contents. It exists so a stale holder can be told which inputs changed (the delta).',
    acquired_at: 'RFC 3339 UTC timestamp when the current holder took the lease; kept across the holder\'s own refreshes.',
    refreshed_at: 'RFC 3339 UTC timestamp of the last claim, refresh or takeover.',
    request_id: 'ULID of the operation that last wrote the lease, or null.',
    encoding: 'Canonical JSON (two-space indent, trailing newline) written temp + fsync + rename.',
  },
  ttl: null,
  holder_resolution: ['flag', 'env', 'only_executor_of_role'],
  env_variable: LEASE_ENV_VARIABLE,
  holder_resolution_rule: 'resolveHolder: --executor, then AKRS_EXECUTOR, then the only executor of the requested role. A supplied value must name a known executor of that role; a bad flag never falls through to the environment. Anything unresolved is a result { status: "choices", reason, choices } (no throw) so the packet can enumerate the legal holders.',
  api: {
    lock: 'Every claim, refresh and release is a read-check-write under the repository lock. Callers already inside their critical section (the holder\'s own committed operation) pass heldLock (the handle); otherwise the function takes the lock itself and answers lock_blocked (AKRS-C009) if it cannot.',
    claim: 'claimLease: no lease -> claimed. Same holder -> noop (the lease is advanced to the given snapshot/inventory when they differ: refreshed true). Another holder -> blocked with the holder and AKRS-C012. takeover true replaces explicitly -> taken_over. A corrupt file blocks unless takeover.',
    refresh: 'refreshLease: holder only; sets snapshot and inventory to the given values (called inside the holder\'s committed operation, to snapshot.after). none / blocked / corrupt otherwise.',
    release: 'releaseLease: the holder, or an explicit Leader release (leader: true). Nothing to release is a noop.',
    read: 'readLease: none | held | corrupt. Never writes (queries never write).',
    check: 'checkLease({ lease, current }): current is a computeSnapshot result for the lease projection. none | fresh | stale with delta { changed, added, removed } of "<projection>:<key>" inventory keys. An unstable measurement is never fresh (stale, reason "unstable").',
  },
  expected_snapshot: 'resolveExpectedSnapshot: an explicit --if-snapshot always wins over the lease; otherwise the lease implies one. The result names the source and which measurement it must be compared against (command row for explicit, lease projection for lease-implied).',
  stale_handling: 'A stale holder mutation is blocked with AKRS-C013 (source "lease") whose detail carries the delta; leaseStaleFinding builds it.',
  corrupt: 'An unreadable or invalid lease file is reported as corrupt and never silently replaced: only an explicit takeover or Leader release replaces it.',
  worktrees: 'Leases live in git-ignored .ops, so every worktree has its own. Phase 3 must re-plan claims across worktrees and must not assume leases suffice.',
  finding_codes: LEASE_FINDING_CODES,
  confinement: 'Under <workflow>/.ops/leases, which no snapshot projection reads: leasing never changes a command snapshot. Directories are created lazily, one segment at a time, each lstat-checked.',
});
