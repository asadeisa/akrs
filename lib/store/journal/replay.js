// The frozen replay packet (F8/F17): the original command, request_id, data, findings and next_commands, status
// `noop`, a NEW run_id and timestamp (a replay is a new run), snapshot { before: current, after: current } and
// `changed: []`. The packet schema is closed, so `replayed: { request_id, committed_at }` travels beside it.
import { createPacket } from '../../core/packet.js';
import { createDefaultProviders } from '../../core/providers.js';

const sameCommand = (left, right) => left.command === right.command
  && JSON.stringify(left.args) === JSON.stringify(right.args);

export function buildReplayPacket({
  record, root, currentSnapshot = null, providers = createDefaultProviders(), replayNextCommands = [], knownCommands,
} = {}) {
  if (record?.state !== 'committed' || record.packet === null || typeof record.packet !== 'object') {
    throw new TypeError('a replay needs a committed op record');
  }
  const { packet } = record;
  const nextCommands = [...packet.next_commands];
  for (const command of replayNextCommands) {
    if (!nextCommands.some((existing) => sameCommand(existing, command))) nextCommands.push(command);
  }
  return createPacket({
    command: record.command,
    requestId: record.request_id,
    status: 'noop',
    root: root ?? packet.root,
    snapshot: { before: currentSnapshot, after: currentSnapshot },
    data: packet.data,
    findings: packet.findings,
    changed: [],
    nextCommands,
    providers,
    knownCommands,
  });
}
