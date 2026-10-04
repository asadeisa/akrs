// Handlers of `road update`, `road move` and the `scope` group (P1-W07). They parse flags, resolve roots, pick the
// input channel and return the packet the store flow built; no domain rule lives here.
import { CliUsageError } from '../core/errors.js';
import { createPacket } from '../core/packet.js';
import { SNAPSHOT_PATTERN, isId } from '../schemas/common.js';
import { moveRoad } from '../store/roads/move.js';
import { updateRoad } from '../store/roads/update.js';
import { SCOPE_NEXT_COMMAND_BUILDERS } from '../store/scope/next-commands.js';
import { readAllRequests } from '../store/scope/repository.js';
import { requestScope, resolveScope } from '../store/scope/writer.js';
import { commandSnapshot } from '../store/snapshots/index.js';
import { knownCommandsOf, resolveRoots, rootArgsOf, usagePacket } from './authoring.js';

function commonOptions(parameters) {
  const { input, manifest, providers } = parameters;
  const roots = resolveRoots(parameters);
  const { flags } = input;
  const expectedSnapshot = flags['--if-snapshot'];
  if (expectedSnapshot !== undefined && !SNAPSHOT_PATTERN.test(expectedSnapshot)) {
    throw new CliUsageError('--if-snapshot must be sha256:<64 lowercase hex>');
  }
  return {
    roots,
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

// One input document through --input or stdin; a usage packet when there is not exactly one channel.
async function documentChannel(parameters, { command, roots, verb, next }) {
  const { input, readStdin } = parameters;
  const { flags } = input;
  if (flags['--input'] !== undefined && input.stdin) {
    return { packet: usagePacket({ command, parameters, roots, reason: 'two_input_channels', next, message: `${verb} takes its document from --input <path> or from stdin (--json -), not both` }) };
  }
  if (flags['--input'] === undefined && !input.stdin) {
    return { packet: usagePacket({ command, parameters, roots, reason: 'missing_input', next, message: `${verb} needs a document: pass --input <path> (for example a draft) or --json - with the document on stdin` }) };
  }
  return { channel: input.stdin ? { stdin: await readStdin() } : { inputPath: flags['--input'] } };
}

export async function createRoadUpdatePacket(parameters) {
  const { roots, flags, options } = commonOptions(parameters);
  const id = parameters.input.positionals.id;
  if (!isId(id)) throw new CliUsageError('road update needs a Road ID');
  const rootArgs = options.rootArgs;
  const picked = await documentChannel(parameters, {
    command: 'road-update', roots, verb: 'road update', next: SCOPE_NEXT_COMMAND_BUILDERS['road-update']({ phase: 'rejected', id, file: null, patch: false, rootArgs }),
  });
  if (picked.packet !== undefined) return picked.packet;
  const result = await updateRoad({ ...options, id, channel: picked.channel, patch: flags['--patch'] === true, reason: flags['--reason'] ?? null });
  return result.packet;
}

export async function createRoadMovePacket(parameters) {
  const { roots, flags, options } = commonOptions(parameters);
  const id = parameters.input.positionals.id;
  if (!isId(id)) throw new CliUsageError('road move needs a Road ID');
  const plan = flags['--plan'];
  if (plan === undefined) {
    return usagePacket({
      command: 'road-move', parameters, roots, reason: 'missing_plan', next: SCOPE_NEXT_COMMAND_BUILDERS['road-move']({ phase: 'rejected', rootArgs: options.rootArgs }),
      message: 'road move needs --plan <plan-id|none>: the Plan folder the Road moves to',
    });
  }
  if (plan !== 'none' && !isId(plan)) throw new CliUsageError('--plan must be a Plan ID or "none"');
  const result = await moveRoad({ ...options, id, plan, apply: flags['--apply'] === true });
  return result.packet;
}

export async function createScopeRequestPacket(parameters) {
  const { roots, options } = commonOptions(parameters);
  const picked = await documentChannel(parameters, {
    command: 'scope-request', roots, verb: 'scope request', next: SCOPE_NEXT_COMMAND_BUILDERS['scope-request']({ phase: 'rejected', file: null, rootArgs: options.rootArgs }),
  });
  if (picked.packet !== undefined) return picked.packet;
  return (await requestScope({ ...options, channel: picked.channel })).packet;
}

const resolver = (mode) => async (parameters) => {
  const { flags, options } = commonOptions(parameters);
  const { target } = parameters.input.positionals;
  if (typeof target !== 'string' || target === '') throw new CliUsageError(`scope ${mode} needs a Road ID or a request ID`);
  return (await resolveScope({ ...options, mode, target, reason: flags['--reason'] ?? null })).packet;
};
export const createScopeApprovePacket = resolver('approve');
export const createScopeRejectPacket = resolver('reject');

export async function createScopeListPacket(parameters) {
  const { roots, options } = commonOptions(parameters);
  const road = parameters.input.positionals.road ?? null;
  if (road !== null && !isId(road)) throw new CliUsageError('scope list takes a Road ID');
  const { requests, issues } = await readAllRequests({ repositoryRoot: options.repositoryRoot, workflowRoot: options.workflowRoot, road });
  const { snapshot } = await commandSnapshot('scope-list', { repositoryRoot: options.repositoryRoot, workflowRoot: options.workflowRoot });
  return createPacket({
    command: 'scope-list',
    status: issues.length > 0 ? 'warning' : 'ok',
    root: roots.repository_root,
    snapshot: { before: snapshot, after: snapshot },
    data: {
      kind: 'scope_list',
      road,
      pending: requests.filter(({ state }) => state === 'pending').length,
      requests: requests.map((request) => ({
        id: request.id,
        road: request.road,
        state: request.state,
        blocking: request.blocking,
        ts: request.ts,
        reason: request.reason,
        add_reads: request.add_reads,
        add_writes: request.add_writes,
        resolution: request.resolution === null ? null : {
          id: request.resolution.id, outcome: request.resolution.outcome, granted_by: request.resolution.granted_by,
          reason: request.resolution.reason, ts: request.resolution.ts,
        },
      })),
    },
    findings: issues.map((entry) => ({
      code: 'AKRS-C005', severity: 'warning', message: `The scope ledger ${entry.file} has a problem: ${entry.message}`, file: entry.file, line: entry.line ?? null,
      detail: { check: 'scope-ledger', error: entry.message },
    })),
    providers: parameters.providers,
    knownCommands: options.knownCommands,
  });
}
