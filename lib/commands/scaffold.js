// Handler of `init --scaffold` (P1-W13). It resolves roots WITHOUT requiring the workflow folder (the scaffold creates it),
// and returns the packet the store flow built; no domain rule lives here.
import { CliUsageError } from '../core/errors.js';
import { SNAPSHOT_PATTERN } from '../schemas/common.js';
import { discoverRoots } from '../store/roots.js';
import { scaffoldWorkflow } from '../store/scaffold/writer.js';
import { knownCommandsOf, rootArgsOf } from './authoring.js';

export async function createScaffoldPacket(parameters) {
  const { context, input, manifest, providers } = parameters;
  const { flags } = input;
  let roots;
  try {
    roots = discoverRoots({ cwd: context.cwd, repositoryRoot: flags['--root'], workflowRoot: flags['--workflow-root'] });
  } catch (error) {
    if (error instanceof TypeError) throw new CliUsageError(error.message);
    throw error;
  }
  if (flags['--if-snapshot'] !== undefined && !SNAPSHOT_PATTERN.test(flags['--if-snapshot'])) throw new CliUsageError('--if-snapshot must be sha256:<64 lowercase hex>');
  return (await scaffoldWorkflow({
    repositoryRoot: roots.repository_root,
    workflowRoot: roots.workflow_root,
    plan: flags['--plan'] ?? null,
    road: flags['--road'] ?? null,
    force: flags['--force'] === true,
    requestId: flags['--request-id'],
    dryRun: flags['--dry-run'] === true,
    providers,
    knownCommands: knownCommandsOf(manifest),
    rootArgs: rootArgsOf(flags),
  })).packet;
}
