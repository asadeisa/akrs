// Handlers of the navigation queries (P2-W09): status, next, where, graph, stale, log. They parse flags, resolve roots, read the
// shared workflow model once and wrap what the store modules built; no domain rule lives here. All of them are read only.
import { CliUsageError } from '../core/errors.js';
import { createPacket } from '../core/packet.js';
import { isId } from '../schemas/common.js';
import { validateRepoPath } from '../schemas/primitives.js';
import { buildGraphData } from '../store/navigation/graph.js';
import { buildLogData } from '../store/navigation/log.js';
import { readWorkflowModel } from '../store/navigation/model.js';
import { buildNextData } from '../store/navigation/next.js';
import { NAVIGATION_NEXT_COMMAND_BUILDERS } from '../store/navigation/next-commands.js';
import { LOG_LIMIT_MAX } from '../store/navigation/policy.js';
import { buildStaleData } from '../store/navigation/stale.js';
import { buildStatusData } from '../store/navigation/status.js';
import { buildWhereData } from '../store/navigation/where.js';
import { readLog } from '../store/log/repository.js';
import { commandSnapshot } from '../store/snapshots/index.js';
import { knownCommandsOf, resolveRoots, rootArgsOf } from './authoring.js';

async function packetOf(parameters, { id, roots, status = 'ok', data, next }) {
  const base = { repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root };
  const { snapshot } = await commandSnapshot(id, base);
  return createPacket({
    command: id,
    status,
    root: roots.repository_root,
    snapshot: { before: snapshot, after: snapshot },
    data,
    findings: [],
    nextCommands: next,
    providers: parameters.providers,
    knownCommands: knownCommandsOf(parameters.manifest),
  });
}

const context = (parameters) => {
  const roots = resolveRoots(parameters);
  return {
    roots,
    base: { repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root },
    rootArgs: rootArgsOf(parameters.input.flags),
  };
};
const model = (base, rootArgs) => readWorkflowModel({ ...base, env: process.env, rootArgs });
const defaultNext = (id, rootArgs) => NAVIGATION_NEXT_COMMAND_BUILDERS[id]({ phase: 'default', rootArgs });

export async function createStatusPacket(parameters) {
  const { roots, base, rootArgs } = context(parameters);
  return packetOf(parameters, { id: 'status', roots, data: buildStatusData(await model(base, rootArgs)), next: defaultNext('status', rootArgs) });
}

export async function createNextPacket(parameters) {
  const { roots, base, rootArgs } = context(parameters);
  const flag = parameters.input.flags['--executor'];
  if (flag !== undefined && !isId(flag)) throw new CliUsageError('--executor takes an executor ID');
  const loaded = await model(base, rootArgs);
  let executor = null;
  if (flag !== undefined) {
    executor = loaded.executors.find(({ id }) => id === flag) ?? null;
    if (executor === null) throw new CliUsageError(`next: no executor ${flag} is recorded (executor list names them)`);
  }
  const { data, next } = await buildNextData(loaded, { ...base, executor });
  return packetOf(parameters, { id: 'next', roots, data, next: NAVIGATION_NEXT_COMMAND_BUILDERS.next({ phase: next.length === 0 ? 'none' : 'actions', actions: next, rootArgs }) });
}

export async function createWherePacket(parameters) {
  const { roots, base, rootArgs } = context(parameters);
  const path = parameters.input.positionals.path;
  const issues = [];
  if (typeof path !== 'string' || path === '') throw new CliUsageError('where takes a repository path: akrs where <path>');
  validateRepoPath(path, 'path', issues, { allow: ['file', 'dir'] });
  if (issues.length > 0) throw new CliUsageError(`where: ${path} is not a safe repository-relative path (${issues[0].message})`);
  return packetOf(parameters, { id: 'where', roots, data: buildWhereData(await model(base, rootArgs), path), next: defaultNext('where', rootArgs) });
}

export async function createGraphPacket(parameters) {
  const { roots, base, rootArgs } = context(parameters);
  const touches = parameters.input.flags['--touches'] ?? null;
  if (touches !== null) {
    const issues = [];
    validateRepoPath(touches, '--touches', issues, { allow: ['file', 'dir'] });
    if (issues.length > 0) throw new CliUsageError(`graph: --touches ${touches} is not a safe repository-relative path (${issues[0].message})`);
  }
  return packetOf(parameters, { id: 'graph', roots, data: buildGraphData(await model(base, rootArgs), { touches }), next: defaultNext('graph', rootArgs) });
}

export async function createStalePacket(parameters) {
  const { roots, base, rootArgs } = context(parameters);
  const data = await buildStaleData(await model(base, rootArgs), base);
  return packetOf(parameters, { id: 'stale', roots, status: data.empty ? 'ok' : 'warning', data, next: defaultNext('stale', rootArgs) });
}

export async function createLogPacket(parameters) {
  const { roots, base, rootArgs } = context(parameters);
  const { flags } = parameters.input;
  const kind = flags['--kind'] ?? null;
  if (kind !== null && !['plan', 'road'].includes(kind)) throw new CliUsageError('log --kind is plan or road');
  const subject = flags['--subject'] ?? null;
  if (subject !== null && !isId(subject)) throw new CliUsageError('log --subject takes a Plan or Road ID');
  const limitText = flags['--limit'];
  if (limitText !== undefined && !/^[1-9][0-9]*$/.test(limitText)) throw new CliUsageError('log --limit is a positive integer');
  const limit = limitText === undefined ? null : Number(limitText);
  if (limit !== null && limit > LOG_LIMIT_MAX) throw new CliUsageError(`log --limit is at most ${LOG_LIMIT_MAX}`);
  const ledger = await readLog(base);
  return packetOf(parameters, { id: 'log', roots, data: buildLogData({ closures: ledger.records }, { kind, subject, limit }), next: defaultNext('log', rootArgs) });
}
