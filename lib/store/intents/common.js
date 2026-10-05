// Shared by the Worker intents: the holder, the refusal finding and the packet plumbing. Plain store functions.
import { createPacket } from '../../core/packet.js';
import { readExecutors } from '../executors/index.js';
import { resolveHolder } from '../leases/index.js';
import { INTENT_FINDING_CODE } from './policy.js';

export const intentFinding = ({ road = null, intent, reason, subject = null, message }) => ({
  code: INTENT_FINDING_CODE, severity: 'error', message, file: null, line: null, detail: { road, intent, reason, subject },
});

// The Worker that is acting: -> { status: 'resolved', executors, executor, holder, source }
//                              | { status: 'executors_unusable', path } | { status: 'unresolved', resolved }
export async function resolveWorker({ repositoryRoot, workflowRoot, executorFlag, env }) {
  const executors = await readExecutors({ repositoryRoot, workflowRoot });
  if (executors.exists && executors.meta_state !== 'declared') return { status: 'executors_unusable', path: executors.path };
  const resolved = resolveHolder({ flag: executorFlag, env, executors: executors.executors, role: 'worker' });
  if (resolved.status !== 'resolved') return { status: 'unresolved', resolved, executors };
  return {
    status: 'resolved', executors, executor: executors.executors.find(({ id }) => id === resolved.holder), holder: resolved.holder, source: resolved.source,
  };
}

export const unresolvedMessage = (resolved) => (resolved.choices.length === 0
  ? 'No Worker executor is declared, so nobody can hold a lease; the Leader records one with executor set.'
  : `The Worker executor is not decided (${resolved.reason}); pass --executor with one of: ${resolved.choices.join(', ')} (or set AKRS_EXECUTOR).`);

// A packet factory bound to one intent invocation.
export function packetFactory({ command, root, providers, knownCommands }) {
  return ({ status, data, findings = [], next = [], snapshot = null, requestId = null, changed = [] }) => createPacket({
    command, requestId, status, root, snapshot: { before: snapshot, after: snapshot }, data, findings, changed, nextCommands: next, providers, knownCommands,
  });
}
