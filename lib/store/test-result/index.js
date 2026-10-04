// `test result <plan>` (P2-W07): append ONE structured Tester result bound to the exact tested snapshot and contract hash.
// Everything is judged under the repository lock inside `render`; the record is written through the transaction coordinator,
// journaled, and a retry is a noop. The Tester states what it observed; the CLI fills identity, run and evidence metadata and
// gates the verdict against the contract (judge.js).
import { createPacket } from '../../core/packet.js';
import { createDefaultProviders } from '../../core/providers.js';
import { compareStrings, isId } from '../../schemas/common.js';
import { RESULT_SCHEMA, RESULT_SPEC, validateResult } from '../../schemas/handoff-result.js';
import { findingsForSchemaIssues } from '../../schemas/index.js';
import { decodeJsonl, encodeJsonlRecord } from '../canonical/index.js';
import { inputRejection, resolveMissingDraft, runMutationFlow } from '../mutation-flow.js';
import { createPathService } from '../path-service.js';
import { readAuthoringInput } from '../roads/input.js';
import { sortedFindings } from '../roads/update.js';
import { workflowOption } from '../roads/repository.js';
import { TESTER_LEASE_PROJECTION, commandSnapshot, computeSnapshot } from '../snapshots/index.js';
import { buildTesterPacket } from '../test-details/index.js';
import { readRuns } from '../test-run/record.js';
import { sha256 } from '../transactions/files.js';
import { ChangeSetError, examine } from '../transactions/plan.js';
import { readContract, readResults } from '../verification/index.js';
import { resultsPath } from '../verification/paths.js';
import { judgeResult } from './judge.js';
import { TEST_RESULT_NEXT_COMMAND_BUILDERS } from './next-commands.js';
import { RESULT_FINDING_CODE } from './policy.js';

const COMMAND = 'test-result';
const PREVIEW_ID = '00000000000000000000000000';
const builder = TEST_RESULT_NEXT_COMMAND_BUILDERS['test-result'];

const guard = ({ plan, reason, subject = null, pointer = null, message, file = null }) => ({
  code: RESULT_FINDING_CODE, severity: 'error', message, file, line: null, detail: { plan, reason, subject, pointer },
});
const NEEDS_RUN = new Set(['run_missing', 'run_stale', 'run_required', 'lease_missing', 'lease_stale']);

const usageRejection = ({ root, providers, knownCommands, findings, next }) => ({
  outcome: 'rejected',
  packet: createPacket({
    command: COMMAND, requestId: null, status: 'error', root, snapshot: { before: null, after: null },
    data: { kind: 'usage', reason: 'invalid_input', schema: RESULT_SCHEMA, missing_inputs: [] }, findings, nextCommands: next, providers, knownCommands,
  }),
});

// The evidence of this Plan and nothing else: no `..`, no `.`, under <workflow>/verifications/<plan>/evidence/.
function evidenceIssues(document, prefix) {
  const issues = [];
  if (!Array.isArray(document.evidence)) return issues;
  document.evidence.forEach((entry, index) => {
    const path = entry?.path;
    if (typeof path !== 'string') return;
    const segments = path.split('/');
    if (!path.startsWith(prefix) || segments.includes('..') || segments.includes('.')) {
      issues.push({ path: `$.evidence[${index}].path`, code: 'invalid_value', message: `evidence of this Plan lives under ${prefix}` });
    }
  });
  return issues;
}

