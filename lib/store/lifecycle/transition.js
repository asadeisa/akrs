// The lifecycle writers: `road activate`, `road finish` and `road reopen`. Each is one journaled transaction under the
// repository lock that changes the Road's status (and, for finish, appends the closure); the preconditions are judged
// under the lock against the current state. finish gathers its mechanical evidence (declared checks and the audit) BEFORE
// the lock, because an execution never holds it, and refuses on anything that is not clean.
import { createPacket } from '../../core/packet.js';
import { createDefaultProviders } from '../../core/providers.js';
import { compareStrings, isId } from '../../schemas/common.js';
import { auditRoad } from '../git/index.js';
import { runMutationFlow } from '../mutation-flow.js';
import { readLease, releaseLease } from '../leases/index.js';
import { PREVIEW_CLOSURE_ID, validateLogDocument, validateLogProposal } from '../log/proposal.js';
import { readLog } from '../log/repository.js';
import { createPathService } from '../path-service.js';
import { buildUpdatedRoad, updateFormOf } from '../roads/update.js';
import { RoadStoreError, listRoadFiles, readRoadAt, renderRoad, workflowOption } from '../roads/repository.js';
import { usageFinding } from '../roads/writers.js';
import { readScope } from '../scope/repository.js';
import { commandSnapshot } from '../snapshots/index.js';
import { verifyRoad } from '../verify/index.js';
import { blockerFindings, lifecycleFinding, readReadiness } from './check.js';
import { LIFECYCLE_NEXT_COMMAND_BUILDERS } from './next-commands.js';
import { LIFECYCLE_TRANSITIONS } from './policy.js';

const ZERO_SUMMARY = Object.freeze({ declared: 0, selected: 0, passed: 0, failed: 0, timed_out: 0, spawn_failed: 0, interrupted: 0, not_run: 0 });
const refusal = (findings, status = 'error', reason = 'proposal_rejected', extra = {}) => ({ rejection: { kind: 'findings', reason, findings, status, extra } });

// Every change the audit sees, once, with its category, in path order.
function changedFiles(audit) {
  if (audit.categories === null) return [];
  const seen = new Map();
  for (const [category, entries] of Object.entries(audit.categories)) {
    if (category === 'missing_declared') continue;
    // the CLI's own scratch (.ops, .cache) is not a change of the Road
    if (category === 'workflow_cache') continue;
    for (const entry of entries) if (!seen.has(entry.path)) seen.set(entry.path, { path: entry.path, category });
  }
  return [...seen.values()].sort((left, right) => compareStrings(left.path, right.path));
}

// Runs the declared checks and the audit once, outside the lock. -> { verify, audit } (verify may be { problem }).
async function gatherEvidence({ repositoryRoot, workflowRoot, id, preExisting, env, signal, clock, rootArgs }) {
  const base = { repositoryRoot, workflowRoot };
  const verify = await verifyRoad({ ...base, id, env, signal, clock, rootArgs });
  const audit = await auditRoad({ ...base, road: id, preExisting });
  return { verify, audit };
}

async function readOne({ repositoryRoot, workflowRoot, id }) {
  const files = (await listRoadFiles({ repositoryRoot, workflowRoot })).filter((file) => file.id === id);
  if (files.length === 0) return { problem: 'road_missing' };
  if (files.length > 1) return { problem: 'road_ambiguous', subject: files.map(({ path }) => path).join(', ') };
  try {
    const found = await readRoadAt({ repositoryRoot, workflowRoot, path: files[0].path, id });
    if (found.issues.length > 0 || found.meta_state !== 'declared') return { problem: 'road_unverified', subject: found.path };
    return { found };
  } catch (error) {
    if (!(error instanceof RoadStoreError)) throw error;
    return { problem: 'road_unverified', subject: files[0].path };
  }
}

