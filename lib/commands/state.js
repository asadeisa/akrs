// Handlers of `state set` and `state render` (P1-W11). They parse flags, resolve roots and return the packet the store
// flow built; no domain rule lives here.
import { CliUsageError } from '../core/errors.js';
import { SNAPSHOT_PATTERN } from '../schemas/common.js';
import { renderState, setState } from '../store/state/writer.js';
import { knownCommandsOf, resolveRoots, rootArgsOf } from './authoring.js';

function common(parameters) {
  const { input, manifest, providers } = parameters;
  const roots = resolveRoots(parameters);
  const { flags } = input;
  const expectedSnapshot = flags['--if-snapshot'];
  if (expectedSnapshot !== undefined && !SNAPSHOT_PATTERN.test(expectedSnapshot)) throw new CliUsageError('--if-snapshot must be sha256:<64 lowercase hex>');
  return {
    flags,
    options: {
      repositoryRoot: roots.repository_root,
      workflowRoot: roots.workflow_root,
      requestId: flags['--request-id'],
      dryRun: flags['--dry-run'] === true,
      expectedSnapshot,
      providers,
      knownCommands: knownCommandsOf(manifest),
      rootArgs: rootArgsOf(flags),
    },
  };
}

export async function createStateSetPacket(parameters) {
  const { flags, options } = common(parameters);
  const changes = {};
  if (flags['--mode'] !== undefined) {
    if (!/^[0-9]+$/.test(flags['--mode'])) throw new CliUsageError('--mode must be a whole number 0..4');
    changes.mode = Number(flags['--mode']);
  }
  for (const name of ['role', 'plan', 'phase', 'task', 'next']) if (flags[`--${name}`] !== undefined) changes[name] = flags[`--${name}`];
  const clear = flags['--clear'] === undefined ? [] : (Array.isArray(flags['--clear']) ? flags['--clear'] : [flags['--clear']]);
  return (await setState({ ...options, changes, clear, by: flags['--by'] })).packet;
}

export async function createStateRenderPacket(parameters) {
  const { options } = common(parameters);
  return (await renderState(options)).packet;
}

