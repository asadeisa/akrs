// The core of `verify --road`: resolve the declared checks of one verified Road by identity, run them one after the other
// through the F12 runner and return one final result. It writes nothing (an execution is never journaled or replayed) and
// never accepts a command from the caller; the only input that reaches a process is an argv array stored in the Road.
//
// verifyRoad(options) -> { problem } | { status, data, findings, nextCommands, snapshot: { before, after } }
//   options: { repositoryRoot, workflowRoot, id, check?, dryRun?, ifSnapshot?, env?, platform?, clock?, signal?, graceMs?, rootArgs? }
import { isId } from '../../schemas/common.js';
import { commandSnapshot } from '../snapshots/index.js';
import { RoadStoreError, listRoadFiles, readRoadAt } from '../roads/repository.js';
import { F12_POLICY, VERIFY_FINDING_CODES, VERIFY_NOTE, VERIFY_RISK } from './policy.js';
import { VERIFY_NEXT_COMMAND_BUILDERS } from './next-commands.js';
import { allowListedEnvironment, runCheck } from './runner.js';

const builder = VERIFY_NEXT_COMMAND_BUILDERS.verify;
const LIMITS = Object.freeze({
  stream_cap_bytes: F12_POLICY.capture.stream_cap_bytes,
  head_bytes: F12_POLICY.capture.head_bytes,
  tail_bytes: F12_POLICY.capture.tail_bytes,
  grace_ms: F12_POLICY.termination.grace_ms,
  wait_after_kill_ms: F12_POLICY.termination.wait_after_kill_ms,
});

const blockedFinding = (road, reason, message, subject = null) => ({
  code: VERIFY_FINDING_CODES.blocked, severity: 'error', message, file: null, line: null, detail: { road, reason, subject },
});

function blocked({ id, reason, subject = null, message, rootArgs, snapshot = null, finding = null }) {
  return {
    status: 'blocked',
    data: { kind: 'verify_road_blocked', mode: 'mechanical', road: id, reason, subject, note: VERIFY_NOTE, risk: VERIFY_RISK },
    findings: [finding ?? blockedFinding(id, reason, message, subject)],
    nextCommands: builder({ phase: reason === 'stale_snapshot' ? 'stale' : 'blocked', id, rootArgs }),
    snapshot: { before: snapshot, after: snapshot },
  };
}

const notRun = (check) => ({
  name: check.name, argv: [...check.argv], cwd: '.', timeout_ms: check.timeout_ms, status: 'not_run',
  exit_code: null, signal: null, duration_ms: null, termination: null, error: null, stdout: null, stderr: null,
});

function summarize(declared, checks) {
  const count = (status) => checks.filter((entry) => entry.status === status).length;
  return {
    declared, selected: checks.length, passed: count('passed'), failed: count('failed'), timed_out: count('timed_out'),
    spawn_failed: count('spawn_failed'), interrupted: count('interrupted'), not_run: count('not_run'),
  };
}

