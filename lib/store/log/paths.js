// Workflow-relative location of a closure ledger segment (LOG_STORE_POLICY.location).
import { LOG_DIRECTORY } from './policy.js';

const SEGMENT_NAME = /^(\d{4})\.jsonl$/;

export function segmentName(number) {
  if (!Number.isInteger(number) || number < 1 || number > 9999) throw new TypeError('segment number must be 1..9999');
  return `${String(number).padStart(4, '0')}.jsonl`;
}

export const segmentPath = (number) => `${LOG_DIRECTORY}/${segmentName(number)}`;

// Segment number of a file name, or null when it is not a ledger segment.
export function segmentNumber(name) {
  const match = SEGMENT_NAME.exec(name);
  if (match === null) return null;
  const number = Number(match[1]);
  return number >= 1 ? number : null;
}
