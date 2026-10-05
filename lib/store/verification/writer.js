// The Tester source writers: `test define` (create or replace the Plan verification contract) and `test handoff`
// (append a Worker baton). Both judge the full proposed state under the repository lock and write through the
// transaction coordinator, like every workflow mutation.
import { createPacket } from '../../core/packet.js';
import { createDefaultProviders } from '../../core/providers.js';
import { isId } from '../../schemas/common.js';
import { HANDOFF_SCHEMA, HANDOFF_SPEC, validateHandoff } from '../../schemas/handoff-result.js';
import { findingsForSchemaIssues } from '../../schemas/index.js';
import { VERIFICATION_SCHEMA, VERIFICATION_SPEC, validateVerification } from '../../schemas/verification.js';
import { canonicalizeJson, decodeJsonl, encodeJsonlRecord, parseStrictJson, storedSpec, withMeta } from '../canonical/index.js';
import { inputRejection, resolveMissingDraft, runMutationFlow } from '../mutation-flow.js';
import { createPathService } from '../path-service.js';
import { readAuthoringInput } from '../roads/input.js';
import { GENERATOR } from '../roads/policy.js';
import { readWindowFindingsOf } from '../roads/read-findings.js';
import { workflowOption } from '../roads/repository.js';
import { sortedFindings } from '../roads/update.js';
import { readScope } from '../scope/repository.js';
import { commandSnapshot } from '../snapshots/index.js';
import { contractPath, handoffPath } from './paths.js';
import { TESTER_GUARD_CODE } from './policy.js';
import { VERIFICATION_NEXT_COMMAND_BUILDERS } from './next-commands.js';
import { readContract, readHandoffs, readRoadPlans } from './repository.js';

const PREVIEW_ID = '00000000000000000000000000';

export function testerGuard({ reason, subject, message, pointer = null, expected = null, actual = null, file = null }) {
  return { code: TESTER_GUARD_CODE, severity: 'error', message, file, line: null, detail: { reason, subject, pointer, expected, actual } };
}

const usageRejection = ({ command, root, providers, knownCommands, schema, findings, next }) => ({
  outcome: 'rejected',
  packet: createPacket({
    command, requestId: null, status: 'error', root, snapshot: { before: null, after: null },
    data: { kind: 'usage', reason: 'invalid_input', schema, missing_inputs: [] }, findings, nextCommands: next, providers, knownCommands,
  }),
});

// ---- test define ---------------------------------------------------------------------------------------------------
// The tier of a key: { tier: 'plan' | 'road', roads: [{ id, plan, ... }] } or null when it names nothing.
async function identityOf({ repositoryRoot, workflowRoot, key }) {
  const roads = await readRoadPlans({ repositoryRoot, workflowRoot });
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const planFile = await service.resolveWorkflowPath(`plans/${key}.json`);
  const planned = roads.filter((road) => road.plan === key);
  if (planFile.exists || planned.length > 0) return { tier: 'plan', roads: planned, all: roads };
  const own = roads.find((road) => road.id === key && road.plan === null);
  if (own !== undefined) return { tier: 'road', roads: [own], all: roads };
  return null;
}

export function buildStoredVerification(document, { generator = GENERATOR, workflowRoot } = {}) {
  const verdict = validateVerification(document, { form: 'input', ...(workflowRoot === undefined ? {} : { workflowRoot }) });
  if (!verdict.ok) throw new TypeError(`verification input is invalid: ${verdict.issues.map(({ path, message }) => `${path} ${message}`).join('; ')}`);
  const ordered = Object.fromEntries(VERIFICATION_SPEC.keys.map((name) => [name, document[name]]));
  const stamped = withMeta(ordered, { schema: document.schema, generator, spec: VERIFICATION_SPEC });
  const text = canonicalizeJson(stamped, storedSpec(VERIFICATION_SPEC));
  return { stored: parseStrictJson(text).value, text };
}

