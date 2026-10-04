// F12 (frozen in P2-W03): how `verify --road` runs a declared check and what it captures. One object, so the runner, the
// help text, the docs and the tests all read the same decisions.
export const F12_POLICY = Object.freeze({
  shell: 'never: argv arrays only; the child receives each argv entry as one literal argument',
  clock: Object.freeze({
    source: 'a monotonic clock (process.hrtime) read right after the process was started and again when it has ended; injectable for tests',
    timeout: 'each check owns its declared timeout_ms, counted from the start; the timer is never reset by output',
    duration: 'integer milliseconds between the two readings; null when the process never started',
  }),
  timeout: Object.freeze({
    scope: 'per check (the Road\'s timeout_ms, 1..3600000); there is no total budget and no default for a check without one',
    result: 'status timed_out wins over whatever exit the terminated process reports; the recorded exit_code and signal are the real ones',
  }),
  termination: Object.freeze({
    grace_ms: 2000,
    wait_after_kill_ms: 5000,
    posix: 'the check runs in its own process group; on timeout or interruption SIGTERM goes to the whole group, then SIGKILL to the whole group after grace_ms if any member is still alive',
    windows: 'a graceful stop of a console process is not available, so the whole tree is force-ended at once (taskkill /PID <pid> /T /F); termination is always "forced"',
    recorded: 'none (never terminated), graceful (stopped inside the grace period), forced (SIGKILL or taskkill), unconfirmed (still not closed wait_after_kill_ms after the kill)',
    limit: 'a descendant that leaves the process group on purpose (setsid, detached, a service manager) cannot be reached; the contract covers the check\'s own tree',
  }),
  interruption: Object.freeze({
    sources: 'SIGINT, SIGTERM and SIGHUP delivered to the CLI while a check runs, or an AbortSignal handed to the runner',
    behavior: 'the running check is terminated as for a timeout, the remaining selected checks are not run, the status of the interrupted check is "interrupted" and the final packet is still printed with status error',
    last_resort: 'a process exit while a check runs force-ends its group synchronously',
  }),
  capture: Object.freeze({
    stream_cap_bytes: 65536,
    head_bytes: 32768,
    tail_bytes: 32768,
    rule: 'each stream is captured separately; up to stream_cap_bytes the whole text is kept, beyond it the first head_bytes and the last tail_bytes are kept and total_bytes stays the exact count',
    decoding: 'UTF-8 with replacement characters; control and binary bytes are data inside JSON strings and never reach the CLI stdout or stderr',
    stdin: 'closed: a check reads nothing',
  }),
  cwd: 'the repository root, always; reported as "." so the packet does not depend on the machine',
  environment: Object.freeze({
    rule: 'an allow-list, not a copy: only the names below are inherited from the CLI, matched case-insensitively on Windows, plus NO_COLOR=1',
    inherited: Object.freeze(['APPDATA', 'COMSPEC', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE']),
    set: Object.freeze({ NO_COLOR: '1' }),
    reported: 'the packet lists inherited names and the constants it set, never a value',
  }),
  pre_start: Object.freeze({
    blocked: 'an unverified or ambiguous Road, no declared check, an unknown --check name, an unstable snapshot or a stale --if-snapshot block the whole run before any process starts',
    spawn_failed: 'a program that cannot be started (not found, not executable, an unsafe Windows batch argument) is the check result spawn_failed with its error code; the remaining checks still run',
    windows_batch: 'a .cmd or .bat target runs through cmd.exe /d /s /c only when every argument is plain ([A-Za-z0-9_@+=:,./\\-]); otherwise unsafe_batch_argument, never a quoting guess',
  }),
  result_record: Object.freeze({
    keys: Object.freeze(['name', 'argv', 'cwd', 'timeout_ms', 'status', 'exit_code', 'signal', 'duration_ms', 'termination', 'error', 'stdout', 'stderr']),
    statuses: Object.freeze(['not_run', 'passed', 'failed', 'timed_out', 'spawn_failed', 'interrupted']),
    passed: 'exactly: the process started, exited by itself with code 0 and was not terminated by the runner',
    persisted: 'no: an execution is never deduplicated, journaled or written; the packet is the record',
    mechanical: 'a result states what ran and how it ended; it never states acceptance, a Tester verdict or "verified"',
  }),
});

export const VERIFY_FINDING_CODES = Object.freeze({ failed: 'AKRS-R023', blocked: 'AKRS-R024', stale_snapshot: 'AKRS-C013' });
export const VERIFY_BLOCK_REASONS = Object.freeze(['road_ambiguous', 'road_unverified', 'no_checks', 'check_unknown', 'snapshot_unstable', 'stale_snapshot']);
export const VERIFY_RISK = 'verify --road executes the argv arrays declared in this repository\'s Road files with your permissions. Run it only on workflows you trust.';
export const VERIFY_NOTE = 'Mechanical verification: the declared commands, how each ended and what it printed. It is not a Tester verdict and says nothing about acceptance.';
