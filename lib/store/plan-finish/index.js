// `plan finish <plan>` (P2-W08): close a Plan only when the whole gate holds. One journaled transaction under the repository
// lock: the gate is evaluated again inside render, then the Plan file and the closure ledger are written together.
import { createPacket } from '../../core/packet.js';
import { createDefaultProviders } from '../../core/providers.js';
import { isId } from '../../schemas/common.js';
import { PLAN_SCHEMA, PLAN_SPEC, validatePlan } from '../../schemas/plan.js';
import { canonicalizeJson, parseStrictJson, storedSpec, withMeta } from '../canonical/index.js';
import { PREVIEW_CLOSURE_ID, validateLogProposal } from '../log/proposal.js';
import { runMutationFlow } from '../mutation-flow.js';
import { createPathService } from '../path-service.js';
import { GENERATOR } from '../roads/policy.js';
import { sortedFindings } from '../roads/update.js';
import { usageFinding } from '../roads/writers.js';
import { evaluatePlanGate } from './gate.js';
import { PLAN_FINISH_NEXT_COMMAND_BUILDERS } from './next-commands.js';
import { PLAN_FINISH_FINDING_CODE } from './policy.js';
import { planPath } from './repository.js';

const COMMAND = 'plan-finish';
const builder = PLAN_FINISH_NEXT_COMMAND_BUILDERS['plan-finish'];

const MESSAGES = {
  already_closed: (subject) => `The Plan ${subject} is already closed.`,
  evidence_changed: (subject) => `The evidence ${subject} no longer has the sha256 the passing result recorded.`,
  evidence_missing: (subject) => `The evidence ${subject} of the passing result is gone.`,
  evidence_type_missing: (subject) => `The passing result has no evidence of the declared type ${subject}.`,
  finding_open: (subject) => `The Tester finding ${subject} is still open.`,
  ledger_unusable: (subject) => `The results ledger ${subject} cannot be read.`,
  measurement_missing: (subject) => `The passing result lacks the declared measurement ${subject}.`,
  measurement_over_budget: (subject) => `The measurement ${subject} of the passing result is over its declared budget.`,
  no_roads: (subject) => `No Road declares the Plan ${subject}, so there is nothing to close.`,
  not_a_plan: (subject) => `${subject} is a Road, not a Plan; a Road is closed with road finish.`,
  plan_file_missing: (subject) => `The Plan ${subject} has no Plan file, so its closure has nowhere to be recorded.`,
  plan_unverified: (subject) => `The Plan file ${subject} does not verify (hand-edited or invalid).`,
  question_open: (subject) => `The Plan question ${subject} is still open.`,
  road_not_done: (subject) => `The Road ${subject} of the Plan is not DONE.`,
  road_unverified: (subject) => `The Road ${subject} of the Plan does not verify (hand-edited or invalid).`,
  run_failed: (subject) => `The run ${subject} the passing result references did not pass.`,
  run_missing: (subject) => `The run ${subject ?? '(none)'} the passing result references is not there.`,
  seam_owner_missing: (subject) => `The seam ${subject} is owned by a Road that does not exist.`,
  seam_owner_not_done: (subject) => `The seam ${subject} is owned by a Road that is not DONE.`,
  seam_unowned: (subject) => `The seam ${subject} has no owner.`,
  tester_failed: (subject) => `The latest Tester result ${subject} is a fail or blocked: the Plan is not proven.`,
  tester_missing: () => 'No Tester result exists for the current state of the Plan.',
  tester_stale: (subject) => `The Tester pass ${subject} is no longer current: the Plan, product or contract changed after it.`,
  tester_unverified: (subject) => `The Tester proof cannot be established (${subject ?? 'the contract or packet does not verify'}).`,
  unknown_plan: (subject) => `${subject} names no Plan.`,
};

export const gateFinding = (plan, { reason, subject }) => ({
  code: PLAN_FINISH_FINDING_CODE, severity: 'error', message: MESSAGES[reason](subject), file: null, line: null, detail: { plan, reason, subject },
});

function closedPlanText(plan, closure) {
  const { meta: _meta, ...rest } = plan;
  const stamped = withMeta({ ...rest, closure }, { schema: PLAN_SCHEMA, generator: GENERATOR, spec: PLAN_SPEC });
  const text = canonicalizeJson(stamped, storedSpec(PLAN_SPEC));
  const verdict = validatePlan(parseStrictJson(text).value, { form: 'stored' });
  if (!verdict.ok) throw new TypeError(`the closed Plan is invalid: ${JSON.stringify(verdict.issues)}`);
  return text;
}