// options: { repositoryRoot, workflowRoot, key, channel, requestId?, dryRun?, expectedSnapshot?, providers?, knownCommands, rootArgs?, ... }
export async function defineVerification(options) {
  const {
    repositoryRoot, workflowRoot, key, channel, requestId, dryRun = false, expectedSnapshot, providers = createDefaultProviders(),
    knownCommands, boundary, lockOptions, rootArgs = [],
  } = options;
  const root = options.root ?? repositoryRoot;
  const command = 'test-define';
  const builder = VERIFICATION_NEXT_COMMAND_BUILDERS[command];
  const target = { road: null, plan: key };
  const flowBase = { command, repositoryRoot, workflowRoot, root, providers, knownCommands };
  const retry = (file) => () => builder({ phase: 'rejected', plan: key, file: file ?? null, rootArgs });
  const snapshotFor = async () => (await commandSnapshot(command, { repositoryRoot, workflowRoot, target: { plan: key } })).snapshot;

  const input = await readAuthoringInput({ repositoryRoot, workflowRoot, channel });
  if (!input.ok) {
    if (input.missing && input.draft !== null && !dryRun) {
      const replay = await resolveMissingDraft({ ...flowBase, target, input, requestId, snapshotFor });
      if (replay !== null) return { outcome: 'replayed', packet: replay };
    }
    return inputRejection({ ...flowBase, schema: VERIFICATION_SCHEMA, input, next: retry(null)(), requestId });
  }
  const { document } = input;
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const issues = validateVerification(document, { form: 'input', ...workflowOption(service) }).issues;
  if (issues.length > 0) {
    return usageRejection({ ...flowBase, schema: VERIFICATION_SCHEMA, findings: findingsForSchemaIssues(VERIFICATION_SCHEMA, issues, { file: input.file }), next: retry(input.file)() });
  }
  if (document.plan !== key) {
    return usageRejection({
      ...flowBase, schema: VERIFICATION_SCHEMA, next: retry(input.file)(),
      findings: [{ code: 'AKRS-C001', severity: 'error', message: `The document is for plan "${document.plan}" but the command names "${key}".`, file: input.file, line: null, detail: { reason: 'plan_mismatch' } }],
    });
  }

  const render = async () => {
    const findings = [];
    const guard = (args) => findings.push(testerGuard({ ...args, file: input.file }));
    const identity = await identityOf({ repositoryRoot, workflowRoot, key });
    if (identity === null) {
      guard({ reason: 'unknown_plan', subject: key, pointer: '/plan', message: `"${key}" names no Plan and no Road without a Plan, so there is nothing to verify (at /plan).` });
    } else {
      const known = new Map(identity.all.map((road) => [road.id, road]));
      document.roads.forEach((id, index) => {
        const road = known.get(id);
        const pointer = `/roads/${index}`;
        if (road === undefined) guard({ reason: 'road_missing', subject: id, pointer, message: `The applicable Road ${id} does not exist (at ${pointer}).` });
        else if (identity.tier === 'plan' ? road.plan !== key : id !== key) {
          guard({ reason: 'road_wrong_plan', subject: id, pointer, expected: key, actual: road.plan, message: `The Road ${id} does not belong to ${key} (at ${pointer}).` });
        } else if (road.meta_state !== 'declared') {
          guard({ reason: 'road_unverified', subject: id, pointer, message: `The Road ${id} does not verify (at ${pointer}).` });
        }
      });
      if (identity.tier === 'road' && !(document.roads.length === 1 && document.roads[0] === key)) {
        guard({ reason: 'road_wrong_plan', subject: key, pointer: '/roads', message: 'In the no-Plan tier the only applicable Road is the keyed Road (at /roads).' });
      }
    }
    for (const entry of await readWindowFindingsOf({ repositoryRoot, workflowRoot, reads: document.reads })) {
      guard({ reason: 'read_unresolved', subject: entry.path, pointer: entry.pointer, actual: entry.reason, message: `Read ${entry.path} ${entry.explanation} (at ${entry.pointer}).` });
    }
    const existing = await readContract({ repositoryRoot, workflowRoot, key });
    if (existing.problem === 'unsafe' || existing.problem === 'not_file' || existing.problem === 'not_text') {
      guard({ reason: 'ledger_unusable', subject: key, message: `The contract path ${existing.path ?? existing.workflow_path} cannot be used (${existing.problem}).`, actual: existing.problem });
    }
    if (findings.length > 0) return { rejection: { kind: 'findings', reason: 'proposal_rejected', findings: sortedFindings(findings) } };

    const { stored, text } = buildStoredVerification(document, workflowOption(service));
    const replacing = existing.exists;
    if (replacing && !dryRun && expectedSnapshot === undefined) {
      return {
        rejection: {
          kind: 'findings', reason: 'proposal_rejected',
          findings: [testerGuard({ reason: 'snapshot_required', subject: key, file: existing.path, message: `A contract already exists for ${key}; replacing it needs --if-snapshot.` })],
        },
      };
    }
    if (replacing && existing.text === text) {
      return { rejection: { kind: 'findings', reason: 'proposal_rejected', findings: [testerGuard({ reason: 'no_change', subject: key, file: existing.path, message: 'The proposed contract is identical to the stored one.' })] } };
    }
    return {
      operations: [{ type: replacing ? 'replace' : 'create', path: contractPath(key), content: text }],
      data: {
        kind: 'test_define',
        dry_run: false,
        contract: { plan: key, tier: identity.tier, path: existing.path ?? `${service.workflow_relative_path === '' ? '' : `${service.workflow_relative_path}/`}${contractPath(key)}`, policy: stored.policy, roads: stored.roads, created: !replacing, contract_hash: stored.meta.content_hash },
      },
      nextCommands: builder({ phase: 'defined', rootArgs }),
      proposed: stored,
    };
  };

  return runMutationFlow({
    ...flowBase, target, snapshotTarget: { plan: key }, requestInput: document, requestId, dryRun, expectedSnapshot, schema: VERIFICATION_SCHEMA,
    input, channel, boundary, lockOptions, retryCommands: retry(input.file), render,
  });
}