// options: { repositoryRoot, workflowRoot, key, channel?, flat?: { verdict, because }, env?, requestId?, dryRun?, again?, expectedSnapshot?,
//   providers?, knownCommands, boundary?, lockOptions?, rootArgs?, root? }
export async function appendResult(options) {
  const {
    repositoryRoot, workflowRoot, key, channel = null, flat = null, env = process.env, requestId, dryRun = false, again = false, expectedSnapshot,
    providers = createDefaultProviders(), knownCommands, boundary, lockOptions, rootArgs = [],
  } = options;
  if (!isId(key)) throw new TypeError('key must be a valid ID');
  if ((channel === null) === (flat === null)) throw new TypeError('appendResult needs exactly one of channel or flat');
  const root = options.root ?? repositoryRoot;
  const base = { repositoryRoot, workflowRoot };
  const flowBase = { command: COMMAND, repositoryRoot, workflowRoot, root, providers, knownCommands };
  const state = { phase: 'rejected' };
  const retry = () => builder({ phase: state.phase, plan: key, rootArgs });
  const service = await createPathService(base);
  const prefix = `${service.workflow_relative_path === '' ? '' : `${service.workflow_relative_path}/`}verifications/${key}/evidence/`;

  // the document the Tester wrote, or the flat form's skeleton; both are judged against the same closed schema
  let input = null;
  let document;
  if (channel !== null) {
    input = await readAuthoringInput({ ...base, channel });
    if (!input.ok) {
      if (input.missing && input.draft !== null && !dryRun) {
        const snapshotFor = async () => (await commandSnapshot(COMMAND, { ...base, target: { plan: key } })).snapshot;
        const replay = await resolveMissingDraft({ ...flowBase, target: { road: null, plan: key }, input, requestId, snapshotFor });
        if (replay !== null) return { outcome: 'replayed', packet: replay };
      }
      return inputRejection({ ...flowBase, schema: RESULT_SCHEMA, input, next: builder({ phase: 'template', plan: key, rootArgs }), requestId });
    }
    document = input.document;
  } else {
    document = {
      schema: RESULT_SCHEMA, verdict: flat.verdict, checks: [], measurements: [], evidence: [], findings: [],
      user_acceptance: { answer: flat.verdict === 'pass' ? 'yes' : 'no', because: flat.because },
    };
  }
  const issues = [...validateResult(document, { form: 'input', ...workflowOption(service) }).issues, ...(channel === null ? [] : evidenceIssues(document, prefix))];
  if (issues.length > 0) {
    return usageRejection({
      root, providers, knownCommands, findings: findingsForSchemaIssues(RESULT_SCHEMA, issues, { file: input?.file ?? null }), next: builder({ phase: 'template', plan: key, rootArgs }),
    });
  }
  const { verdict } = document;

  const render = async (context) => {
    const findings = [];
    const rejected = (extra = findings) => ({ rejection: { kind: 'findings', reason: 'proposal_rejected', status: 'blocked', findings: sortedFindings(extra) } });
    const refuse = (reason, message, subject = null, pointer = null) => findings.push(guard({ plan: key, reason, subject, pointer, message, file: input?.file ?? null }));
    state.phase = 'rejected';

    const detailed = await buildTesterPacket({ ...base, key, env, rootArgs });
    if (detailed.problem === 'unknown_plan') {
      refuse('unknown_plan', `${key} names no Plan and no Road without a Plan.`, key);
      return rejected();
    }
    const read = await readContract({ ...base, key });
    if (!read.exists) {
      refuse('contract_missing', `The Plan ${key} has no verification contract, so there is nothing to record a result against.`, key);
      return rejected();
    }
    if (read.meta_state !== 'declared') {
      refuse('contract_unverified', `The verification contract of ${key} does not verify (hand-edited or invalid).`, read.path ?? read.workflow_path);
      return rejected();
    }
    const { contract } = read;
    if (contract.policy === 'none') {
      refuse('policy_none', `The none policy of ${key} needs no Tester pass, so a result is not recorded.`, key);
      return rejected();
    }
    if (detailed.data.kind === 'test_details_blocked') {
      refuse('packet_blocked', `The Tester packet of ${key} cannot be pinned (${detailed.data.blockers.map(({ reason }) => reason).join(', ')}).`, key);
      return rejected();
    }
    const packet = detailed.data;
    const ledger = await readResults({ ...base, key });
    if (ledger.problem !== null) {
      refuse('ledger_unusable', `The results ledger ${ledger.path ?? ledger.workflow_path} cannot take a record (${ledger.problem}).`, key);
      return rejected();
    }

    const hash = contract.meta.content_hash;
    const runnable = ['live', 'measured'].includes(contract.policy) && contract.scenario.length > 0;
    const now = await computeSnapshot({ ...base, projections: TESTER_LEASE_PROJECTION, target: { plan: key } });
    const found = await readRuns({ ...base, key });
    const latest = found.runs[0] ?? null;
    const current = latest !== null && latest.record.snapshot === now.snapshot && latest.record.contract_hash === hash;
    const runRef = current ? latest.id : null;

    // the flat form takes the evidence of the referenced run, limited to what the contract declares
    const evidence = channel === null
      ? (current ? latest.record.evidence.filter(({ type }) => contract.evidence_types.includes(type)).map(({ path, type }) => ({ path, type })) : [])
      : document.evidence;
    const files = new Map();
    for (const entry of evidence) {
      let measured = null;
      try {
        const relative = entry.path.slice(entry.path.startsWith(`${service.workflow_relative_path}/`) ? service.workflow_relative_path.length + 1 : 0);
        const probe = await examine(workflowRoot, relative, 'evidence');
        if (probe.state.kind === 'file') measured = { bytes: probe.state.bytes.length, sha256: sha256(probe.state.bytes) };
      } catch (error) {
        if (!(error instanceof ChangeSetError)) throw error;
      }
      files.set(entry.path, measured);
    }
    const judged = judgeResult({
      verdict, document: { ...document, evidence }, contract,
      packet: { blocked: detailed.status === 'blocked', blockers: packet.blockers.map(({ reason }) => reason), checks: packet.checks, weak: packet.tester.run_required },
      runnable, lease: packet.lease, runs: { latest, current }, files,
    });
    for (const entry of judged) refuse(entry.reason, entry.message, entry.subject, entry.pointer);
    if (findings.length > 0) {
      if (judged.some(({ reason }) => NEEDS_RUN.has(reason))) state.phase = 'needs_run';
      return rejected();
    }

    const id = context.preview ? PREVIEW_ID : providers.runId();
    const record = {
      id, ts: providers.now(), plan: key, tested_snapshot: packet.tested_snapshot, contract_hash: hash, verdict,
      checks: document.checks, measurements: document.measurements,
      evidence: evidence.map(({ path, type }) => ({ path, type, ...files.get(path) })).sort((left, right) => compareStrings(left.path, right.path)),
      findings: document.findings, user_acceptance: document.user_acceptance, run: runRef,
    };
    const line = encodeJsonlRecord(record, RESULT_SPEC);
    const stored = decodeJsonl(line, () => RESULT_SPEC).records[0].value;
    const verdictOfSchema = validateResult(stored, { form: 'stored', ...workflowOption(service) });
    if (!verdictOfSchema.ok) throw new TypeError(`rendered result is invalid: ${JSON.stringify(verdictOfSchema.issues)}`);
    return {
      operations: [{ type: ledger.exists ? 'append' : 'create', path: resultsPath(key), content: line }],
      data: {
        kind: 'test_result',
        dry_run: false,
        plan: key,
        result: {
          id: context.preview ? null : id, path: ledger.path ?? `${service.workflow_relative_path === '' ? '' : `${service.workflow_relative_path}/`}${resultsPath(key)}`,
          line: ledger.records.length + 1, verdict, tested_snapshot: stored.tested_snapshot, contract_hash: hash, run: runRef, hash: context.preview ? null : stored.hash,
          counts: { checks: stored.checks.length, measurements: stored.measurements.length, evidence: stored.evidence.length, findings: stored.findings.length },
        },
      },
      nextCommands: builder({ phase: 'recorded', plan: key, rootArgs }),
      proposed: stored,
    };
  };

  return runMutationFlow({
    ...flowBase, target: { road: null, plan: key }, snapshotTarget: { plan: key },
    requestInput: channel === null ? { plan: key, verdict, because: flat.because } : { plan: key, ...document },
    requestId, dryRun, again, dedupe: 'append', expectedSnapshot, schema: RESULT_SCHEMA, input, channel, boundary, lockOptions, retryCommands: retry, render,
    replayNextCommands: builder({ phase: 'duplicate', plan: key, verdict, because: flat?.because, rootArgs }),
  });
}
