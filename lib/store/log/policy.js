// P1-W09 frozen decisions for the closure ledger (`akrs/log/NNNN.jsonl`) and `log append`. Everything here is
// documentation that the tests pin down; the rest of lib/store/log implements it. Decisions beyond the packet text
// are marked (decision).
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const LOG_DIRECTORY = 'log';

// A segment holds at most this many records; the next record opens the next segment (rotate before line 81).
export const LOG_SEGMENT_LIMIT = 80;

// Closure records belong to the state family (AKRS-S001 is their schema violation).
export const LOG_FINDING_CODES = Object.freeze({
  duplicate: 'AKRS-S002',
  segment: 'AKRS-S003',
});

export const LOG_SEGMENT_REASONS = Object.freeze(['invalid_record', 'no_final_newline', 'not_file', 'not_text', 'unreadable', 'unsafe']);

export const LOG_STORE_POLICY = deepFreeze({
  location: 'The ledger is <workflow>/log/0001.jsonl, 0002.jsonl, ... (four digits, numeric order). Other names in log/ are ignored. The packet and the reader report repository-relative paths.',
  record: 'One closure record per line: the closed `akrs.closure/v1` object as one compact canonical JSON line ending in LF. The record id is a ULID from providers.runId(), ts is providers.now(), hash is computed by the P1-W01 JSONL codec. A dry run draws no id and reports id and hash as null.',
  input: '(decision) `log append` takes flat flags (--kind road|plan, --subject <id>, --outcome DONE|BLOCKED, --deviations <text>): a closure has four fields, so no input document or draft exists. A flag that breaks the closed schema is a usage error (exit 2) before the lock.',
  segment_choice: 'Under the repository lock the highest-numbered segment is the active one. It takes the record while it holds fewer than LOG_SEGMENT_LIMIT (80) records; otherwise the record opens the next segment, so the boundary is exact and a 81st line never exists.',
  transaction: 'An append is one transaction `append` operation on the active segment; a rotation is one transaction `create` operation of the next segment. The record is therefore never half written and an archived (full) segment is never opened for writing: its bytes stay identical.',
  duplicate_closure: '(decision) A subject (kind + id) is closed once: while the ledger holds a DONE record of the subject, any further record of the same kind and subject is refused with AKRS-S002 under the lock, across all segments. BLOCKED records may repeat and may be followed by one DONE.',
  usable_ledger: 'Before the first byte is written every segment must be readable: UTF-8 text without NUL, strict JSON lines that match the closed closure schema, no duplicate record id, and the active segment must end with LF. Anything else is AKRS-S003 and nothing is written (the duplicate check cannot be trusted over unreadable lines). A record whose hash does not match its content stays counted for the duplicate check and is reported as unverified by the reader, never rewritten.',
  duplicates: 'Journal idempotency with dedupe "append": a retry of an exactly equal request (same normalized flags) of a committed append replays as noop with the original packet and adds no line; no --again exists, because a repeated closure is refused by duplicate_closure anyway. A caller-supplied --request-id keeps the A1 semantics.',
  operation: '(decision) A manual `log append` carries no operation reference (operation is null): lifecycle commands that close a Road inside their own transaction fill it.',
  roles: '(decision) The manifest declares `required_role: leader` for log-append, but no adapter enforces roles in this packet (same as memory-add).',
  reader: 'readLog returns every segment and the closure records in chronological ledger order (segment number, then line); ties cannot exist because order is positional. It is the API the `log` query (P2-W09) and the state renderer (P1-W11) build on.',
});
