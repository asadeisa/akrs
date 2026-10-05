// Handlers of the Leader intent `boot` and of the hook-facing `guard` (P2-W12). Thin wrappers over the store; no domain rule lives here.
import { CliUsageError } from '../../core/errors.js';
import { createPacket } from '../../core/packet.js';
import { buildBoot, GUARD_PACKET_SCHEMA, INTENT_NEXT_COMMAND_BUILDERS, decideWrite, denialMessage } from '../../store/intents/index.js';
import { knownCommandsOf, resolveRoots, rootArgsOf } from '../authoring.js';
import { EMPTY_SNAPSHOT } from '../../store/snapshots/projections.js';

export async function createBootPacket(parameters) {
  const { manifest, providers } = parameters;
  const roots = resolveRoots(parameters);
  const result = await buildBoot({ repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root, env: process.env, rootArgs: rootArgsOf(parameters.input.flags) });
  return createPacket({
    command: 'boot', status: result.status, root: roots.repository_root, snapshot: { before: EMPTY_SNAPSHOT, after: EMPTY_SNAPSHOT },
    data: result.data, findings: result.findings, nextCommands: result.nextCommands, providers, knownCommands: knownCommandsOf(manifest),
  });
}

// `guard <path>`: the same decision `bin/akrs-guard.js` gives a hook, as a packet (allow is ok, deny is blocked). Nothing is written.
export async function createGuardPacket(parameters) {
  const { manifest, providers } = parameters;
  const roots = resolveRoots(parameters);
  const { flags, positionals } = parameters.input;
  const path = positionals.path;
  if (typeof path !== 'string' || path === '') throw new CliUsageError('guard takes a path: akrs guard <path> [--executor <id>]');
  const executor = flags['--executor'] ?? process.env.AKRS_EXECUTOR ?? null;
  const verdict = decideWrite({ path, executor, repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root });
  const denied = verdict.decision === 'deny';
  return createPacket({
    command: 'guard',
    status: denied ? 'blocked' : 'ok',
    root: roots.repository_root,
    snapshot: { before: EMPTY_SNAPSHOT, after: EMPTY_SNAPSHOT },
    data: { kind: 'guard', packet_version: GUARD_PACKET_SCHEMA, decision: verdict.decision, reason: verdict.reason, path: verdict.path, road: verdict.road, executor },
    findings: denied ? [{ code: 'AKRS-R026', severity: 'error', message: denialMessage(verdict), file: null, line: null, detail: { road: verdict.road, intent: 'guard', reason: verdict.reason, subject: verdict.path } }] : [],
    nextCommands: INTENT_NEXT_COMMAND_BUILDERS.guard({ rootArgs: rootArgsOf(flags) }),
    providers,
    knownCommands: knownCommandsOf(manifest),
  });
}
