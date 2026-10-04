// The executor writers: `executor set` (upsert one executor and/or change class_overrides) and `executor remove`.
// Both judge the complete proposed document under the repository lock and write executors.json through the
// transaction coordinator, like every workflow mutation.
import { createPacket } from '../../core/packet.js';
import { createDefaultProviders } from '../../core/providers.js';
import { compareStrings } from '../../schemas/common.js';
import { EXECUTORS_SCHEMA, EXECUTORS_SPEC, validateExecutors } from '../../schemas/executors.js';
import { findingsForSchemaIssues } from '../../schemas/index.js';
import { canonicalizeJson, parseStrictJson, storedSpec, withMeta } from '../canonical/index.js';
import { runMutationFlow } from '../mutation-flow.js';
import { GENERATOR } from '../roads/policy.js';
import { sortedFindings } from '../roads/update.js';
import { EXECUTOR_FINDING_CODES, EXECUTORS_FILE } from './policy.js';
import { EXECUTOR_NEXT_COMMAND_BUILDERS } from './next-commands.js';
import { readExecutors } from './repository.js';

export function executorGuard({ reason, subject = 'executors', message, file = null }) {
  return { code: EXECUTOR_FINDING_CODES.guard, severity: 'error', message, file, line: null, detail: { reason, subject } };
}

export function buildStoredExecutors(document, { generator = GENERATOR } = {}) {
  const ordered = {
    schema: EXECUTORS_SCHEMA,
    executors: [...document.executors].sort((a, b) => compareStrings(a.id, b.id)),
    class_overrides: document.class_overrides,
  };
  const stamped = withMeta(ordered, { schema: EXECUTORS_SCHEMA, generator, spec: EXECUTORS_SPEC });
  const text = canonicalizeJson(stamped, storedSpec(EXECUTORS_SPEC));
  return { stored: parseStrictJson(text).value, text };
}

const apply = (overrides, { set = [], clear = [] }) => {
  const next = JSON.parse(JSON.stringify(overrides));
  for (const { class: cls, knob, value } of set) next[cls] = { ...(next[cls] ?? {}), [knob]: value };
  for (const { class: cls, knob } of clear) {
    if (next[cls] === undefined) continue;
    delete next[cls][knob];
    if (Object.keys(next[cls]).length === 0) delete next[cls];
  }
  return next;
};

const usageRejection = ({ command, root, providers, knownCommands, findings, next, reason = 'invalid_input' }) => ({
  outcome: 'rejected',
  packet: createPacket({
    command, requestId: null, status: 'error', root, snapshot: { before: null, after: null },
    data: { kind: 'usage', reason, schema: EXECUTORS_SCHEMA, missing_inputs: [] }, findings, nextCommands: next, providers, knownCommands,
  }),
});

