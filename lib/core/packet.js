import { compareStrings } from '../schemas/common.js';
import { compareFindings } from '../schemas/finding.js';
import { validateEvent } from '../schemas/event.js';
import { validatePacket } from '../schemas/packet.js';
import { ContractValidationError } from '../schemas/validation.js';
import { createDefaultProviders } from './providers.js';
import { normalizeAbsolutePath } from './roots.js';

function requireProvider(providers, name) {
  if (typeof providers?.[name] !== 'function') {
    throw new TypeError(`providers.${name} must be a function`);
  }
  return providers[name];
}

function validateOrThrow(label, result) {
  if (!result.ok) throw new ContractValidationError(label, result.issues);
}

export function createPacket({
  command,
  requestId = null,
  status,
  root,
  snapshot,
  data,
  findings = [],
  changed = [],
  nextCommands = [],
  providers = createDefaultProviders(),
  knownCommands,
}) {
  const now = requireProvider(providers, 'now');
  const runId = requireProvider(providers, 'runId');
  const packet = {
    schema_version: 'akrs.packet/v2',
    command,
    run_id: runId(),
    request_id: requestId,
    timestamp: now(),
    status,
    root: normalizeAbsolutePath(root),
    snapshot,
    data,
    findings: [...findings].sort(compareFindings),
    changed: [...changed].sort(compareStrings),
    next_commands: [...nextCommands],
  };
  validateOrThrow('packet', validatePacket(packet, { knownCommands }));
  return packet;
}

export function createCompleteEvent({
  packet,
  sequence,
  providers = createDefaultProviders(),
  knownCommands,
}) {
  const now = requireProvider(providers, 'now');
  const event = {
    schema_version: 'akrs.event/v1',
    run_id: packet?.run_id,
    sequence,
    timestamp: now(),
    type: 'complete',
    data: { packet },
  };
  validateOrThrow('complete event', validateEvent(event, { knownCommands }));
  return event;
}
