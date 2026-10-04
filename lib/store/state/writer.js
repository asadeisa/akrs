// The State writers: `state set` (create or change the Leader-owned fields of state.json and re-render STATE.md in the
// same transaction) and `state render` (rewrite STATE.md only). Both judge the full proposed state under the repository
// lock and write through the transaction coordinator, like every workflow mutation.
import { createHash } from 'node:crypto';
import { createPacket } from '../../core/packet.js';
import { createDefaultProviders } from '../../core/providers.js';
import { STATE_SCHEMA, STATE_SPEC, validateState } from '../../schemas/state.js';
import { findingsForSchemaIssues } from '../../schemas/index.js';
import { canonicalizeJson, parseStrictJson, storedSpec, withMeta } from '../canonical/index.js';
import { runMutationFlow } from '../mutation-flow.js';
import { GENERATOR } from '../roads/policy.js';
import { sortedFindings } from '../roads/update.js';
import { STATE_CLEARABLE, STATE_FILE, STATE_FINDING_CODE, STATE_RENDER_FILE } from './policy.js';
import { STATE_NEXT_COMMAND_BUILDERS } from './next-commands.js';
import { deriveState, readRenderedState, readState } from './repository.js';
import { renderStateMarkdown } from './render.js';

const FIELDS = Object.freeze(['mode', 'role', 'plan', 'phase', 'task', 'next']);
const DEFAULTS = Object.freeze({ mode: 0, role: 'leader', plan: null, phase: null, task: null, next: null });

export function stateGuard({ reason, subject = 'state', message, file = null, actual = null }) {
  return { code: STATE_FINDING_CODE, severity: 'error', message, file, line: null, detail: { reason, subject, actual } };
}

const usageRejection = ({ command, root, providers, knownCommands, findings, next, reason = 'invalid_input' }) => ({
  outcome: 'rejected',
  packet: createPacket({
    command, requestId: null, status: 'error', root, snapshot: { before: null, after: null },
    data: { kind: 'usage', reason, schema: STATE_SCHEMA, missing_inputs: [] }, findings, nextCommands: next, providers, knownCommands,
  }),
});

// INPUT-form fields -> stored object (CLI fills `updated` and `meta`); callers validate first.
export function buildStoredState(fields, { updatedAt, updatedBy, generator = GENERATOR }) {
  const ordered = { schema: STATE_SCHEMA, ...Object.fromEntries(FIELDS.map((name) => [name, fields[name]])), updated: { at: updatedAt, by: updatedBy } };
  const stamped = withMeta(ordered, { schema: STATE_SCHEMA, generator, spec: STATE_SPEC });
  const text = canonicalizeJson(stamped, storedSpec(STATE_SPEC));
  return { stored: parseStrictJson(text).value, text };
}


// Shared judging of what state.json / STATE.md may be overwritten.
async function inspect({ repositoryRoot, workflowRoot }) {
  const state = await readState({ repositoryRoot, workflowRoot });
  const rendered = await readRenderedState({ repositoryRoot, workflowRoot });
  return { state, rendered };
}

const stateProblem = (state) => (state.exists && (state.problem !== null || state.meta_state !== 'declared')
  ? stateGuard({ reason: 'state_unusable', file: state.path, actual: state.problem ?? 'unverified', message: `state.json cannot be the source of truth (${state.problem ?? 'content hash or schema does not verify'}); restore it from version control.` })
  : null);

const renderProblem = (rendered) => (rendered.problem === 'unsafe' || rendered.problem === 'not_file'
  ? stateGuard({ reason: 'render_unusable', subject: 'STATE.md', file: rendered.path, actual: rendered.problem, message: `STATE.md cannot be replaced (${rendered.problem}).` })
  : null);

const writeOperation = (file, exists, content) => ({ type: exists ? 'replace' : 'create', path: file, content });

