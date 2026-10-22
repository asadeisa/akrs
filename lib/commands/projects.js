// Handlers of `projects add|list|remove` and `status --all-projects` (P2-W17). They resolve the user-config root from the injected
// environment, call lib/userconfig and wrap the result in one packet; no registry rule lives here. A registered project is only ever
// read, and only by status --all-projects.
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CliUsageError } from '../core/errors.js';
import { createPacket } from '../core/packet.js';
import { normalizeAbsolutePath } from '../core/roots.js';
import { checkText } from '../schemas/artifact-kit.js';
import { discoverRoots } from '../store/roots.js';
import {
  MAX_NAME_LENGTH, PROJECTS_FINDING_CODES, addProject, inspectProject, readProjectStatus, readRegistry, removeProject, resolveConfigRoot,
} from '../userconfig/index.js';
import { DESKTOP_NEXT_COMMAND_BUILDERS } from '../userconfig/next-commands.js';
import { STATUS_ALL_SCHEMA } from '../schemas/desktop.js';
import { knownCommandsOf } from './authoring.js';

const configOf = (context) => {
  const options = { env: context.env ?? process.env, platform: context.platform ?? process.platform };
  if (context.homedir !== undefined) options.homedir = context.homedir;
  return resolveConfigRoot(options);
};

const rejection = (reason, subject, message) => ({
  code: PROJECTS_FINDING_CODES.rejected, severity: 'error', message, file: null, line: null, detail: { reason, subject },
});
const invalidRegistryFinding = (registry) => {
  const [first] = registry.issues;
  const subject = first === undefined ? 'projects.json' : `${first.path} ${first.code}`;
  return rejection('registry_invalid', subject, `The projects registry (projects.json in the user-config root) does not verify (${subject}); it is left as it is. Fix or delete that file, then retry.`);
};
const REJECTION_TEXT = {
  missing: (subject) => `${subject} does not exist, so it cannot be registered.`,
  not_a_directory: (subject) => `${subject} is not a directory, so it cannot be registered.`,
  not_akrs: (subject) => `${subject} holds no AKRS workflow (a workflow folder with executors.json, plans, roads, state.json, tasks or verifications): create one first.`,
  unsafe: (subject) => `The workflow folder ${subject} resolves outside its repository, so the project cannot be registered.`,
};

const snapshotsOf = (result, registry) => ({ before: result?.before ?? registry.snapshot, after: result?.after ?? registry.snapshot });
const projectOf = (entry) => (entry === undefined || entry === null ? null : { root: entry.root, workflow: entry.workflow, name: entry.name, added_at: entry.added_at });

function packetFor(parameters, { command, status, data, findings = [], next = [], snapshot, requestId = null }) {
  const { context, manifest, providers } = parameters;
  return createPacket({
    command,
    requestId,
    status,
    root: normalizeAbsolutePath(context.cwd),
    snapshot,
    data,
    findings,
    nextCommands: next,
    providers,
    knownCommands: knownCommandsOf(manifest),
  });
}

function repositoryOf({ context, input }) {
  const given = input.positionals.path;
  const root = input.flags['--root'];
  if (given !== undefined && root !== undefined) throw new CliUsageError('projects add takes the repository as a path or as --root, not both');
  if (given !== undefined) return given;
  if (root !== undefined) return root;
  try {
    return discoverRoots({ cwd: context.cwd }).repository_root;
  } catch (error) {
    if (error instanceof TypeError) throw new CliUsageError(error.message);
    throw error;
  }
}