// ---- test handoff --------------------------------------------------------------------------------------------------
// The checks and the record of ONE handoff (a Worker baton), shared by `test handoff` and the `done` intent so the baton is built by one code
// path. Reads only: the caller appends `operation` in its own transaction. `document` is the validated input form, `snapshot` the road
// snapshot of the handoff row, `id` and `ts` the record identity.
// -> { problem: { reason, subject, pointer, ... } } | { operation, record, handoff: { id, plan, road, snapshot, ready, path, line, hash } }
export async function prepareHandoffRecord({ repositoryRoot, workflowRoot, key, document, snapshot, id, ts }) {
  const roads = await readRoadPlans({ repositoryRoot, workflowRoot });
  const road = roads.find(({ id: roadId }) => roadId === document.road);
  const problem = (args) => ({ problem: args });
  if (road === undefined) return problem({ reason: 'road_missing', subject: document.road, pointer: '/road', message: `No Road ${document.road} exists (at /road).` });
  if (road.meta_state !== 'declared') return problem({ reason: 'road_unverified', subject: road.id, pointer: '/road', message: `The Road ${road.path} does not verify (at /road).` });
  if (road.plan === null ? road.id !== key : road.plan !== key) {
    return problem({ reason: 'road_wrong_plan', subject: road.id, pointer: '/road', expected: key, actual: road.plan, message: `The Road ${road.id} does not belong to ${key} (at /road).` });
  }
  if (road.status === 'QUEUED') return problem({ reason: 'road_not_started', subject: road.id, pointer: '/road', message: `The Road ${road.id} is still QUEUED: there is nothing to hand off.` });
  const ledger = await readHandoffs({ repositoryRoot, workflowRoot, key });
  if (ledger.problem !== null) return problem({ reason: 'ledger_unusable', subject: key, message: `The handoff ledger ${ledger.path ?? ledger.workflow_path} cannot take a record (${ledger.problem}).`, actual: ledger.problem });
  const scope = await readScope({ repositoryRoot, workflowRoot, road: road.id });
  const ready = !scope.requests.some(({ state, blocking }) => state === 'pending' && blocking === true);
  const line = encodeJsonlRecord({
    id, ts, road: road.id, snapshot, result: document.result, reach: document.reach, expect: document.expect, ready,
  }, HANDOFF_SPEC);
  const record = decodeJsonl(line, () => HANDOFF_SPEC).records[0].value;
  const verdict = validateHandoff(record, { form: 'stored' });
  if (!verdict.ok) throw new TypeError(`rendered handoff is invalid: ${JSON.stringify(verdict.issues)}`);
  return {
    operation: { type: ledger.exists ? 'append' : 'create', path: handoffPath(key), content: line },
    record,
    handoff: { id, plan: key, road: road.id, snapshot: record.snapshot, ready, path: ledger.path ?? handoffPath(key), line: ledger.records.length + 1, hash: record.hash },
  };
}

