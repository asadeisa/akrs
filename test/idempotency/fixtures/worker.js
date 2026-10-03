// Child-process fixture for the P1-W04 race tests. It does nothing without a JSON config argument, because
// `node --test` also executes every .js file under test/ directly.
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPacket } from '../../../lib/core/packet.js';
import { normalizeAbsolutePath } from '../../../lib/core/roots.js';
import { runJournaledMutation } from '../../../lib/store/journal/index.js';
import { claimLease } from '../../../lib/store/leases/index.js';
import {
  LEASE_CONTRACT_PROJECTION,
  WORKFLOW_PROJECTION,
  computeSnapshot,
} from '../../../lib/store/snapshots/index.js';

const NO_TARGET = { road: null, plan: null };
const raw = process.argv[2];
if (raw !== undefined) await main(JSON.parse(raw));


async function main(config) {
  // All contenders start together so they actually race for the lock.
  if (config.startAt !== undefined) await delay(Math.max(0, config.startAt - Date.now()));
  if (config.mode === 'mutation') return mutation(config);
  if (config.mode === 'lease') return lease(config);
  throw new Error(`unknown worker mode: ${config.mode}`);
}

async function mutation(config) {
  const { options } = config;
  const root = normalizeAbsolutePath(options.repositoryRoot);
  const currentSnapshot = async () => (await computeSnapshot({ ...options, projections: WORKFLOW_PROJECTION })).snapshot;
  const result = await runJournaledMutation({
    ...options,
    root,
    command: config.command ?? 'memory-add',
    target: NO_TARGET,
    input: config.input,
    requestId: config.requestId,
    dedupe: config.dedupe,
    again: config.again,
    currentSnapshot,
    lockOptions: { timeoutMs: 60_000, retryMs: 5 },
    async apply(context) {
      // The marker outside the workflow proves how many times the mutation really ran.
      await appendFile(config.logFile, `${context.request_id} pid ${process.pid}\n`);
      const file = `memory/${context.input.name}.md`;
      await mkdir(dirname(`${options.workflowRoot}/${file}`), { recursive: true });
      await writeFile(`${options.workflowRoot}/${file}`, context.input.body);
      if (config.holdMs) await delay(config.holdMs);
      return createPacket({
        command: context.command,
        requestId: context.request_id,
        status: 'ok',
        root,
        snapshot: { before: context.current_snapshot, after: await currentSnapshot() },
        data: { kind: 'memory' },
        changed: [file],
      });
    },
  });
  process.stdout.write(`${JSON.stringify({
    outcome: result.outcome,
    request_id: result.request_id,
    replayed: result.replayed,
    status: result.packet?.status ?? null,
    pid: process.pid,
  })}\n`);
}

async function lease(config) {
  const { options } = config;
  const current = await computeSnapshot({
    ...options, projections: LEASE_CONTRACT_PROJECTION, target: { road: config.target },
  });
  const result = await claimLease({
    ...options,
    kind: 'road',
    target: config.target,
    holder: config.holder,
    takeover: config.takeover === true,
    snapshot: current.snapshot,
    inventory: current.inventory,
    requestId: null,
    lockOptions: { timeoutMs: 60_000, retryMs: 5 },
  });
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    holder: result.lease?.holder ?? result.holder ?? null,
    previous_holder: result.previous_holder ?? null,
    pid: process.pid,
  })}\n`);
}