export async function createProjectsAddPacket(parameters) {
  const { context, input, providers } = parameters;
  const config = configOf(context);
  const dryRun = input.flags['--dry-run'] === true;
  const repository = repositoryOf(parameters);
  let name = null;
  if (input.flags['--name'] !== undefined) {
    name = input.flags['--name'];
    const issues = [];
    checkText(name, '--name', issues, { singleLine: true });
    if (issues.length > 0 || [...name].length > MAX_NAME_LENGTH) throw new CliUsageError(`--name is a single-line label of at most ${MAX_NAME_LENGTH} characters`);
  }
  const requestId = context.request_id ?? providers.runId();
  const base = { config_root: config.display, dry_run: dryRun, requested: normalizeAbsolutePath(resolve(context.cwd, repository)) };
  const inspected = await inspectProject({ cwd: context.cwd, repository, workflowOverride: input.flags['--workflow-root'] ?? null, name });
  const registryNow = await readRegistry({ configRoot: config.root });

  if (!inspected.ok) {
    const snapshot = { before: registryNow.snapshot, after: registryNow.snapshot };
    return packetFor(parameters, {
      command: 'projects-add',
      status: 'error',
      requestId,
      snapshot,
      data: { kind: 'projects_add', ...base, outcome: 'rejected', project: null, reason: inspected.reason, count: registryNow.projects.length },
      findings: [rejection(inspected.reason, inspected.subject, REJECTION_TEXT[inspected.reason](inspected.subject))],
      next: DESKTOP_NEXT_COMMAND_BUILDERS['projects-add'](inspected.reason === 'not_akrs' ? { phase: 'not_akrs', repository: base.requested } : { phase: 'none' }),
    });
  }

  // an existing entry for a spelling of the same root keeps its own name unless --name was given
  const wanted = { root: inspected.root, workflow: inspected.workflow, name: name ?? inspected.name };
  if (name === null) {
    const key = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
    const existing = registryNow.projects.find((entry) => key(entry.root) === key(inspected.root));
    if (existing !== undefined) wanted.name = existing.name;
  }
  const result = await addProject({ configRoot: config.root, project: wanted, now: () => providers.now(), dryRun, lockOptions: context.lock_options });
  const snapshot = snapshotsOf(result, result.registry ?? registryNow);
  const count = (result.registry ?? registryNow).projects.length + (result.status === 'added' ? 1 : 0);
  if (result.status === 'invalid') {
    return packetFor(parameters, {
      command: 'projects-add', status: 'error', requestId, snapshot,
      data: { kind: 'projects_add', ...base, outcome: 'invalid', project: null, reason: 'registry_invalid', count: 0 },
      findings: [invalidRegistryFinding(result.registry)],
    });
  }
  if (result.status === 'blocked') {
    return packetFor(parameters, {
      command: 'projects-add', status: 'blocked', requestId, snapshot,
      data: { kind: 'projects_add', ...base, outcome: 'blocked', project: null, reason: null, count: registryNow.projects.length },
      findings: [result.finding],
    });
  }
  if (result.status === 'full') {
    return packetFor(parameters, {
      command: 'projects-add', status: 'error', requestId, snapshot,
      data: { kind: 'projects_add', ...base, outcome: 'full', project: null, reason: 'registry_full', count: registryNow.projects.length },
      findings: [rejection('registry_full', 'projects.json', 'The registry already holds the maximum number of projects; remove one first (akrs projects remove <project>).')],
      next: [{ command: 'projects-list', args: [] }],
    });
  }
  return packetFor(parameters, {
    command: 'projects-add',
    status: result.status === 'noop' ? 'noop' : 'ok',
    requestId,
    snapshot,
    data: { kind: 'projects_add', ...base, outcome: result.status, project: projectOf(result.project), reason: null, count },
    next: DESKTOP_NEXT_COMMAND_BUILDERS['projects-add']({ phase: 'added' }),
  });
}

async function matcherFor(query, cwd) {
  const wanted = new Set([query, normalizeAbsolutePath(resolve(cwd, query))]);
  try {
    wanted.add(normalizeAbsolutePath(await realpath(resolve(cwd, query))));
  } catch {
    // a project whose directory is gone is still named by its path or by its name
  }
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const folded = new Set([...wanted].map(fold));
  return (entry) => folded.has(fold(entry.root)) || entry.name === query;
}

