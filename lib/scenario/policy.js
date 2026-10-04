// F18 (run part, frozen in P2-W14): how `akrs test run` executes a Leader-declared scenario and what it keeps. One object, so
// the executor, the help text, the docs and the tests all read the same decisions.
const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
};

export const RUN_FINDING_CODES = Object.freeze({ refused: 'AKRS-T004', step: 'AKRS-T005' });
export const RUN_REFUSAL_REASONS = Object.freeze([
  'changed_during_run', 'holder_unresolved', 'interrupted', 'lease_corrupt', 'lease_lost', 'policy_not_live', 'scenario_invalid', 'scenario_missing', 'tester_blocked',
]);
export const RUN_BLOCK_REASONS = Object.freeze(['launch_failed', 'no_browser', 'ready_timeout', 'setup_failed']);
export const RUN_STEP_FINDING_REASONS = Object.freeze(['hard_step_failed', 'run_blocked', 'soft_step_failed', 'teardown_failed']);

export const RUN_POLICY = deepFreeze({
  command: '(decision) `test run <plan>` is a Tester command: an execution, never deduplicated (two runs make two run records) and never a verdict. It needs a ready Tester packet (the same blockers as test-details), policy live or measured and a non-empty scenario.',
  order: ['validate the contract scenario (before any process starts)', 'resolve the Tester holder', 'claim or refresh the Plan Tester lease', 'setup commands', 'launch the app', 'wait for readiness', 'scenario steps', 'stop the app tree', 'teardown commands', 'write the evidence and the run record under the repository lock'],
  lease: '(decision) `test run` is how the Tester lease is created: it claims the Plan lease for the holder (another holder blocks with AKRS-C012) and, in the same critical section that writes the run record, advances it to the Plan Tester projection measured at that moment. Evidence and run records are outside that projection, so a run never stales its own lease.',
  steps: {
    vocabulary: 'the closed set of the contract schema: goto, click, fill, press, wait_for, expect_text, expect_no_console_errors, http, screenshot, measure, viewport; nothing else runs and no JavaScript of the contract ever runs',
    soft: 'a failed step stops the run unless it is declared soft: true; the steps after a hard failure are skipped and say which step stopped the run',
    statuses: 'passed | failed | skipped; a step carries a mechanical detail, never a judgement',
    run_status: 'passed (no hard step failed and every step ran), failed (a hard step failed), blocked (the scenario could not run in full: setup, launch or readiness failed, or a browser step had no browser); a soft failure never makes a run failed',
    browser: 'browser steps share one page of one browser for the whole run; with no browser the browser steps are skipped, the run is blocked (AKRS-C018 names the search) and HTTP-only scenarios still run in full',
    http: 'built-in fetch, no redirects followed (a redirect is the answer), a loopback or allowed_hosts host only; the response body is read up to 1 MiB for expect_json',
    relative_urls: 'a URL that starts with / is resolved against launch.url',
    console: 'expect_no_console_errors looks at console errors, uncaught exceptions and Log errors since the last goto',
    measure: 'load and ttfb come from the navigation timing of the current page, lcp from a buffered PerformanceObserver read after 100 ms; a budget_ms makes the step fail when the value is over it or cannot be measured',
  },
  app: {
    launch: 'argv from the contract, no shell, own process group (POSIX) / tree kill (Windows), cwd the repository root, the F12 environment allow-list, output captured up to the F12 caps',
    ready: 'poll ready.url (default launch.url) every 100 ms until it answers ready.status (default: any HTTP answer) within ready.timeout_ms (default 30000); a process that exits first is launch_failed',
    stop: 'after the steps, always: SIGTERM then SIGKILL to the group (POSIX) / taskkill /T /F (Windows); the tree is gone before teardown commands run',
  },
  setup_teardown: 'setup and teardown commands run one after another through the F12 runner with the contract timeout; a failed setup command blocks the run (setup_failed) and nothing is launched; a failed teardown is a warning, the run keeps its status',
  evidence: {
    directory: 'verifications/<plan>/evidence/<run-id>/ (workflow-relative); the run id is the ULID of the operation',
    record: 'run.json in that directory: the akrs.run/v1 record, written last, so a directory without run.json is an interrupted write and never a run',
    files: 'screenshot steps: <name>.png; console: console.log; network: network.json; a11y: a11y.txt; timing: timing.json; log: app.log (the app output). Only the evidence types the contract lists are written; `file` is the Tester\'s own and is never written here',
    refs: '{ path, type, bytes, sha256 } measured by the CLI; no binary data ever sits inside a JSON document',
    caps: 'console.log and a11y.txt are cut at 64 KiB, network.json at 256 KiB, app.log keeps the F12 head and tail; a cut is stated in the file itself',
    write: '(decision) The F9 transaction policy says evidence is written by the Tester run, not by a transaction (planOperations refuses the evidence namespace), so the files are written under the repository lock after the recovery gate (journaled-mutation exception, dedupe none), each through a temp file and a rename, the record last; they are listed in `changed`.',
  },
  changed_during_run: 'the Plan Tester projection is measured before the run and again under the lock; a difference means the run tested a moving target: nothing is written and the packet says changed_during_run',
  interruption: 'SIGINT, SIGTERM or SIGHUP: the app tree and the browser are ended, the packet is an error with reason interrupted and nothing is written',
  verdict: 'a run is mechanical facts; `test result` (P2-W07) refuses a pass that contradicts a failed hard step of the run it references',
  untrusted: 'page text, console text and response bodies that reach a detail line are untrusted data and are cut at 200 characters',
});
