// Handler of `plan finish <plan>` (P2-W08). It parses flags, resolves roots and wraps the packet the store built; no gate or
// domain rule lives here.
import { CliUsageError } from '../core/errors.js';
import { SNAPSHOT_PATTERN, isId } from '../schemas/common.js';
import { finishPlan } from '../store/plan-finish/index.js';
import { knownCommandsOf, resolveRoots, rootArgsOf } from './authoring.js';

export async function createPlanFinishPacket(parameters) {
  const { input, manifest, providers } = parameters;
  const roots = resolveRoots(parameters);
  const { flags } = input;
  const key = input.positionals.plan;
  if (key === undefined || !isId(key)) throw new CliUsageError('plan finish takes a Plan ID: akrs plan finish <plan>');
  const expectedSnapshot = flags['--if-snapshot'];
  if (expectedSnapshot !== undefined && !SNAPSHOT_PATTERN.test(expectedSnapshot)) throw new CliUsageError('--if-snapshot must be sha256:<64 lowercase hex>');
  const result = await finishPlan({
    repositoryRoot: roots.repository_root,
    workflowRoot: roots.workflow_root,
    key,
    requestId: flags['--request-id'],
    dryRun: flags['--dry-run'] === true,
    expectedSnapshot,
    providers,
    knownCommands: knownCommandsOf(manifest),
    rootArgs: rootArgsOf(flags),
    env: process.env,
  });
  return result.packet;
}
