// Handlers of `road new`, `task new` and `template` (P1-W06). They parse flags, resolve roots, pick the input channel
// and return the packet the store flow built; no domain rule lives here.
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { CliUsageError, WorkflowNotFoundError } from '../core/errors.js';
import { createPacket } from '../core/packet.js';
import { SNAPSHOT_PATTERN, isId } from '../schemas/common.js';
import { EXECUTOR_CLASSES } from '../schemas/executors.js';
import { TEMPLATE_KINDS, buildTemplate } from '../schemas/templates.js';
import { AUTHORING_FINDING_CODES } from '../store/roads/policy.js';
import { AUTHORING_NEXT_COMMAND_BUILDERS } from '../store/roads/next-commands.js';
import { DraftWriteError, writeTemplateDraft } from '../store/roads/templates.js';
import { runAuthoring } from '../store/roads/writers.js';
import { discoverRoots, normalizeAbsolutePath } from '../store/roots.js';
import { EMPTY_SNAPSHOT } from '../store/snapshots/projections.js';

const knownCommandsOf = (manifest) => manifest.commands.map(({ id }) => id);

// The root overrides exactly as given, so the next commands run against the same workflow.
function rootArgsOf(flags) {
  const args = [];
  for (const name of ['--root', '--workflow-root']) if (flags[name] !== undefined) args.push(name, flags[name]);
  return args;
}

function resolveRoots({ context, input }) {
  const workflowRoot = input.flags['--workflow-root'];
  let roots;
  try {
    roots = discoverRoots({ cwd: context.cwd, repositoryRoot: input.flags['--root'], workflowRoot });
  } catch (error) {
    if (workflowRoot !== undefined) throw new WorkflowNotFoundError(workflowRoot);
    if (error instanceof TypeError) throw new CliUsageError(error.message);
    throw error;
  }
  if (!existsSync(roots.workflow_root) || !statSync(roots.workflow_root).isDirectory()) {
    throw new WorkflowNotFoundError(roots.workflow_root);
  }
  return roots;
}

function usagePacket({ command, parameters, roots, reason, message, data = {}, next }) {
  return createPacket({
    command,
    status: 'error',
    root: roots.repository_root,
    snapshot: { before: EMPTY_SNAPSHOT, after: EMPTY_SNAPSHOT },
    data: { kind: 'usage', reason, ...data },
    findings: [{ code: 'AKRS-C001', severity: 'error', message, file: null, line: null, detail: { reason: message } }],
    nextCommands: next,
    providers: parameters.providers,
    knownCommands: knownCommandsOf(parameters.manifest),
  });
}

async function writerPacket(kind, command, parameters) {
  const { input, manifest, providers, readStdin } = parameters;
  const roots = resolveRoots(parameters);
  const { flags } = input;
  const template = kind === 'road' ? 'road' : 'task';
  const noInput = () => AUTHORING_NEXT_COMMAND_BUILDERS[command]({ phase: 'rejected', template, file: null, rootArgs: [] });
  const verb = kind === 'road' ? 'road new' : 'task new';

  if (flags['--input'] !== undefined && input.stdin) {
    return usagePacket({
      command, parameters, roots, reason: 'two_input_channels', next: noInput(),
      message: `${verb} takes its document from --input <path> or from stdin (--json -), not both`,
    });
  }
  if (flags['--input'] === undefined && !input.stdin) {
    return usagePacket({
      command, parameters, roots, reason: 'missing_input', next: noInput(),
      message: `${verb} needs a document: pass --input <path> (for example a draft) or --json - with the document on stdin`,
    });
  }
  const expectedSnapshot = flags['--if-snapshot'];
  if (expectedSnapshot !== undefined && !SNAPSHOT_PATTERN.test(expectedSnapshot)) {
    throw new CliUsageError('--if-snapshot must be sha256:<64 lowercase hex>');
  }
  const channel = input.stdin ? { stdin: await readStdin() } : { inputPath: flags['--input'] };
  const result = await runAuthoring(kind, {
    repositoryRoot: roots.repository_root,
    workflowRoot: roots.workflow_root,
    channel,
    requestId: flags['--request-id'],
    dryRun: flags['--dry-run'] === true,
    expectedSnapshot,
    providers,
    knownCommands: knownCommandsOf(manifest),
    rootArgs: rootArgsOf(flags),
  });
  return result.packet;
}

