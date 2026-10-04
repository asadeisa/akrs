// Handler of `road-details` (P2-W01): a query. It parses flags, resolves roots, asks the core for one packet and wraps it.
// No domain rule lives here.
import { CliUsageError } from '../core/errors.js';
import { createPacket } from '../core/packet.js';
import { isId } from '../schemas/common.js';
import { buildRoadDetails } from '../store/road-details/index.js';
import { knownCommandsOf, resolveRoots, rootArgsOf } from './authoring.js';

const ROLES = ['worker', 'leader'];

export async function createRoadDetailsPacket(parameters) {
  const { input, manifest, providers } = parameters;
  const roots = resolveRoots(parameters);
  const { flags } = input;
  const id = input.positionals.id;
  if (id === undefined || !isId(id)) throw new CliUsageError('road-details takes a Road ID: akrs road-details <id> [--role worker|leader]');
  const role = flags['--role'] ?? 'worker';
  if (!ROLES.includes(role)) throw new CliUsageError(`--role must be one of: ${ROLES.join(', ')}`);
  const includeReads = flags['--include-reads'] === true;
  const noIncludeReads = flags['--no-include-reads'] === true;
  if (includeReads && noIncludeReads) throw new CliUsageError('--include-reads and --no-include-reads exclude each other');
  const full = flags['--full'] === true;
  const reuse = flags['--reuse'] === true;
  if (full && role !== 'leader') throw new CliUsageError('--full applies to --role leader: a Worker packet already carries everything it is allowed to act on');
  let maxTokens = null;
  if (flags['--max-tokens'] !== undefined) {
    if (!/^[1-9][0-9]{0,8}$/.test(flags['--max-tokens'])) throw new CliUsageError('--max-tokens must be a whole number of at least 1');
    maxTokens = Number(flags['--max-tokens']);
  }
  const rootArgs = rootArgsOf(flags);
  const result = await buildRoadDetails({
    repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root, id, role, includeReads, noIncludeReads, full, reuse, maxTokens, env: process.env, rootArgs,
  });
  if (result.problem === 'road_missing') throw new CliUsageError(`road-details: no Road ${id} exists`);
  return createPacket({
    command: 'road-details',
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