// options: { repositoryRoot, workflowRoot, command, id, deviations?, preExisting?, requestId?, dryRun?, expectedSnapshot?,
//   providers?, knownCommands, rootArgs?, root?, boundary?, lockOptions?, env?, signal?, clock? }
// -> the journal outcome ({ outcome, packet, ... }): committed | replayed | dry_run | rejected | stale | conflict | lock_blocked | ...
export async function transitionRoad(options) {
  const {
    repositoryRoot, workflowRoot, command, id, deviations = null, preExisting = [], requestId, dryRun = false, expectedSnapshot,
    providers = createDefaultProviders(), knownCommands, boundary, lockOptions, rootArgs = [], env = process.env, signal = null, clock,
  } = options;
  const row = LIFECYCLE_TRANSITIONS[command];
  if (row === undefined) throw new TypeError(`unknown lifecycle command: ${String(command)}`);
  if (!isId(id)) throw new TypeError('id must be a valid ID');
  const root = options.root ?? repositoryRoot;
  const base = { repositoryRoot, workflowRoot };
  const builder = LIFECYCLE_NEXT_COMMAND_BUILDERS[command];
  const schema = `akrs.command-input/${command}/v1`;
  const retry = () => builder({ phase: 'rejected', id, rootArgs });
  const flowBase = { command, repositoryRoot, workflowRoot, root, providers, knownCommands };
  const fail = (message) => ({
    outcome: 'rejected',
    packet: createPacket({
      command, requestId: null, status: 'error', root, snapshot: { before: null, after: null },
      data: { kind: 'usage', reason: 'invalid_input', schema, missing_inputs: [] }, findings: [usageFinding(message)], nextCommands: retry(), providers, knownCommands,
    }),
  });

  if (!dryRun && expectedSnapshot === undefined) {
    return fail(`road ${row.verb} changes the lifecycle, so it needs --if-snapshot <snapshot> (the snapshot the Road had when you read it; road check names it)`);
  }
  if (command === 'road-finish' && deviations !== null) {
    const verdict = validateLogDocument({ kind: 'road', subject: id, outcome: 'DONE', deviations });
    if (!verdict.ok) return fail(`--deviations: ${verdict.issues[0].message}`);
  }

  // finish: the mechanical evidence, once, before the lock and only for a Road finish could accept
  let evidence = null;
  if (command === 'road-finish' && !dryRun) {
    const peek = await readOne({ ...base, id });
    // a stale request is refused under the lock anyway: do not run the checks for it
    const stale = expectedSnapshot !== undefined && (await commandSnapshot(command, { ...base, target: { road: id } })).snapshot !== expectedSnapshot;
    if (!stale && peek.found !== undefined && row.from.includes(peek.found.road.status)) {
      evidence = await gatherEvidence({ ...base, id, preExisting, env, signal, clock, rootArgs });
    }
  }

  const state = { lock: null, lease: null };
  const render = async (context) => {
    state.lock = context.lock ?? null;
    const loaded = await readOne({ ...base, id });
    if (loaded.problem !== undefined) {
      const reason = loaded.problem;
      return refusal([lifecycleFinding({
        road: id, transition: row.verb, reason, subject: loaded.subject ?? null,
        message: reason === 'road_missing' ? `No Road ${id} exists.` : (reason === 'road_ambiguous' ? `Road ${id} exists in more than one file: ${loaded.subject}.` : `The Road file ${loaded.subject} does not verify (hand-edited or invalid), so it is not changed.`),
      })]);
    }
    const { found } = loaded;
    const from = found.road.status;
    if (!row.from.includes(from)) {
      return refusal([lifecycleFinding({
        road: id, transition: row.verb, reason: 'illegal_transition', subject: from,
        message: `Road ${id} is ${from}; road ${row.verb} only applies to a ${row.from.join(' or ')} Road.`,
      })]);
    }

    const data = {
      kind: 'road_lifecycle', transition: row.verb, dry_run: false, road: { id, plan: found.road.plan, from, to: row.to, path: found.path },
      readiness: null, checks: null, audit: null, changed_files: [], closure: null, lease: null,
    };
    const warnings = [];
    const operations = [];

    if (command === 'road-activate') {
      const readiness = await readReadiness({ ...base, id, env, rootArgs });
      if (readiness.blockers.length > 0) {
        return refusal(blockerFindings(id, row.verb, readiness.blockers), 'blocked', 'not_ready', { readiness: { ready: false, blockers: readiness.blockers } });
      }
      data.readiness = { ready: true, blockers: [] };
    }

    if (command === 'road-finish') {
      const scope = await readScope({ ...base, road: id });
      const pending = scope.requests.filter(({ state: requestState, blocking }) => requestState === 'pending' && blocking === true);
      const problems = pending.map((request) => lifecycleFinding({
        road: id, transition: row.verb, reason: 'scope_request_pending', subject: request.id, message: `The blocking scope request ${request.id} is still pending; the Leader decides it first.`,
      }));
      if (evidence === null && !context.preview) {
        // the Road became finishable between the evidence step and the lock: nothing was verified, so nothing is finished
        return refusal([lifecycleFinding({
          road: id, transition: row.verb, reason: 'snapshot_unstable', subject: null,
          message: `Road ${id} changed while finish was preparing; no declared check ran against its current state. Run road finish again.`,
        })], 'blocked');
      }
      if (evidence === null) {
        data.checks = null;
      } else {
        const { verify, audit } = evidence;
        if (verify.status === 'blocked' && verify.data.reason !== 'no_checks') {
          return refusal([lifecycleFinding({
            road: id, transition: row.verb, reason: verify.data.reason === 'stale_snapshot' ? 'snapshot_unstable' : verify.data.reason, subject: verify.data.subject, message: verify.findings[0].message,
          })], 'blocked');
        }
        data.checks = verify.status === 'blocked' ? { ...ZERO_SUMMARY } : { ...verify.data.summary };
        if (verify.status !== 'blocked' && verify.data.outcome !== 'passed') {
          problems.push(lifecycleFinding({
            road: id, transition: row.verb, reason: 'checks_not_passed', subject: verify.data.checks.filter(({ status }) => status !== 'passed').map(({ name }) => name).join(', '),
            message: `The declared checks of ${id} did not all pass (${verify.data.summary.passed} of ${verify.data.summary.selected}); a Road is not finished on a failed check.`,
          }), ...verify.findings);
        }
        if (audit.problem === undefined) {
          data.audit = { status: audit.audit.status, reason: audit.audit.reason, posture: audit.audit.posture, counts: audit.audit.counts };
          data.changed_files = changedFiles(audit.audit);
          for (const entry of audit.audit.categories?.undeclared ?? []) {
            problems.push(lifecycleFinding({
              road: id, transition: row.verb, reason: 'undeclared_change', subject: entry.path,
              message: `${entry.path} changed but the Road ${entry.forbidden ? 'forbids' : 'does not declare'} it; finish refuses an undeclared product change.`,
            }));
          }
          warnings.push(...audit.findings.filter(({ code }) => code !== 'AKRS-G001'));
        }
      }
      if (problems.length > 0) return refusal(problems, 'blocked', 'proposal_rejected', { road: data.road, checks: data.checks, audit: data.audit, changed_files: data.changed_files });

      const ledger = await readLog(base);
      const recorded = ledger.records.find((record) => record.kind === 'road' && record.subject === id && record.outcome === 'DONE');
      if (recorded !== undefined) {
        data.closure = { action: 'already_recorded', id: recorded.id, segment: recorded.path };
      } else {
        const proposal = await validateLogProposal({
          ...base, document: { kind: 'road', subject: id, outcome: 'DONE', deviations },
          newId: () => (context.preview ? PREVIEW_CLOSURE_ID : providers.runId()), now: () => providers.now(),
        });
        if (!proposal.ok) return refusal(proposal.findings);
        operations.push(proposal.operation);
        data.closure = { action: 'appended', id: context.preview ? null : proposal.record.id, segment: proposal.segment.path };
      }
    }

    const leaseRead = row.releases_lease ? await readLease({ ...base, kind: 'road', target: id }) : { status: 'none' };
    data.lease = row.releases_lease ? { holder: leaseRead.status === 'held' ? leaseRead.lease.holder : null, released: leaseRead.status === 'held' } : null;
    state.lease = data.lease;

    const service = await createPathService(base);
    const prefix = service.workflow_relative_path === '' ? '' : `${service.workflow_relative_path}/`;
    const stored = buildUpdatedRoad({ ...updateFormOf(found.road), status: row.to }, workflowOption(service));
    operations.unshift({ type: 'replace', path: found.path.slice(prefix.length), content: renderRoad(stored, workflowOption(service)) });
    return {
      operations,
      status: warnings.length > 0 ? 'warning' : 'ok',
      data,
      findings: warnings,
      nextCommands: builder({ phase: 'done', id, rootArgs }),
      proposed: stored,
    };
  };

  const afterCommit = async () => {
    if (!row.releases_lease || state.lease === null || !state.lease.released || state.lock === null) return;
    await releaseLease({ ...base, kind: 'road', target: id, leader: true, heldLock: state.lock, providers });
  };

  return runMutationFlow({
    ...flowBase, target: { road: id, plan: null }, snapshotTarget: { road: id }, requestInput: { id, transition: row.verb, deviations, pre_existing: [...preExisting].sort(compareStrings) },
    requestId, dryRun, expectedSnapshot, schema, boundary, lockOptions, retryCommands: retry, render, afterCommit,
  });
}
