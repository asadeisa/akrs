// P1-W08 frozen decisions for the Memory writer and its reader API. Everything here is documentation that the tests
// pin down; the rest of lib/store/memory implements it. Decisions beyond the packet text are marked (decision).
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const MEMORY_DIRECTORY = 'memory';

// M001 already exists (schema violation of the Memory input or record). M002 and M003 are new permanent codes.
export const MEMORY_FINDING_CODES = Object.freeze({
  schema: 'AKRS-M001',
  pointer: 'AKRS-M002',
  file: 'AKRS-M003',
});

// Same vocabulary as the read-window projection of P1-W06, minus `ok` and `own_write` (a pointer has no own writes).
export const MEMORY_POINTER_REASONS = Object.freeze([
  'case_mismatch', 'missing', 'not_file', 'not_text', 'out_of_range', 'unsafe',
]);

export const MEMORY_FILE_REASONS = Object.freeze(['case_mismatch', 'not_file', 'not_text', 'table_not_last', 'unsafe']);

export const MEMORY_STORE_POLICY = deepFreeze({
  location: '(decision) <workflow>/memory/<topic>.md: one file per topic, top level of memory/ only (nested folders are not Memory topics). The packet and the reader report repository-relative paths like every other artifact.',
  topic: '(decision) The topic is the `topic` key of the input and follows the shared ID grammar (Q8: ASCII letters and digits joined by - or ., at most 64 characters, no device-name stems), so it is also a safe file base name. It is compared case-folded: a file that differs from the topic only in case is AKRS-M003 case_mismatch, never a second file.',
  create: 'The first record of a topic creates the file with a title line `# Memory: <topic>`, a blank line, then the canonical table header of the P1-W01 Memory codec (the single Memory syntax; no second one exists) and one record row. The file is written with LF only and one final newline.',
  append: 'Every add appends exactly one canonical Markdown record row (CLI-owned id, label, owner columns, pointers and the hidden id/hash marker) through the transaction `append` operation. Earlier bytes are never rewritten, hand-edited or tampered records included (the reader reports those as unverified).',
  existing_files: '(decision) An existing file that has the canonical table must end with it (the last line is a record row): otherwise a new row would fall outside the table, which the codec reports as row_outside_table, so the add is AKRS-M003 table_not_last and writes nothing. An existing file with no canonical table (legacy prose, an empty file) keeps its bytes: a blank line, the canonical header and the new row are appended after it. The prose is not parsed and never becomes records.',
  record_identity: '(decision) The record id is a ULID from providers.runId(), drawn once under the lock for a real write; a dry run draws none and reports id and hash as null. The packet reports { id, topic, label, path, line, hash, meta_state } where line is the 1-based line of the row in the file after the write and hash is the row marker hash.',
  text: 'The record text is narrative: kept exactly as submitted (Unicode, bidi marks, emoji, markdown), except that CRLF and a lone CR become LF (Q4/Q5: a Memory table cell is LF-only). The journal request is the normalized document, so the LF and CRLF spellings of one text are the same request.',
  pointers: 'Pointers resolve through the common path service before any write: contained in the repository (no escape through links), case matching the file system, existing (a pointer is evidence, so unlike a Road read a whole-file pointer must exist), a window must be a UTF-8 text file with at least that many lines (the same line counting as the read-window projection). Each failure is AKRS-M002 with an RFC 6901 pointer into the input.',
  pointer_targets: '(decision) decided_by and owner_plan are IDs of a Plan or Road; their existence is not checked at write time (a Plan file need not exist yet, see P1-W06). P1-W13 validation owns that cross-reference.',
  validation_order: 'closed input schema (usage error, AKRS-M001, before the lock); then under the lock and in dry runs: topic file readiness (AKRS-M003) and pointer resolution (AKRS-M002), reported together. Any error means nothing is written.',
  unknown: 'An Unknown names an owner Plan, carries no pointers and is written like any record. The reader exposes every Unknown (declared or unverified) in `unknown`; it is never promoted to a fact: `facts` holds only declared Decided and Assumption records.',
  prose: 'Arbitrary old Memory prose is never scanned for labels, facts or Unknowns. The reader parses only the canonical table; a file without it is reported as unstructured with zero records, so the gap is visible instead of guessed at.',
  duplicates: 'Journal idempotency with dedupe "append": an exact duplicate (same normalized document) of a committed add returns noop with the original packet and next_commands offering the same command with --again; --again appends a deliberate duplicate under a salted key without hiding the original. A caller-supplied --request-id keeps the A1 semantics: the same ID replays its own committed op, a different ID is a new request.',
  drafts: 'The same channels as the Road writers: `--input <path>` (normally akrs/drafts/<name>.json) or `--json -`. A draft is deleted in the same transaction (changed lists both paths) and kept, byte for byte, on any failure; a retry whose draft is gone is resolved through the journal before any usage error.',
  exit_codes: 'Schema and input-channel failures, a reused or invalid request ID are usage errors (packet data.kind `usage`, exit 2). Pointer and file findings, a stale snapshot and a held lock are findings or blocked results (exit 1).',
  roles: '(decision) The manifest declares `required_role: leader` for memory-add (the Leader owns durable decisions and the Unknowns that gate a Plan), but no adapter enforces roles in this packet: there is no executor identity yet (P1-W15) and no authentication mechanism is invented. The role is metadata for help, the MCP projection (akrs_write / memory_add) and a later gate.',
  reader: 'readMemory / readMemoryFile / parseMemoryText return records through the same codec as the writer, each `declared` or `unverified` (a hash mismatch, or content that breaks the closed record schema, is unverified and never accepted silently). They are the API P1-W13 validation builds on.',
});