// options: { repositoryRoot, workflowRoot, key, channel, again?, requestId?, dryRun?, expectedSnapshot?, ... }
export async function appendHandoff(options) {
  const {
    repositoryRoot, workflowRoot, key, channel, requestId, dryRun = false, again = false, expectedSnapshot, providers = createDefaultProviders(),
    knownCommands, boundary, lockOptions, rootArgs = [],
  } = options;
  const root = options.root ?? repositoryRoot;
  const command = 'test-handoff';
  const builder = VERIFICATION_NEXT_COMMAND_BUILDERS[command];
  const flowBase = { command, repositoryRoot, workflowRoot, root, providers, knownCommands };
  const retry = (file) => () => builder({ phase: 'rejected', plan: key, file: file ?? null, rootArgs });
  const snapshotFor = async (record) => {
    const road = record.packet?.data?.handoff?.road;
    return isId(road) ? (await commandSnapshot(command, { repositoryRoot, workflowRoot, target: { road } })).snapshot : null;
  };

  const input = await readAuthoringInput({ repositoryRoot, workflowRoot, channel });
  if (!input.ok) {
    if (input.missing && input.draft !== null && !dryRun) {
      const replay = await resolveMissingDraft({ ...flowBase, input, requestId, snapshotFor });
      if (replay !== null) return { outcome: 'replayed', packet: replay };
    }
    return inputRejection({ ...flowBase, schema: HANDOFF_SCHEMA, input, next: retry(null)(), requestId });
  }
  const { document } = input;
  const issues = validateHandoff(document, { form: 'input' }).issues;
  if (issues.length > 0) {
    return usageRejection({ ...flowBase, schema: HANDOFF_SCHEMA, findings: findingsForSchemaIssues(HANDOFF_SCHEMA, issues, { file: input.file }), next: retry(input.file)() });
  }

  const render = async (context) => {
    const prepared = await prepareHandoffRecord({
      repositoryRoot, workflowRoot, key, document, snapshot: context.current_snapshot, id: context.preview ? PREVIEW_ID : providers.runId(), ts: providers.now(),
    });
    if (prepared.problem !== undefined) return { rejection: { kind: 'findings', reason: 'proposal_rejected', findings: [testerGuard({ ...prepared.problem, file: input.file })] } };
    return {
      operations: [prepared.operation],
      data: { kind: 'test_handoff', dry_run: false, handoff: { ...prepared.handoff, id: context.preview ? null : prepared.handoff.id, hash: context.preview ? null : prepared.handoff.hash } },
      nextCommands: builder({ phase: 'handed_off', rootArgs }),
      proposed: prepared.record,
    };
  };

  return runMutationFlow({
    ...flowBase, snapshotTarget: { road: document.road }, requestInput: { plan: key, ...document }, requestId, dryRun, again, dedupe: 'append',
    expectedSnapshot, schema: HANDOFF_SCHEMA, input, channel, boundary, lockOptions, retryCommands: retry(input.file), render,
    replayNextCommands: builder({ phase: 'duplicate', plan: key, file: input.file, document, rootArgs }),
  });
}
