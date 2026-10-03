// One canonical Memory record row. This is the P1-W01 Markdown codec with the Memory column layout: the writer and the
// reader share it, so there is no second Memory syntax. The hash is read back from the row's own marker.
import { MEMORY_RECORD_SPEC, validateMemoryRecord } from '../../schemas/memory.js';
import { renderMarkdownHeader, renderMarkdownRecord } from '../canonical/index.js';

export const MEMORY_TABLE_HEADER = renderMarkdownHeader(MEMORY_RECORD_SPEC);

// `... <!-- akrs:record <ULID> sha256:<hex> --> |` at the end of a row (the codec writes it into the last cell).
const ROW_MARKER = /<!-- akrs:record ([0-9A-HJKMNP-TV-Z]{26}) (sha256:[0-9a-f]{64}) --> \|$/;

export function markerOfRow(line) {
  const match = ROW_MARKER.exec(String(line).replace(/\r?\n?$/, ''));
  return match === null ? null : { id: match[1], hash: match[2] };
}

// record = { id, label, decided_by, owner_plan, text, pointers } (stored form: text is LF only).
// Returns { row, hash }; an invalid record is a programming error, callers validate first.
export function renderMemoryRecord(record) {
  const verdict = validateMemoryRecord(record);
  if (!verdict.ok) {
    throw new TypeError(`Memory record is invalid: ${verdict.issues.map(({ path, message }) => `${path} ${message}`).join('; ')}`);
  }
  const row = renderMarkdownRecord(record, MEMORY_RECORD_SPEC);
  const marker = markerOfRow(row);
  if (marker === null || marker.id !== record.id) throw new TypeError('the codec row has no readable marker');
  return { row, hash: marker.hash };
}