function packetData(kind, stored, { dryRun, wrote }) {
  return {
    kind,
    dry_run: dryRun,
    state: {
      mode: stored.mode, role: stored.role, plan: stored.plan, phase: stored.phase, task: stored.task, next: stored.next,
      updated_at: stored.updated.at, updated_by: stored.updated.by, content_hash: stored.meta.content_hash, meta_state: 'declared',
    },
    wrote,
  };
}

// options: { repositoryRoot, workflowRoot, changes: { mode?, role?, plan?, phase?, task?, next? }, clear?: [], by?, requestId?,
//   dryRun?, expectedSnapshot?, providers?, knownCommands, rootArgs?, boundary?, lockOptions? }
export async function setState(options) {
  const {
    repositoryRoot, workflowRoot, changes = {}, clear = [], by, requestId, dryRun = false, expectedSnapshot,
    providers = createDefaultProviders(), knownCommands, boundary, lockOptions, rootArgs = [],
  } = options;
  const root = options.root ?? repositoryRoot;
  const command = 'state-set';
  const builder = STATE_NEXT_COMMAND_BUILDERS[command];
  const flowBase = { command, repositoryRoot, workflowRoot, root, providers, knownCommands };
  const next = builder({ phase: 'rejected', rootArgs });
  const usage = (findings, reason) => usageRejection({ ...flowBase, findings, next, reason });
  const bad = (message) => usage([{ code: 'AKRS-C001', severity: 'error', message, file: null, line: null, detail: { reason: message } }], 'invalid_input');

  const named = FIELDS.filter((name) => changes[name] !== undefined);
  const unknownClear = clear.filter((name) => !STATE_CLEARABLE.includes(name));
  if (unknownClear.length > 0) return bad(`--clear takes ${STATE_CLEARABLE.join(', ')}; not ${unknownClear.join(', ')}`);
  const both = clear.filter((name) => named.includes(name));
  if (both.length > 0) return bad(`${both.join(', ')} is both set and cleared`);
  if (named.length === 0 && clear.length === 0) {
    return usage([{ code: 'AKRS-C001', severity: 'error', message: 'state set needs at least one of --mode --role --plan --phase --task --next --clear', file: null, line: null, detail: { reason: 'missing_input' } }], 'missing_input');
  }
  const partial = { schema: STATE_SCHEMA, ...Object.fromEntries(named.map((name) => [name, changes[name]])) };
  // Only the named fields are judged here; the complete object is judged again under the lock.
  const issues = validateState(partial, { form: 'input' }).issues.filter(({ code }) => code !== 'missing_key');
  if (issues.length > 0) return usage(findingsForSchemaIssues(STATE_SCHEMA, issues, { file: null }));
  if (by !== undefined && (typeof by !== 'string' || by.trim() === '' || /[\r\n]/.test(by))) return bad('--by must be a single non-empty line');

  const render = async (context) => {
    const { state, rendered } = await inspect({ repositoryRoot, workflowRoot });
    const refusal = stateProblem(state) ?? renderProblem(rendered);
    if (refusal !== null) return { rejection: { kind: 'findings', reason: 'proposal_rejected', findings: [refusal] } };
    const base = state.exists ? Object.fromEntries(FIELDS.map((name) => [name, state.state[name]])) : { ...DEFAULTS };
    const fields = { ...base, ...Object.fromEntries(named.map((name) => [name, changes[name]])), ...Object.fromEntries(clear.map((name) => [name, null])) };
    const checked = validateState({ schema: STATE_SCHEMA, ...fields }, { form: 'input' });
    if (!checked.ok) {
      return { rejection: { kind: 'findings', reason: 'proposal_rejected', findings: sortedFindings(findingsForSchemaIssues(STATE_SCHEMA, checked.issues, { file: state.path })) } };
    }
    const { stored, text } = buildStoredState(fields, { updatedAt: providers.now(), updatedBy: by ?? GENERATOR });
    const derived = await deriveState({ repositoryRoot, workflowRoot });
    const markdown = renderStateMarkdown({ state: stored, derived });
    const operations = [];
    if (!state.exists || state.text !== text) operations.push(writeOperation(STATE_FILE, state.exists, text));
    if (!rendered.exists || rendered.text !== markdown) operations.push(writeOperation(STATE_RENDER_FILE, rendered.exists, markdown));
    if (operations.length === 0) {
      return { rejection: { kind: 'findings', reason: 'proposal_rejected', findings: [stateGuard({ reason: 'no_change', message: 'The proposed state and STATE.md equal the stored ones.' })] } };
    }
    return {
      operations,
      data: packetData('state_set', stored, { dryRun: false, wrote: operations.map(({ path }) => path).sort() }),
      nextCommands: builder({ phase: 'written', rootArgs }),
      proposed: stored,
    };
  };

  return runMutationFlow({
    ...flowBase, requestInput: { schema: STATE_SCHEMA, changes: Object.fromEntries(named.map((name) => [name, changes[name]])), clear: [...clear].sort(), by: by ?? null },
    requestId, dryRun, expectedSnapshot, schema: STATE_SCHEMA, boundary, lockOptions, retryCommands: () => next, render,
  });
}