export const createRoadNewPacket = (parameters) => writerPacket('road', 'road-new', parameters);
export const createTaskNewPacket = (parameters) => writerPacket('task', 'task-new', parameters);

// ---- template --------------------------------------------------------------------------------------------------
function queryRoot({ context, input }) {
  try {
    return discoverRoots({ cwd: context.cwd, repositoryRoot: input.flags['--root'] }).repository_root;
  } catch (error) {
    if (input.flags['--root'] !== undefined && error instanceof TypeError) throw new CliUsageError(error.message);
    return normalizeAbsolutePath(resolve(context.cwd));
  }
}

export async function createTemplatePacket(parameters) {
  const { context, input, manifest, providers } = parameters;
  const { flags, positionals } = input;
  const known = knownCommandsOf(manifest);
  const kind = positionals.kind;
  const toDraft = flags['--to-draft'];

  if (!TEMPLATE_KINDS.includes(kind)) {
    return usagePacket({
      command: 'template',
      parameters,
      roots: { repository_root: queryRoot(parameters) },
      reason: 'unknown_template_kind',
      message: `unknown template kind "${kind}"; use one of: ${TEMPLATE_KINDS.join(', ')}`,
      data: { kinds: [...TEMPLATE_KINDS] },
      next: AUTHORING_NEXT_COMMAND_BUILDERS.template({ phase: 'unknown_kind' }),
    });
  }
  const executorClass = flags['--class'] ?? null;
  if (executorClass !== null && !EXECUTOR_CLASSES.includes(executorClass)) {
    throw new CliUsageError(`--class must be one of: ${EXECUTOR_CLASSES.join(', ')}`);
  }
  if (toDraft !== undefined && !isId(toDraft)) {
    throw new CliUsageError('--to-draft needs a draft name: ASCII letters and digits joined by - or ., at most 64 characters');
  }
  const template = buildTemplate(kind, { class: executorClass });
  const data = {
    kind: 'template', template, class: executorClass, class_applied: kind === 'road' && executorClass !== null, draft: null,
  };
  const base = {
    command: 'template',
    status: 'ok',
    snapshot: { before: EMPTY_SNAPSHOT, after: EMPTY_SNAPSHOT },
    providers,
    knownCommands: known,
  };

  if (toDraft === undefined) return createPacket({ ...base, root: queryRoot(parameters), data });

  const roots = resolveRoots({ context, input });
  try {
    const written = await writeTemplateDraft({
      repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root, name: toDraft, skeleton: template.skeleton,
    });
    return createPacket({
      ...base,
      root: roots.repository_root,
      data: { ...data, draft: written.path },
      changed: [written.workflow_path],
      nextCommands: AUTHORING_NEXT_COMMAND_BUILDERS.template({ phase: 'drafted', kind, file: written.path, rootArgs: rootArgsOf(flags) }),
    });
  } catch (error) {
    if (!(error instanceof DraftWriteError)) throw error;
    return createPacket({
      ...base,
      status: 'error',
      root: roots.repository_root,
      data: { kind: 'findings', reason: 'draft_not_written', template_kind: kind, draft: null },
      findings: [{
        code: AUTHORING_FINDING_CODES.draft,
        severity: 'error',
        message: `${error.message}.`,
        file: error.path,
        line: null,
        detail: { path: error.path, reason: error.reason },
      }],
      nextCommands: [{ command: 'template', args: [kind] }],
    });
  }
}
