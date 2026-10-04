// Handlers of `road check`, `road activate`, `road finish`, `road reopen` and `lease release` (P2-W05). They parse flags,
// resolve roots, turn an interruption into an abort for the check runner of finish and wrap the result the store built; no
// domain rule lives here.
import { CliUsageError } from '../core/errors.js';
import { createPacket } from '../core/packet.js';
import { SNAPSHOT_PATTERN, isId } from '../schemas/common.js';
import { checkRoad, releaseRoadLease, transitionRoad } from '../store/lifecycle/index.js';
import { knownCommandsOf, resolveRoots, rootArgsOf } from './authoring.js';

const INTERRUPTIONS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function roadId(parameters, verb) {
  const id = parameters.input.positionals.id;
  if (id === undefined || !isId(id)) throw new CliUsageError(`road ${verb} takes a Road ID: akrs road ${verb} <id>`);
  return id;
}

export async function createRoadCheckPacket(parameters) {
  const { manifest, providers } = parameters;
  const roots = resolveRoots(parameters);
  const id = roadId(parameters, 'check');
  const result = await checkRoad({
    repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root, id, env: process.env, rootArgs: rootArgsOf(parameters.input.flags),
  });
  if (result.problem === 'road_missing') throw new CliUsageError(`road check: no Road ${id} exists`);
  return createPacket({
    command: 'road-check',
    status: result.status,
    root: roots.repository_root,
    snapshot: { before: result.snapshot, after: result.snapshot },
    data: result.data,
    findings: result.findings,
    nextCommands: result.nextCommands,
    providers,
    knownCommands: knownCommandsOf(manifest),
  });
}

const transitionHandler = (command, verb) => async (parameters) => {
  const { manifest, providers } = parameters;
  const roots = resolveRoots(parameters);
  const { flags } = parameters.input;
  const id = roadId(parameters, verb);
  const expectedSnapshot = flags['--if-snapshot'];
  if (expectedSnapshot !== undefined && !SNAPSHOT_PATTERN.test(expectedSnapshot)) throw new CliUsageError('--if-snapshot must be sha256:<64 lowercase hex>');
  const preExisting = flags['--pre-existing'] === undefined ? [] : [].concat(flags['--pre-existing']);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  for (const name of INTERRUPTIONS) process.on(name, interrupt);
  try {
    const result = await transitionRoad({
      repositoryRoot: roots.repository_root,
      workflowRoot: roots.workflow_root,
      command,
      id,
      deviations: flags['--deviations'] ?? null,
      preExisting,
      requestId: flags['--request-id'],
      dryRun: flags['--dry-run'] === true,
      expectedSnapshot,
      providers,
      knownCommands: knownCommandsOf(manifest),
      rootArgs: rootArgsOf(flags),
      env: process.env,
      signal: controller.signal,
      clock: providers.monotonic,
    });
    return result.packet;
  } finally {
    for (const name of INTERRUPTIONS) process.removeListener(name, interrupt);
  }
};

export const createRoadActivatePacket = transitionHandler('road-activate', 'activate');
export const createRoadFinishPacket = transitionHandler('road-finish', 'finish');
export const createRoadReopenPacket = transitionHandler('road-reopen', 'reopen');

export async function createLeaseReleasePacket(parameters) {
  const { manifest, providers } = parameters;
  const roots = resolveRoots(parameters);
  const { flags } = parameters.input;
  const id = parameters.input.positionals.road;
  if (id === undefined || !isId(id)) throw new CliUsageError('lease release takes a Road ID: akrs lease release <road>');
  const result = await releaseRoadLease({
    repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root, id, requestId: flags['--request-id'], dryRun: flags['--dry-run'] === true,
    providers, knownCommands: knownCommandsOf(manifest), rootArgs: rootArgsOf(flags),
  });
  if (result.problem === 'road_missing') throw new CliUsageError(`lease release: no Road ${id} exists`);
  return result.packet;
}