// options: { repositoryRoot, workflowRoot, key, requestId?, dryRun?, expectedSnapshot?, providers?, knownCommands, rootArgs?, root?, env?, boundary?, lockOptions? }
// -> the journal outcome ({ outcome, packet, ... })
export async function finishPlan(options) {
  const {
    repositoryRoot, workflowRoot, key, requestId, dryRun = false, expectedSnapshot, providers = createDefaultProviders(), knownCommands, boundary,
    lockOptions, rootArgs = [], env = process.env,
  } = options;
  if (!isId(key)) throw new TypeError('key must be a valid ID');
  const root = options.root ?? repositoryRoot;
  const base = { repositoryRoot, workflowRoot };
  const schema = `akrs.command-input/${COMMAND}/v1`;
  const state = { phase: 'rejected' };
  const retry = () => builder({ phase: state.phase, plan: key, rootArgs });
  const flowBase = { command: COMMAND, repositoryRoot, workflowRoot, root, providers, knownCommands };

  if (!dryRun && expectedSnapshot === undefined) {
    return {
      outcome: 'rejected',
      packet: createPacket({
        ...flowBase, requestId: null, status: 'error', snapshot: { before: null, after: null },
        data: { kind: 'usage', reason: 'invalid_input', schema, missing_inputs: ['--if-snapshot'] },
        findings: [usageFinding('plan finish closes the Plan, so it needs --if-snapshot <snapshot> (plan finish --dry-run names it and lists every blocker)')],
        nextCommands: retry(),
      }),
    };
  }

  const render = async (context) => {
    state.phase = 'rejected';
    const refusal = (blockers, reason = 'proposal_rejected') => {
      state.phase = 'blocked';
      return {
        rejection: {
          kind: 'findings', reason, status: 'blocked', findings: sortedFindings(blockers.map((entry) => gateFinding(key, entry))),
          extra: { blockers: blockers.map(({ reason: why, subject }) => ({ reason: why, subject })) },
        },
      };
    };
    const gate = await evaluatePlanGate({ ...base, key, env, rootArgs });
    if (gate.problem !== undefined) return refusal([{ reason: gate.problem, subject: key }]);
    if (gate.blockers.length > 0) return refusal(gate.blockers);

    const service = await createPathService(base);
    const prefix = service.workflow_relative_path === '' ? '' : `${service.workflow_relative_path}/`;
    const at = providers.now();
    const operation = {
      request: context.preview ? PREVIEW_CLOSURE_ID : context.request_id,
      run: context.preview ? PREVIEW_CLOSURE_ID : providers.runId(),
    };
    const proposal = await validateLogProposal({
      ...base, document: { kind: 'plan', subject: key, outcome: 'DONE', deviations: null }, operation,
      newId: () => (context.preview ? PREVIEW_CLOSURE_ID : providers.runId()), now: () => at,
    });
    if (!proposal.ok) return { rejection: { kind: 'findings', reason: 'proposal_rejected', status: 'blocked', findings: proposal.findings } };
    const closure = { status: 'closed', at, operation };
    return {
      operations: [{ type: 'replace', path: planPath(key), content: closedPlanText(gate.plan, closure) }, proposal.operation],
      data: {
        kind: 'plan_finish',
        dry_run: false,
        plan: { id: key, path: `${prefix}${planPath(key)}`, from: 'open', to: 'closed', at },
        gate: { tester: gate.tester, blockers: [] },
        closure: { action: 'appended', id: context.preview ? null : proposal.record.id, segment: proposal.segment.path, operation },
      },
      nextCommands: context.preview ? builder({ phase: 'ready', plan: key, snapshot: context.current_snapshot, rootArgs }) : builder({ phase: 'done', rootArgs }),
      proposed: closure,
    };
  };

  return runMutationFlow({
    ...flowBase, target: { road: null, plan: key }, snapshotTarget: { plan: key }, requestInput: { plan: key }, requestId, dryRun, expectedSnapshot,
    schema, boundary, lockOptions, retryCommands: retry, render,
  });
}
