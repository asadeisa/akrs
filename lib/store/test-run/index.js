// `test run <plan>` (P2-W14): the Tester executes the Leader-declared scenario against the running product and gets mechanical
// facts plus evidence. The order is frozen in RUN_POLICY: everything is judged before a process starts; the execution holds no
// lock; the evidence and the run record are written under the repository lock, after the recovery gate, and only if the Plan
// is still what the run tested.
import { createPacket } from '../../core/packet.js';
import { createDefaultProviders } from '../../core/providers.js';
import { isId } from '../../schemas/common.js';
import { TEST_RUN_SCHEMA } from '../../schemas/test-run.js';
import { RUN_FINDING_CODES } from '../../scenario/policy.js';
import { executeScenario } from '../../scenario/run.js';
import { validateScenario } from '../../scenario/steps.js';
import { readExecutors } from '../executors/index.js';
import { runJournaledMutation } from '../journal/index.js';
import { claimLease, readLease, refreshLease, resolveHolder } from '../leases/index.js';
import { createPathService } from '../path-service.js';
import { TESTER_LEASE_PROJECTION } from '../snapshots/projections.js';
import { commandSnapshot, computeSnapshot } from '../snapshots/index.js';
import { buildTesterPacket } from '../test-details/index.js';
import { createTransactionRecovery } from '../transactions/index.js';
import { readContract } from '../verification/index.js';
import { TEST_RUN_NEXT_COMMAND_BUILDERS } from './next-commands.js';
import { writeRunFiles } from './record.js';

const COMMAND = 'test-run';
const builder = TEST_RUN_NEXT_COMMAND_BUILDERS['test-run'];
const finding = (code, severity, message, detail) => ({ code, severity, message, file: null, line: null, detail });
const basename = (path) => path.slice(path.lastIndexOf('/') + 1);

