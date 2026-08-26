import { validateEvent } from '../schemas/event.js';
import { ContractValidationError } from '../schemas/validation.js';

export function renderJsonl(events, { knownCommands } = {}) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  if (events.length === 0) throw new TypeError('events must end with one complete event');
  const runId = events[0]?.run_id;
  const lines = events.map((event, index) => {
    const result = validateEvent(event, { knownCommands });
    if (!result.ok) throw new ContractValidationError('event', result.issues);
    if (event.run_id !== runId) throw new TypeError('all events must use the same run ID');
    if (event.sequence !== index + 1) throw new TypeError('event sequence must start at 1 and be contiguous');
    const terminal = index === events.length - 1;
    if ((event.type === 'complete') !== terminal) {
      throw new TypeError('exactly the terminal event must have type complete');
    }
    return `${JSON.stringify(event)}\n`;
  });
  return lines.join('');
}