// options: { repositoryRoot, workflowRoot, command, change: { upsert?, remove?, setOverrides, clearOverrides }, requestInput, requestId?,
//   dryRun?, expectedSnapshot?, providers?, knownCommands, rootArgs?, boundary?, lockOptions? }
async function mutate(options) {
  const {
    repositoryRoot, workflowRoot, command, change, requestInput, requestId, dryRun = false, expectedSnapshot, providers = createDefaultProviders(),
    knownCommands, boundary, lockOptions, rootArgs = [],
  } = options;
  const root = options.root ?? repositoryRoot;
  const builder = EXECUTOR_NEXT_COMMAND_BUILDERS[command];
  const next = builder({ phase: 'rejected', rootArgs });
  const flowBase = { command, repositoryRoot, workflowRoot, root, providers, knownCommands };

  // Pre-lock: the supplied pieces must already be valid on their own (closed schema), whatever the file holds.
  if (change.upsert !== undefined && change.upsert !== null) {
    const probe = { schema: EXECUTORS_SCHEMA, executors: [change.upsert], class_overrides: {} };
    const issues = validateExecutors(probe, { form: 'input' }).issues;
    if (issues.length > 0) return usageRejection({ ...flowBase, findings: findingsForSchemaIssues(EXECUTORS_SCHEMA, issues, { file: null }), next });
  }
  if (change.setOverrides.length > 0) {
    const issues = validateExecutors({ schema: EXECUTORS_SCHEMA, executors: [], class_overrides: apply({}, { set: change.setOverrides }) }, { form: 'input' }).issues;
    if (issues.length > 0) return usageRejection({ ...flowBase, findings: findingsForSchemaIssues(EXECUTORS_SCHEMA, issues, { file: null }), next });
  }

  const render = async () => {
    const existing = await readExecutors({ repositoryRoot, workflowRoot });
    const reject = (finding) => ({ rejection: { kind: 'findings', reason: 'proposal_rejected', findings: [finding] } });
    if (existing.exists && (existing.problem !== null || existing.meta_state !== 'declared')) {
      return reject(executorGuard({ reason: 'file_unusable', file: existing.path, message: `executors.json cannot be changed (${existing.problem ?? 'content hash or schema does not verify'}); restore it from version control.` }));
    }
    let executors = existing.executors.map((entry) => ({ ...entry }));
    if (change.remove !== undefined) {
      if (!executors.some(({ id }) => id === change.remove)) return reject(executorGuard({ reason: 'executor_missing', subject: change.remove, message: `No executor "${change.remove}" is declared.` }));
      executors = executors.filter(({ id }) => id !== change.remove);
    }
    if (change.upsert !== undefined && change.upsert !== null) {
      executors = [...executors.filter(({ id }) => id.toLowerCase() !== change.upsert.id.toLowerCase()), { ...change.upsert }];
    }
    const proposed = {
      schema: EXECUTORS_SCHEMA,
      executors,
      class_overrides: apply(existing.class_overrides, { set: change.setOverrides, clear: change.clearOverrides }),
    };
    const checked = validateExecutors(proposed, { form: 'input' });
    if (!checked.ok) return { rejection: { kind: 'findings', reason: 'proposal_rejected', findings: sortedFindings(findingsForSchemaIssues(EXECUTORS_SCHEMA, checked.issues, { file: existing.path })) } };
    const { stored, text } = buildStoredExecutors(proposed);
    if (existing.exists && existing.text === text) {
      return reject(executorGuard({ reason: 'no_change', file: existing.path, message: 'The proposed executors file is identical to the stored one.' }));
    }
    return {
      operations: [{ type: existing.exists ? 'replace' : 'create', path: EXECUTORS_FILE, content: text }],
      data: {
        kind: command.replace('-', '_'),
        dry_run: false,
        executors: stored.executors.map(({ id, role, class: cls }) => ({ id, role, class: cls })),
        class_overrides: stored.class_overrides,
        content_hash: stored.meta.content_hash,
        created: !existing.exists,
      },
      nextCommands: builder({ phase: 'written', rootArgs }),
      proposed: stored,
    };
  };

  return runMutationFlow({
    ...flowBase, requestInput, requestId, dryRun, expectedSnapshot, schema: EXECUTORS_SCHEMA, boundary, lockOptions, retryCommands: () => next, render,
  });
}

// options: { executor: { id, role, class, label, user_answer }|null, setOverrides?: [{ class, knob, value }], clearOverrides?: [{ class, knob }], ... }
export function setExecutor(options) {
  const { executor = null, setOverrides = [], clearOverrides = [] } = options;
  return mutate({
    ...options,
    command: 'executor-set',
    change: { upsert: executor, setOverrides, clearOverrides },
    requestInput: { schema: EXECUTORS_SCHEMA, executor, set_overrides: setOverrides, clear_overrides: clearOverrides },
  });
}

export function removeExecutor(options) {
  return mutate({
    ...options,
    command: 'executor-remove',
    change: { remove: options.id, setOverrides: [], clearOverrides: [] },
    requestInput: { schema: EXECUTORS_SCHEMA, remove: options.id },
  });
}
