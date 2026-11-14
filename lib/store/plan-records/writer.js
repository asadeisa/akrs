// The Plan record writers: `plan new`, `plan question add|resolve`, `plan seam add|remove`. Each judges the complete proposed Plan file under
// the repository lock and writes akrs/plans/<plan>.json through the transaction coordinator. Questions and seams only: Tester finding
// pointers belong to `test result` and the closure to `plan finish`.
import { createPacket } from '../../core/packet.js';
import { createDefaultProviders } from '../../core/providers.js';
import { findingsForSchemaIssues } from '../../schemas/index.js';
import { PLAN_SCHEMA, PLAN_SPEC, validatePlan } from '../../schemas/plan.js';
import { canonicalizeJson, parseStrictJson, storedSpec, withMeta } from '../canonical/index.js';
import { runMutationFlow } from '../mutation-flow.js';
import { planPath, readPlan } from '../plan-finish/repository.js';
import { GENERATOR } from '../roads/policy.js';
import { sortedFindings } from '../roads/update.js';
import { readRoadPlans } from '../verification/repository.js';
import { PLAN_NEXT_COMMAND_BUILDERS } from './next-commands.js';
import { PLAN_FINDING_CODE } from './policy.js';

export function planGuard({ reason, subject, message, file = null }) {
  return { code: PLAN_FINDING_CODE, severity: 'error', message, file, line: null, detail: { reason, subject } };
}

export function buildStoredPlan(document, { generator = GENERATOR } = {}) {
  const { meta: _meta, ...rest } = document;
  const stamped = withMeta({ ...rest, schema: PLAN_SCHEMA }, { schema: PLAN_SCHEMA, generator, spec: PLAN_SPEC });
  const text = canonicalizeJson(stamped, storedSpec(PLAN_SPEC));
  return { stored: parseStrictJson(text).value, text };
}

// The next free local ID with the prefix: one more than the highest <prefix><n> in use (Q1, Q2, ... / S1, S2, ...).
export function nextLocalId(prefix, entries) {
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  const highest = entries.reduce((max, { id }) => {
    const match = pattern.exec(id);
    return match === null ? max : Math.max(max, Number(match[1]));
  }, 0);
  return `${prefix}${highest + 1}`;
}

const usageRejection = ({ command, root, providers, knownCommands, findings, next }) => ({
  outcome: 'rejected',
  packet: createPacket({
    command, requestId: null, status: 'error', root, snapshot: { before: null, after: null },
    data: { kind: 'usage', reason: 'invalid_input', schema: PLAN_SCHEMA, missing_inputs: [] }, findings, nextCommands: next, providers, knownCommands,
  }),
});

const counts = (plan) => ({
  open_questions: plan.questions.filter(({ status }) => status === 'open').length,
  unowned_seams: plan.seams.filter(({ owner }) => owner === null).length,
});

// options: { repositoryRoot, workflowRoot, command, key, requestInput, change(plan, ctx) -> { plan, item } | { reject: finding }, create?,
//   probe?, requestId?, dryRun?, expectedSnapshot?, providers?, knownCommands, rootArgs?, boundary?, lockOptions? }
async function mutate(options) {
  const {
    repositoryRoot, workflowRoot, command, key, requestInput, change, create = false, probe = null, requestId, dryRun = false, expectedSnapshot,
    providers = createDefaultProviders(), knownCommands, boundary, lockOptions, rootArgs = [],
  } = options;
  const root = options.root ?? repositoryRoot;
  const builder = PLAN_NEXT_COMMAND_BUILDERS[command];
  const next = builder({ phase: 'rejected', plan: create ? null : key, rootArgs });
  const flowBase = { command, repositoryRoot, workflowRoot, root, providers, knownCommands };

  // Pre-lock: the supplied pieces must already be valid on their own (closed schema), whatever the file holds.
  if (probe !== null) {
    const issues = validatePlan({ schema: PLAN_SCHEMA, id: key, title: 'probe', questions: [], seams: [], ...probe }, { form: 'input' }).issues;
    if (issues.length > 0) return usageRejection({ ...flowBase, findings: findingsForSchemaIssues(PLAN_SCHEMA, issues, { file: null }), next });
  }

  const render = async () => {
    const existing = await readPlan({ repositoryRoot, workflowRoot, key });
    const reject = (finding) => ({ rejection: { kind: 'findings', reason: 'proposal_rejected', findings: [finding] } });
    const file = existing.path ?? null;
    let base;
    if (create) {
      if (existing.exists) return reject(planGuard({ reason: 'plan_exists', subject: key, file, message: `The Plan ${key} already exists (${existing.path}).` }));
      const roads = await readRoadPlans({ repositoryRoot, workflowRoot });
      if (roads.some(({ id }) => id.toLowerCase() === key.toLowerCase())) {
        return reject(planGuard({ reason: 'id_taken', subject: key, message: `A Road already uses the ID ${key}; Plan and Road IDs share one namespace.` }));
      }
      base = null;
    } else {
      if (!existing.exists) return reject(planGuard({ reason: 'plan_missing', subject: key, message: `No Plan ${key} exists; create it with plan new ${key} --title <text>.` }));
      if (existing.problem !== null || existing.meta_state !== 'declared') {
        return reject(planGuard({ reason: 'plan_unusable', subject: key, file, message: `The Plan file ${existing.path} does not verify (${existing.problem ?? 'hand-edited or invalid'}), so it is not changed; restore it from version control.` }));
      }
      if (existing.plan.closure?.status === 'closed') return reject(planGuard({ reason: 'plan_closed', subject: key, file, message: `The Plan ${key} is closed; a closed Plan takes no further write.` }));
      base = existing.plan;
    }
    const outcome = await change(base, { roads: async () => readRoadPlans({ repositoryRoot, workflowRoot }), file });
    if (outcome.reject !== undefined) return reject(outcome.reject);
    const { stored, text } = buildStoredPlan(outcome.plan);
    const checked = validatePlan(stored, { form: 'stored' });
    if (!checked.ok) return { rejection: { kind: 'findings', reason: 'proposal_rejected', findings: sortedFindings(findingsForSchemaIssues(PLAN_SCHEMA, checked.issues, { file })) } };
    if (existing.exists && existing.text === text) {
      return reject(planGuard({ reason: 'no_change', subject: key, file, message: `The proposed Plan ${key} is identical to the stored one.` }));
    }
    return {
      operations: [{ type: existing.exists ? 'replace' : 'create', path: planPath(key), content: text }],
      data: {
        kind: command.replaceAll('-', '_'),
        dry_run: false,
        plan: { id: key, path: existing.path ?? `${planPath(key)}`, created: !existing.exists, content_hash: stored.meta.content_hash, ...counts(stored) },
        item: outcome.item,
      },
      nextCommands: builder({ phase: 'written', plan: key, rootArgs }),
      proposed: stored,
    };
  };

  return runMutationFlow({
    ...flowBase, snapshotTarget: { plan: key }, requestInput, requestId, dryRun, expectedSnapshot, schema: PLAN_SCHEMA, boundary, lockOptions,
    retryCommands: () => next, render,
  });
}