export async function createProjectsRemovePacket(parameters) {
  const { context, input, providers } = parameters;
  const config = configOf(context);
  const dryRun = input.flags['--dry-run'] === true;
  const query = input.positionals.project;
  if (typeof query !== 'string' || query === '') throw new CliUsageError('projects remove takes the project: its root path or its name');
  const requestId = context.request_id ?? providers.runId();
  const base = { kind: 'projects_remove', dry_run: dryRun, config_root: config.display, query };
  const result = await removeProject({ configRoot: config.root, match: await matcherFor(query, context.cwd), dryRun, lockOptions: context.lock_options });
  const registry = result.registry ?? await readRegistry({ configRoot: config.root });
  const snapshot = snapshotsOf(result, registry);
  if (result.status === 'invalid') {
    return packetFor(parameters, {
      command: 'projects-remove', status: 'error', requestId, snapshot,
      data: { ...base, outcome: 'invalid', project: null, count: 0 },
      findings: [invalidRegistryFinding(result.registry)],
    });
  }
  if (result.status === 'blocked') {
    return packetFor(parameters, {
      command: 'projects-remove', status: 'blocked', requestId, snapshot,
      data: { ...base, outcome: 'blocked', project: null, count: registry.projects.length },
      findings: [result.finding],
    });
  }
  if (result.status === 'not_found') throw new CliUsageError(`projects remove: no registered project matches "${query}"; akrs projects list shows what is registered`);
  if (result.status === 'ambiguous') {
    throw new CliUsageError(`projects remove: more than one registered project matches "${query}" (${result.candidates.map(({ root }) => root).join(', ')}); name it by its root path`);
  }
  return packetFor(parameters, {
    command: 'projects-remove', status: 'ok', requestId, snapshot,
    data: { ...base, outcome: 'removed', project: projectOf(result.project), count: registry.projects.length - 1 },
    next: DESKTOP_NEXT_COMMAND_BUILDERS['projects-remove']({ phase: 'removed' }),
  });
}

export async function createProjectsListPacket(parameters) {
  const { context } = parameters;
  const config = configOf(context);
  const registry = await readRegistry({ configRoot: config.root });
  const snapshot = { before: registry.snapshot, after: registry.snapshot };
  if (registry.state === 'invalid') {
    return packetFor(parameters, {
      command: 'projects-list', status: 'error', snapshot,
      data: { kind: 'projects_list', config_root: config.display, registry: 'invalid', projects: [] },
      findings: [invalidRegistryFinding(registry)],
    });
  }
  return packetFor(parameters, {
    command: 'projects-list', status: 'ok', snapshot,
    data: { kind: 'projects_list', config_root: config.display, registry: registry.state, projects: registry.projects.map(projectOf) },
    next: DESKTOP_NEXT_COMMAND_BUILDERS['projects-list']({ phase: 'listed', count: registry.projects.length }),
  });
}

// `status --all-projects`: the registered projects' status, read only. A project that cannot be read is a warning finding and a state, never a repair.
export async function createStatusAllProjectsPacket(parameters) {
  const { context } = parameters;
  const config = configOf(context);
  const registry = await readRegistry({ configRoot: config.root });
  const snapshot = { before: registry.snapshot, after: registry.snapshot };
  if (registry.state === 'invalid') {
    return packetFor(parameters, {
      command: 'status', status: 'error', snapshot,
      data: { kind: 'status_all_projects', packet_version: STATUS_ALL_SCHEMA, config_root: config.display, registry: 'invalid', projects: [] },
      findings: [invalidRegistryFinding(registry)],
    });
  }
  const projects = [];
  const findings = [];
  for (const entry of registry.projects) {
    const read = await readProjectStatus(entry);
    projects.push({ ...projectOf(entry), state: read.state, message: read.message, status: read.status });
    if (read.state !== 'ok') {
      findings.push({
        code: PROJECTS_FINDING_CODES.unreadable,
        severity: 'warning',
        message: `Registered project ${entry.name} (${entry.root}) cannot be read: ${read.message}`,
        file: null,
        line: null,
        detail: { project: entry.root, reason: read.state, message: read.message },
      });
    }
  }
  return packetFor(parameters, {
    command: 'status',
    status: findings.length > 0 ? 'warning' : 'ok',
    snapshot,
    data: { kind: 'status_all_projects', packet_version: STATUS_ALL_SCHEMA, config_root: config.display, registry: registry.state, projects },
    findings,
    next: registry.projects.length === 0 ? [] : [{ command: 'projects-list', args: [] }],
  });
}