// options: { repositoryRoot, workflowRoot, requestId?, dryRun?, expectedSnapshot?, providers?, knownCommands, rootArgs?, ... }
export async function renderState(options) {
  const {
    repositoryRoot, workflowRoot, requestId, dryRun = false, expectedSnapshot, providers = createDefaultProviders(),
    knownCommands, boundary, lockOptions, rootArgs = [],
  } = options;
  const root = options.root ?? repositoryRoot;
  const command = 'state-render';
  const builder = STATE_NEXT_COMMAND_BUILDERS[command];
  const flowBase = { command, repositoryRoot, workflowRoot, root, providers, knownCommands };
  let lastReason = null;

  const render = async () => {
    const { state, rendered } = await inspect({ repositoryRoot, workflowRoot });
    const refusal = !state.exists
      ? stateGuard({ reason: 'state_missing', message: 'There is no state.json to render; create it with state set.' })
      : stateProblem(state) ?? renderProblem(rendered);
    if (refusal !== null) {
      lastReason = refusal.detail.reason;
      return { rejection: { kind: 'findings', reason: 'proposal_rejected', findings: [refusal] } };
    }
    const derived = await deriveState({ repositoryRoot, workflowRoot });
    const markdown = renderStateMarkdown({ state: state.state, derived });
    if (rendered.exists && rendered.text === markdown) {
      lastReason = 'no_change';
      return { rejection: { kind: 'findings', reason: 'proposal_rejected', findings: [stateGuard({ reason: 'no_change', subject: 'STATE.md', file: rendered.path, message: 'STATE.md already equals the render of the canonical inputs.' })] } };
    }
    return {
      operations: [writeOperation(STATE_RENDER_FILE, rendered.exists, markdown)],
      data: packetData('state_render', state.state, { dryRun: false, wrote: [STATE_RENDER_FILE] }),
      nextCommands: builder({ phase: 'rendered', rootArgs }),
      proposed: { path: rendered.path ?? STATE_RENDER_FILE, bytes: Buffer.byteLength(markdown) },
    };
  };

  // STATE.md is the OUTPUT of this command, not one of its snapshot inputs, so a journal replay of an identical earlier request could
  // hide a stale or hand-edited file. The request therefore names the STATE.md bytes it saw: an unchanged file with unchanged sources
  // replays as noop, any other file is a new request.
  const seen = await readRenderedState({ repositoryRoot, workflowRoot });
  const requestInput = { schema: STATE_SCHEMA, render: true, current: seen.text === null ? null : createHash('sha256').update(seen.text).digest('hex') };
  return runMutationFlow({
    ...flowBase, requestInput, requestId, dryRun, expectedSnapshot, schema: STATE_SCHEMA, boundary,
    lockOptions, retryCommands: () => builder({ phase: 'rejected', reason: lastReason, rootArgs }), render,
  });
}
