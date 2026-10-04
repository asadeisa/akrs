// Handler of `verify --road` (P2-W03): an execution of declared checks. It parses flags, resolves roots, turns an
// interruption signal into an abort for the runner and wraps the one final result. No domain rule lives here.
import { CliUsageError } from '../core/errors.js';
import { createPacket } from '../core/packet.js';
import { isId } from '../schemas/common.js';
import { verifyRoad } from '../store/verify/index.js';
import { knownCommandsOf, resolveRoots, rootArgsOf } from './authoring.js';

const INTERRUPTIONS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export async function createVerifyPacket(parameters) {
  const { input, manifest, providers } = parameters;
  const roots = resolveRoots(parameters);
  const { flags } = input;
  const id = flags['--road'];
  if (id === undefined) throw new CliUsageError('verify needs --road <id>: akrs verify --road <id> [--check <name>] [--dry-run]');
  if (!isId(id)) throw new CliUsageError('--road takes a Road ID');
  const check = flags['--check'] ?? null;
  if (check !== null && check === '') throw new CliUsageError('--check takes the name of a declared check');
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  for (const name of INTERRUPTIONS) process.on(name, interrupt);
  let result;
  try {
    result = await verifyRoad({
      repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root, id, check, dryRun: flags['--dry-run'] === true,
      ifSnapshot: flags['--if-snapshot'] ?? null, env: process.env, signal: controller.signal, rootArgs: rootArgsOf(flags),
    });
  } finally {
    for (const name of INTERRUPTIONS) process.removeListener(name, interrupt);
  }
  if (result.problem === 'road_missing') throw new CliUsageError(`verify: no Road ${id} exists`);
  return createPacket({
    command: 'verify',
    status: result.status,
    root: roots.repository_root,
    snapshot: result.snapshot,
    data: result.data,
    findings: result.findings,
    nextCommands: result.nextCommands,
    providers,
    knownCommands: knownCommandsOf(manifest),
  });
}