// options: { repositoryRoot, workflowRoot, key, executorFlag?, env?, signal?, providers?, packetProviders?, knownCommands, rootArgs?, root?, onFact?, deps?,
//   lockOptions?, boundary?, platform? }
// -> { problem: 'unknown_plan' } | { outcome, packet, ... }
export async function runTestScenario(options) {
  const {
    repositoryRoot, workflowRoot, key, executorFlag, env = process.env, signal = null, providers = createDefaultProviders(), knownCommands, rootArgs = [], onFact = null,
    deps = {}, lockOptions, boundary, platform = process.platform,
  } = options;
  const packetProviders = options.packetProviders ?? (() => providers);
  if (!isId(key)) throw new TypeError('key must be a valid ID');
  const root = options.root ?? repositoryRoot;
  const base = { repositoryRoot, workflowRoot };
  const snapshotRow = async () => (await commandSnapshot(COMMAND, { ...base, target: { plan: key } })).snapshot;
  const make = ({ status, data, findings = [], changed = [], next, snapshot, requestId = null }) => createPacket({
    command: COMMAND, requestId, status, root, snapshot: { before: snapshot, after: snapshot }, data, findings, changed, nextCommands: next, providers: packetProviders(), knownCommands,
  });
  const refused = async ({ reason, subject = null, message, status = 'blocked', choices = [], blockers = [], extraFindings = null, next = null }) => {
    const snapshot = await snapshotRow();
    const findings = extraFindings ?? [finding(RUN_FINDING_CODES.refused, 'error', message, { plan: key, reason, subject })];
    for (const entry of findings) onFact?.({ type: 'finding', finding: entry });
    return {
      outcome: 'rejected',
      packet: make({
        status, snapshot, findings,
        data: { kind: 'test_run_blocked', packet_version: TEST_RUN_SCHEMA, plan: key, reason, subject, choices, blockers },
        next: next ?? builder({ phase: 'inspect', plan: key, rootArgs }),
      }),
    };
  };

  // 1. the Tester packet must be ready: the same blockers as test-details, nothing partial
  const tester = await buildTesterPacket({ ...base, key, env, rootArgs });
  if (tester.problem === 'unknown_plan') return { problem: 'unknown_plan' };
  if (tester.status === 'blocked') {
    return refused({
      reason: 'tester_blocked', subject: tester.data.blockers[0]?.reason ?? null, message: `The Tester packet of ${key} is blocked, so nothing was run.`,
      blockers: tester.data.blockers.map(({ reason, subject }) => ({ reason, subject })), extraFindings: tester.findings,
    });
  }
  const read = await readContract({ ...base, key });
  const { contract } = read;

  // 2. the contract must have something to run, and all of it must be inside the closed vocabulary
  if (contract.policy !== 'live' && contract.policy !== 'measured') {
    return refused({ reason: 'policy_not_live', subject: contract.policy, message: `The ${contract.policy} policy of ${key} runs no scenario; only live and measured contracts do.` });
  }
  if (contract.scenario.length === 0) return refused({ reason: 'scenario_missing', message: `The contract of ${key} declares no scenario; the Leader adds one with test define.` });
  const scenario = validateScenario(contract.scenario, { allowedHosts: contract.allowed_hosts });
  if (!scenario.ok) return refused({ reason: 'scenario_invalid', subject: scenario.issues[0].path, message: `The scenario of ${key} is not valid at ${scenario.issues[0].path}: ${scenario.issues[0].message}.` });

  // 3. the Tester holder
  const executors = (await readExecutors(base)).executors;
  const resolved = resolveHolder({ flag: executorFlag, env, executors, role: 'tester' });
  if (resolved.status !== 'resolved') {
    return refused({
      reason: 'holder_unresolved', subject: resolved.supplied, choices: resolved.choices,
      message: resolved.choices.length === 0 ? 'No executor of role tester is declared, so the lease holder is unknown.' : `The Tester executor is not decided (${resolved.reason}); name one of: ${resolved.choices.join(', ')}.`,
      next: builder({ phase: 'choices', plan: key, choices: resolved.choices, rootArgs }),
    });
  }
  const holder = resolved.holder;

  // 4. claim or refresh the Plan Tester lease over the Plan projection as it is now
  const tested = await computeSnapshot({ ...base, projections: TESTER_LEASE_PROJECTION, target: { plan: key } });
  if (tested.status !== 'ok') {
    return refused({ reason: 'changed_during_run', message: `The workflow of ${key} was changing while it was measured; run it again when it is quiet.`, next: builder({ phase: 'retry', plan: key, executor: executorFlag, rootArgs }) });
  }
  const claim = await claimLease({ ...base, kind: 'plan', target: key, holder, snapshot: tested.snapshot, inventory: tested.inventory, providers, lockOptions });
  if (claim.status === 'blocked') {
    const result = await refused({ reason: 'lease_held', subject: claim.holder, message: claim.finding.message, extraFindings: [claim.finding], next: [] });
    return result;
  }
  if (claim.status === 'corrupt') return refused({ reason: 'lease_corrupt', subject: claim.reason, message: `The Tester lease of ${key} is unreadable (${claim.reason}); the Leader releases it.` });
  if (claim.status === 'lock_blocked') return { outcome: 'lock_blocked', packet: make({ status: 'blocked', snapshot: await snapshotRow(), data: { kind: 'test_run_blocked', packet_version: TEST_RUN_SCHEMA, plan: key, reason: 'lease_corrupt', subject: null, choices: [], blockers: [] }, findings: [claim.finding], next: builder({ phase: 'retry', plan: key, executor: executorFlag, rootArgs }) }) };
  const leaseAction = claim.status === 'claimed' || claim.status === 'taken_over' ? 'claimed' : 'refreshed';

  // 5. the execution: no lock is held
  const startedAt = providers.now();
  onFact?.({ type: 'started', plan: key, holder, policy: contract.policy, steps: contract.scenario.map((entry, index) => ({ index, step: entry.step })), timeout_ms: contract.timeout_ms });
  const executed = await executeScenario({ contract, repositoryRoot, env, platform, signal, onFact, deps });
  const endedAt = providers.now();
  if (executed.outcome === 'interrupted') {
    return refused({ reason: 'interrupted', status: 'error', message: `The run of ${key} was interrupted; the app and the browser were ended and nothing was written.`, next: builder({ phase: 'retry', plan: key, executor: executorFlag, rootArgs }) });
  }
  await deps.hooks?.beforeWrite?.();

  // 6. the evidence and the run record, under the repository lock
  const service = await createPathService(base);
  const recovery = createTransactionRecovery({ ...base, boundary });
  const done = await runJournaledMutation({
    ...base, root, command: COMMAND, target: { road: null, plan: key }, input: { plan: key }, dedupe: 'none', providers, knownCommands, lockOptions,
    currentSnapshot: snapshotRow, recover: recovery.recover, sweep: recovery.sweep,
    async apply(context) {
      const cannot = async (reason, message, subject = null, extra = {}) => make({
        status: 'blocked', snapshot: context.current_snapshot, requestId: context.request_id,
        data: { kind: 'test_run_blocked', packet_version: TEST_RUN_SCHEMA, plan: key, reason, subject, choices: [], blockers: [] },
        findings: extra.findings ?? [finding(RUN_FINDING_CODES.refused, 'error', message, { plan: key, reason, subject })], next: builder({ phase: 'retry', plan: key, executor: executorFlag, rootArgs }),
      });
      const after = await computeSnapshot({ ...base, projections: TESTER_LEASE_PROJECTION, target: { plan: key } });
      if (after.status !== 'ok' || after.snapshot !== tested.snapshot) {
        return cannot('changed_during_run', `The workflow of ${key} changed while the scenario was running, so the run tested a moving target and nothing was written.`);
      }
      const lease = await readLease({ ...base, kind: 'plan', target: key });
      if (lease.status !== 'held' || lease.lease.holder !== holder) {
        return cannot('lease_lost', `The Tester lease of ${key} is no longer held by ${holder}, so nothing was written.`, lease.status === 'held' ? lease.lease.holder : null);
      }
      const runId = context.request_id;
      const written = await writeRunFiles({
        service, plan: key, runId, artifacts: executed.artifacts,
        makeRecord: (refs) => ({
          id: runId, plan: key, snapshot: tested.snapshot, contractHash: contract.meta.content_hash, startedAt, endedAt, status: executed.outcome === 'interrupted' ? 'blocked' : executed.outcome,
          steps: executed.steps.map((entry) => ({ ...entry, evidence: refs.filter((ref) => executed.artifacts.some((candidate) => candidate.step === entry.index && candidate.name === basename(ref.path))) })),
          evidence: refs,
        }),
      });
      await refreshLease({ ...base, kind: 'plan', target: key, holder, snapshot: after.snapshot, inventory: after.inventory, requestId: runId, heldLock: context.lock, providers });
      const status = executed.outcome;
      const findings = [];
      const failedHard = executed.steps.find((entry) => entry.status === 'failed' && !entry.soft);
      if (failedHard !== undefined) findings.push(finding(RUN_FINDING_CODES.step, 'error', `Step ${failedHard.index} (${failedHard.step}) failed: ${failedHard.detail ?? 'no detail'}`, { plan: key, run: runId, reason: 'hard_step_failed', step: failedHard.index, name: failedHard.step }));
      for (const entry of executed.steps.filter((candidate) => candidate.status === 'failed' && candidate.soft)) {
        findings.push(finding(RUN_FINDING_CODES.step, 'warning', `Soft step ${entry.index} (${entry.step}) failed: ${entry.detail ?? 'no detail'}`, { plan: key, run: runId, reason: 'soft_step_failed', step: entry.index, name: entry.step }));
      }
      if (status === 'blocked') {
        findings.push(finding(RUN_FINDING_CODES.step, 'error', `The scenario could not run in full (${executed.block}): ${executed.message ?? executed.block}`, { plan: key, run: runId, reason: 'run_blocked', step: null, name: null }));
        if (executed.block === 'no_browser' && executed.browser_problem !== null) {
          findings.push(finding('AKRS-C018', 'error', `No browser could be used (${executed.browser_problem.reason}). ${executed.browser_problem.remediation}`, { reason: executed.browser_problem.reason, url: contract.launch.url }));
        }
      }
      for (const entry of executed.teardown.filter(({ status: commandStatus }) => commandStatus !== 'passed')) {
        findings.push(finding(RUN_FINDING_CODES.step, 'warning', `Teardown command ${entry.name} did not pass (${entry.status}).`, { plan: key, run: runId, reason: 'teardown_failed', step: null, name: entry.name }));
      }
      for (const entry of findings) onFact?.({ type: 'finding', finding: entry });
      let packetStatus = 'ok';
      if (status === 'failed') packetStatus = 'error';
      else if (status === 'blocked') packetStatus = 'blocked';
      else if (findings.length > 0) packetStatus = 'warning';
      const steps = written.record.steps;
      return make({
        status: packetStatus, snapshot: context.current_snapshot, requestId: runId, changed: written.changed, findings, next: builder({ phase: 'ran', plan: key, rootArgs }),
        data: {
          kind: 'test_run', packet_version: TEST_RUN_SCHEMA, plan: key, holder,
          run: { id: runId, path: written.record_path, status, started_at: startedAt, ended_at: endedAt, snapshot: tested.snapshot, contract_hash: contract.meta.content_hash, block: executed.block },
          steps, evidence: written.evidence,
          summary: executed.summary, lease: { holder, action: leaseAction }, app: executed.app, setup: executed.setup, teardown: executed.teardown, browser: executed.browser,
        },
      });
    },
  });
  return done;
}
