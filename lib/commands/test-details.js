// Handler of `test-details` (P2-W06): a query. It parses flags, resolves roots, asks the core for one Tester packet and wraps
// it. No domain rule lives here.
import { CliUsageError } from '../core/errors.js';
import { createPacket } from '../core/packet.js';
import { isId } from '../schemas/common.js';
import { buildTesterPacket } from '../store/test-details/index.js';
import { knownCommandsOf, resolveRoots, rootArgsOf } from './authoring.js';

export async function createTestDetailsPacket(parameters) {
  const { input, manifest, providers } = parameters;
  const roots = resolveRoots(parameters);
  const key = input.positionals.plan;
  if (key === undefined || !isId(key)) throw new CliUsageError('test-details takes a Plan ID (or the ID of a Road without a Plan): akrs test-details <plan>');
  const result = await buildTesterPacket({
    repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root, key, env: process.env, rootArgs: rootArgsOf(input.flags),
  });
  if (result.problem === 'unknown_plan') throw new CliUsageError(`test-details: no Plan or Road without a Plan is named ${key}`);
  return createPacket({
    command: 'test-details',
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
