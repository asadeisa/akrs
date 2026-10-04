// The event producer of a streaming command (P2-W04). It owns one run ID, a contiguous sequence from 1 and exactly one
// terminal `complete`; it writes each event the moment it exists (or buffers it when no sink is given). The run ID and the
// final packet's timestamp are drawn once, in the order createPacket draws them, so the packet inside `complete` is the
// very packet the non-stream call returns under the same providers.
import { validateEvent } from '../schemas/event.js';
import { ContractValidationError } from '../schemas/validation.js';
import { createCompleteEvent } from './packet.js';

export function createEventStream({ providers, knownCommands, write = null }) {
  let runId = null;
  let packetTimestamp = null;
  let sequence = 0;
  let completed = false;
  let validator = null;
  const buffered = [];
  const put = (event) => {
    const line = `${JSON.stringify(event)}\n`;
    if (write === null) buffered.push(line);
    else write(line);
  };
  const ensure = () => {
    if (runId !== null) return;
    runId = providers.runId();
    packetTimestamp = providers.now();
  };

  return {
    get active() { return runId !== null; },
    get completed() { return completed; },
    // an event validator beyond the generic envelope (the command's own closed data schemas)
    validateWith(check) { validator = check; },
    // providers for the ONE final packet: the stream's run ID and the timestamp drawn up front
    finalProviders() {
      ensure();
      let unused = true;
      return { runId: () => runId, now: () => { if (unused) { unused = false; return packetTimestamp; } return providers.now(); } };
    },
    emit(type, data) {
      if (completed) throw new TypeError('no event may follow complete');
      if (type === 'complete') throw new TypeError('complete is emitted by the adapter from the final packet');
      ensure();
      sequence += 1;
      const event = { schema_version: 'akrs.event/v1', run_id: runId, sequence, timestamp: providers.now(), type, data };
      const verdict = validateEvent(event, { knownCommands });
      if (!verdict.ok) throw new ContractValidationError('event', verdict.issues);
      if (validator !== null) {
        const extra = validator(event);
        if (!extra.ok) throw new ContractValidationError(`${type} event`, extra.issues);
      }
      put(event);
      return event;
    },
    complete(packet) {
      if (completed) throw new TypeError('complete was already emitted');
      if (runId !== null && packet.run_id !== runId) throw new TypeError('the final packet must carry the stream run ID');
      const event = createCompleteEvent({ packet, sequence: sequence + 1, providers, knownCommands });
      sequence += 1;
      put(event);
      completed = true;
      return event;
    },
    // what was not written live (everything, when there is no sink)
    flush() {
      return buffered.splice(0).join('');
    },
  };
}
