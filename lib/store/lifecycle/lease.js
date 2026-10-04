// `lease release <road>`: the Leader frees a Road lease (A1). The lease store lives under .ops, which a transaction never
// writes, so this runs through the journaled mutation (lock, recovery gate, journal) like the other documented exception
// of the transaction policy. A Road with no lease is a noop; a corrupt lease file is removed (the Leader may).
import { createPacket } from '../../core/packet.js';
import { createDefaultProviders } from '../../core/providers.js';
import { isId } from '../../schemas/common.js';
import { runJournaledMutation } from '../journal/index.js';
import { readLease, releaseLease } from '../leases/index.js';
import { listRoadFiles } from '../roads/repository.js';
import { commandSnapshot } from '../snapshots/index.js';
import { createTransactionRecovery } from '../transactions/index.js';
import { LIFECYCLE_NEXT_COMMAND_BUILDERS } from './next-commands.js';

const COMMAND = 'lease-release';

// options: { repositoryRoot, workflowRoot, id, requestId?, dryRun?, providers?, knownCommands, rootArgs?, root?, boundary?, lockOptions? }
// -> { problem: 'road_missing' } | { outcome, packet, ... }
export async function releaseRoadLease(options) {
  const {
    repositoryRoot, workflowRoot, id, requestId, dryRun = false, providers = createDefaultProviders(), knownCommands, boundary, lockOptions, rootArgs = [],
  } = options;
  if (!isId(id)) throw new TypeError('id must be a valid ID');
  const root = options.root ?? repositoryRoot;
  const base = { repositoryRoot, workflowRoot };
  if ((await listRoadFiles(base)).every((file) => file.id !== id)) return { problem: 'road_missing' };
  const snapshotOf = async () => (await commandSnapshot(COMMAND, { ...base, target: { road: id } })).snapshot;
  const next = LIFECYCLE_NEXT_COMMAND_BUILDERS[COMMAND]({ phase: 'done', id, rootArgs });
  const packetOf = ({ status, data, snapshot, id: ulid = null, changed = [] }) => createPacket({
    command: COMMAND, requestId: ulid, status, root, snapshot: { before: snapshot, after: snapshot }, data, changed, nextCommands: next, providers, knownCommands,
  });
  const shape = ({ released, previous, dry }) => ({ kind: 'lease_release', dry_run: dry, road: id, released, previous_holder: previous });

  const peek = await readLease({ ...base, kind: 'road', target: id });
  const previous = peek.status === 'held' ? peek.lease.holder : null;
  if (peek.status === 'none') return { outcome: 'noop', packet: packetOf({ status: 'noop', data: shape({ released: false, previous: null, dry: dryRun }), snapshot: await snapshotOf() }) };
  if (dryRun) return { outcome: 'dry_run', packet: packetOf({ status: 'ok', data: shape({ released: false, previous, dry: true }), snapshot: await snapshotOf() }) };

  const recovery = createTransactionRecovery({ ...base, boundary });
  return runJournaledMutation({
    ...base,
    root,
    command: COMMAND,
    target: { road: id, plan: null },
    input: { road: id },
    requestId,
    dedupe: 'projection',
    providers,
    knownCommands,
    currentSnapshot: snapshotOf,
    lockOptions,
    recover: recovery.recover,
    sweep: recovery.sweep,
    replayNextCommands: next,
    async apply(context) {
      const before = context.current_snapshot;
      const released = await releaseLease({ ...base, kind: 'road', target: id, leader: true, heldLock: context.lock, providers });
      return packetOf({
        status: 'ok', data: shape({ released: released.status === 'released', previous: released.previous_holder ?? previous, dry: false }),
        snapshot: before, id: context.request_id,
      });
    },
  });
}
