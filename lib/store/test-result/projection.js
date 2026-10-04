// The reusable current-result projection (P2-W07) over the Tester packet: `status`, `next` and `plan finish` build on it. It reads
// only. The pure derivation lives in state.js so the packet builder can use it without importing itself.
import { buildTesterPacket } from '../test-details/index.js';

export { deriveTesterState } from './state.js';

// The projection of one Plan as it is now: null for a key that names no Plan.
export async function readTesterState({ repositoryRoot, workflowRoot, key, env = process.env }) {
  const packet = await buildTesterPacket({ repositoryRoot, workflowRoot, key, env });
  if (packet.problem === 'unknown_plan') return null;
  if (packet.data.kind === 'test_details_blocked') return { state: 'unverified', required: true, latest: null };
  return packet.data.result;
}