// options: { key, title, ... }
export function createPlan(options) {
  const { key, title } = options;
  return mutate({
    ...options,
    command: 'plan-new',
    create: true,
    probe: { title },
    requestInput: { schema: PLAN_SCHEMA, plan: key, title },
    change: async () => ({
      plan: { schema: PLAN_SCHEMA, id: key, title, questions: [], seams: [], findings: [], closure: { status: 'open', at: null, operation: null } },
      item: { type: 'plan', id: key },
    }),
  });
}

// options: { key, question?: id|null, text, ... }
export function addPlanQuestion(options) {
  const { key, question = null, text } = options;
  const probeId = question ?? 'Q1';
  return mutate({
    ...options,
    command: 'plan-question-add',
    probe: { questions: [{ id: probeId, text, status: 'open', resolution: null, decision: null }] },
    requestInput: { schema: PLAN_SCHEMA, plan: key, question, text },
    change: async (plan) => {
      const id = question ?? nextLocalId('Q', plan.questions);
      if (plan.questions.some((entry) => entry.id.toLowerCase() === id.toLowerCase())) {
        return { reject: planGuard({ reason: 'question_exists', subject: id, message: `The Plan ${key} already has a question ${id}.` }) };
      }
      return { plan: { ...plan, questions: [...plan.questions, { id, text, status: 'open', resolution: null, decision: null }] }, item: { type: 'question', id } };
    },
  });
}

// options: { key, question, resolution, decision?: ulid|null, ... }
export function resolvePlanQuestion(options) {
  const { key, question, resolution, decision = null } = options;
  return mutate({
    ...options,
    command: 'plan-question-resolve',
    probe: { questions: [{ id: question, text: 'probe', status: 'resolved', resolution, decision }] },
    requestInput: { schema: PLAN_SCHEMA, plan: key, question, resolution, decision },
    change: async (plan) => {
      const found = plan.questions.find((entry) => entry.id === question);
      if (found === undefined) return { reject: planGuard({ reason: 'question_missing', subject: question, message: `The Plan ${key} has no question ${question}.` }) };
      if (found.status === 'resolved') return { reject: planGuard({ reason: 'question_resolved', subject: question, message: `The question ${question} of ${key} is already resolved.` }) };
      const questions = plan.questions.map((entry) => (entry.id === question ? { ...entry, status: 'resolved', resolution, decision } : entry));
      return { plan: { ...plan, questions }, item: { type: 'question', id: question } };
    },
  });
}

// options: { key, seam?: id|null, text, road?: id|null, intent?: text|null, ... }
export function addPlanSeam(options) {
  const { key, seam = null, text, road = null, intent = null } = options;
  const owner = road === null && intent === null ? null : { road, intent };
  return mutate({
    ...options,
    command: 'plan-seam-add',
    probe: { seams: [{ id: seam ?? 'S1', text, owner }] },
    requestInput: { schema: PLAN_SCHEMA, plan: key, seam, text, owner },
    change: async (plan, context) => {
      const id = seam ?? nextLocalId('S', plan.seams);
      if (plan.seams.some((entry) => entry.id.toLowerCase() === id.toLowerCase())) {
        return { reject: planGuard({ reason: 'seam_exists', subject: id, message: `The Plan ${key} already has a seam ${id}.` }) };
      }
      if (road !== null && !(await context.roads()).some((entry) => entry.id === road)) {
        return { reject: planGuard({ reason: 'road_missing', subject: road, message: `No Road ${road} exists to own the seam ${id}.` }) };
      }
      return { plan: { ...plan, seams: [...plan.seams, { id, text, owner }] }, item: { type: 'seam', id } };
    },
  });
}

// options: { key, seam, ... }
export function removePlanSeam(options) {
  const { key, seam } = options;
  return mutate({
    ...options,
    command: 'plan-seam-remove',
    requestInput: { schema: PLAN_SCHEMA, plan: key, remove_seam: seam },
    change: async (plan) => {
      if (!plan.seams.some((entry) => entry.id === seam)) return { reject: planGuard({ reason: 'seam_missing', subject: seam, message: `The Plan ${key} has no seam ${seam}.` }) };
      return { plan: { ...plan, seams: plan.seams.filter((entry) => entry.id !== seam) }, item: { type: 'seam', id: seam } };
    },
  });
}