export async function verifyRoad(options) {
  const {
    repositoryRoot, workflowRoot, id, check = null, dryRun = false, ifSnapshot = null, env = process.env, platform = process.platform,
    clock, signal = null, graceMs, rootArgs = [],
  } = options;
  if (!isId(id)) throw new TypeError('id must be a valid ID');
  const base = { repositoryRoot, workflowRoot };
  const files = (await listRoadFiles(base)).filter((file) => file.id === id);
  if (files.length === 0) return { problem: 'road_missing' };
  if (files.length > 1) {
    const subject = files.map(({ path }) => path).join(', ');
    return blocked({ id, reason: 'road_ambiguous', subject, message: `Road ${id} exists in more than one file: ${subject}.`, rootArgs });
  }
  let found;
  try {
    found = await readRoadAt({ ...base, path: files[0].path, id });
  } catch (error) {
    if (!(error instanceof RoadStoreError)) throw error;
    return blocked({ id, reason: 'road_unverified', subject: files[0].path, message: `${files[0].path} cannot be read as a Road: ${error.message}`, rootArgs });
  }
  if (found.issues.length > 0 || found.meta_state !== 'declared') {
    return blocked({
      id, reason: 'road_unverified', subject: found.path, rootArgs,
      message: found.issues.length > 0
        ? `${found.path} does not satisfy its closed schema: ${found.issues[0].path} ${found.issues[0].message}. Nothing was run.`
        : `${found.path} no longer matches its recorded content hash: it was edited outside the CLI. Nothing was run.`,
    });
  }
  const { road } = found;
  if (road.checks.length === 0) return blocked({ id, reason: 'no_checks', message: `Road ${id} declares no check, so there is nothing to run.`, rootArgs });
  const selected = check === null ? road.checks : road.checks.filter((entry) => entry.name === check);
  if (selected.length === 0) {
    return blocked({ id, reason: 'check_unknown', subject: check, message: `Road ${id} declares no check named ${JSON.stringify(check)}; only declared checks can run.`, rootArgs });
  }

  const before = await commandSnapshot('verify', { ...base, target: { road: id } });
  if (before.status !== 'ok') return blocked({ id, reason: 'snapshot_unstable', message: 'The workflow changed while the snapshot was read; ask again.', rootArgs });
  if (ifSnapshot !== null && ifSnapshot !== before.snapshot) {
    return blocked({
      id, reason: 'stale_snapshot', rootArgs, snapshot: before.snapshot,
      message: 'The expected snapshot no longer matches the workflow; nothing was run. Read the Road again and retry.',
      finding: {
        code: VERIFY_FINDING_CODES.stale_snapshot, severity: 'error', file: null, line: null,
        message: 'The expected snapshot no longer matches the workflow; nothing was run. Read the Road again and retry.',
        detail: { source: 'explicit', expected: ifSnapshot, current: before.snapshot, delta: null },
      },
    });
  }

  const environment = allowListedEnvironment(env, platform);
  const records = [];
  const findings = [];
  let interrupted = false;
  for (const entry of selected) {
    if (dryRun || interrupted) {
      records.push(notRun(entry));
      continue;
    }
    const result = await runCheck({ argv: entry.argv, cwd: repositoryRoot, timeoutMs: entry.timeout_ms, env, platform, clock, graceMs, signal });
    records.push({ name: entry.name, argv: [...entry.argv], cwd: '.', timeout_ms: entry.timeout_ms, ...result });
    if (result.status === 'interrupted') interrupted = true;
    if (result.status !== 'passed') {
      findings.push({
        code: VERIFY_FINDING_CODES.failed, severity: 'error', file: null, line: null,
        message: `The declared check ${JSON.stringify(entry.name)} of ${id} did not pass: ${result.status}${result.exit_code === null ? '' : ` (exit ${result.exit_code})`}.`,
        detail: { road: id, check: entry.name, status: result.status, exit_code: result.exit_code, signal: result.signal },
      });
    }
  }
  const after = dryRun ? before : await commandSnapshot('verify', { ...base, target: { road: id } });
  const summary = summarize(road.checks.length, records);
  let outcome = 'passed';
  if (dryRun) outcome = 'dry_run';
  else if (interrupted) outcome = 'interrupted';
  else if (findings.length > 0) outcome = 'failed';
  const phase = { passed: 'passed', dry_run: 'dry_run', failed: 'failed', interrupted: 'failed' }[outcome];
  return {
    status: findings.length > 0 ? 'error' : 'ok',
    data: {
      kind: 'verify_road',
      mode: 'mechanical',
      road: { id, status: road.status, contract: 'declared' },
      dry_run: dryRun,
      outcome,
      note: VERIFY_NOTE,
      risk: VERIFY_RISK,
      limits: { ...LIMITS },
      env: { inherited: environment.inherited, set: { ...F12_POLICY.environment.set } },
      summary,
      checks: records,
    },
    findings,
    nextCommands: builder({ phase, id, rootArgs }),
    snapshot: { before: before.snapshot, after: after.status === 'ok' ? after.snapshot : before.snapshot },
  };
}
