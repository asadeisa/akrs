// Proposal validation for `memory add`: the full proposed state is judged BEFORE any write. The input document is
// judged against the closed input schema (usage error), then, against the repository, the topic file and every pointer.
// Every problem is reported at once as a finding with an RFC 6901 pointer; any error means the caller writes nothing.
import { readFile, stat } from 'node:fs/promises';
import { compareFindings, validateFinding } from '../../schemas/finding.js';
import { findingsForSchemaIssues } from '../../schemas/index.js';
import { MEMORY_INPUT_SCHEMA, MEMORY_RECORD_SPEC, validateMemoryInput } from '../../schemas/memory.js';
import { findMissingInputs } from '../../schemas/templates.js';
import { parseMarkdownRecords } from '../canonical/index.js';
import { PathSafetyError, createPathService } from '../path-service.js';
import { projectReadWindows } from '../roads/read-windows.js';
import { inRepository } from '../roads/paths.js';
import { MEMORY_TABLE_HEADER, renderMemoryRecord } from './codec.js';
import { memoryPath } from './paths.js';
import { MEMORY_FINDING_CODES } from './policy.js';
import { decodeMemoryBytes } from './repository.js';

// A real run draws the record ID from the providers; a dry run draws none, so this placeholder stands in while the
// row is laid out (its line number does not depend on the ID) and the packet reports id and hash as null.
export const PREVIEW_RECORD_ID = '00000000000000000000000000';

const finding = ({ code, message, file, detail }) => ({ code, severity: 'error', message, file, line: null, detail });
const sorted = (findings) => {
  for (const entry of findings) {
    const verdict = validateFinding(entry);
    if (!verdict.ok) throw new TypeError(`Memory finding is invalid: ${JSON.stringify(verdict.issues)}`);
  }
  return [...findings].sort(compareFindings);
};

// Q4/Q5: a Memory table cell is LF-only, so CRLF and a lone CR in the narrative become LF. Nothing else changes.
export const normalizeMemoryDocument = (document) => ({ ...document, text: document.text.replace(/\r\n?/g, '\n') });

// ---- schema stage -------------------------------------------------------------------------------------------------
export function validateMemoryDocument(document, { file = null } = {}) {
  const { issues } = validateMemoryInput(document);
  if (issues.length === 0) return { ok: true, findings: [], missing_inputs: [] };
  return {
    ok: false,
    kind: 'usage',
    reason: 'invalid_input',
    schema: MEMORY_INPUT_SCHEMA,
    findings: sorted(findingsForSchemaIssues(MEMORY_INPUT_SCHEMA, issues, { file })),
    missing_inputs: findMissingInputs('memory', document),
  };
}

// ---- pointers -------------------------------------------------------------------------------------------------------
const POINTER_EXPLANATIONS = {
  case_mismatch: 'differs in case from the file system entry',
  missing: 'does not exist',
  not_file: 'is a directory, but a line window needs a file',
  not_text: 'is not UTF-8 text, so it has no lines',
  unsafe: 'is not a safe repository path (it resolves outside the repository)',
};

function pointerFinding(pointer, path, reason, file, lineCount) {
  const explanation = reason === 'out_of_range'
    ? `has ${lineCount} lines, so the declared window ends past the last line`
    : POINTER_EXPLANATIONS[reason];
  return finding({
    code: MEMORY_FINDING_CODES.pointer,
    message: `Pointer ${path} ${explanation} (at ${pointer}).`,
    file,
    detail: { pointer, path, reason, line_count: lineCount },
  });
}

// A pointer is evidence, so it must exist (unlike a Road read, which may name a file created later). The resolution
// and the line counting are the read-window projection of P1-W06.
async function pointerFindings({ repositoryRoot, workflowRoot }, document, file) {
  if (document.pointers.length === 0) return [];
  const windows = await projectReadWindows({
    repositoryRoot,
    workflowRoot,
    road: { reads: document.pointers.map(({ path, lines }) => ({ path, lines, why: null })), writes: [] },
  });
  const findings = [];
  for (const window of windows) {
    if (window.status === 'ok') continue;
    const pointer = window.status === 'out_of_range' ? `/pointers/${window.index}/lines` : `/pointers/${window.index}/path`;
    findings.push(pointerFinding(pointer, window.path, window.status, file, window.status === 'out_of_range' ? window.line_count : null));
  }
  return findings;
}

// ---- the topic file -------------------------------------------------------------------------------------------------
const FILE_EXPLANATIONS = {
  case_mismatch: (path, topic) => `${path} differs only in case from memory/${topic}.md, which would be a second file for one topic`,
  not_file: (path) => `${path} is not a regular file`,
  not_text: (path) => `${path} is not UTF-8 text`,
  table_not_last: (path) => `${path} has lines after its record table, so a new record would fall outside the table`,
  unsafe: (path) => `${path} is not a safe repository path`,
};

function fileFinding(reason, topic, path) {
  return finding({
    code: MEMORY_FINDING_CODES.file,
    message: `The Memory file cannot take a new record: ${FILE_EXPLANATIONS[reason](path, topic)} (at /topic).`,
    file: path,
    detail: { pointer: '/topic', topic, path, reason },
  });
}

const [HEADER_LINE, SEPARATOR_LINE] = MEMORY_TABLE_HEADER.split('\n');

// Where the canonical table stands in `text`: { hasTable, last } where `last` says the table is the last thing in the
// file (its last line is a record row or the separator), so one more row stays inside it.
function analyzeTable(text) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const start = lines.findIndex((line, index) => line === HEADER_LINE && lines[index + 1] === SEPARATOR_LINE);
  if (start === -1) return { hasTable: false, last: false };
  let end = start + 2;
  while (end < lines.length && lines[end].startsWith('|')) end += 1;
  return { hasTable: true, last: end === lines.length || (end === lines.length - 1 && lines[end] === '') };
}

// What to put on disk: { type: 'create' | 'append', content }. `existing` is the decoded text of the current file, or
// null when there is none. An existing file is only ever appended to; earlier bytes are never rewritten.
function planAddition(existing, { topic, row }) {
  if (existing === null) return { type: 'create', content: `# Memory: ${topic}\n\n${MEMORY_TABLE_HEADER}${row}` };
  if (existing === '') return { type: 'append', content: `${MEMORY_TABLE_HEADER}${row}` };
  const newline = existing.endsWith('\n') ? '' : '\n';
  // no table: the prose keeps its bytes and the canonical table starts after a blank line
  return {
    type: 'append',
    content: analyzeTable(existing).hasTable ? `${newline}${row}` : `${newline}\n${MEMORY_TABLE_HEADER}${row}`,
  };
}

async function readTopicFile(service, topic) {
  const workflowPath = memoryPath(topic);
  let resolved;
  try {
    resolved = await service.resolveWorkflowPath(workflowPath);
  } catch (error) {
    if (!(error instanceof PathSafetyError)) throw error;
    return { problem: 'unsafe', path: inRepository(service.workflow_relative_path, workflowPath) };
  }
  const path = resolved.actual_relative_path;
  if (!resolved.case_matches) return { problem: 'case_mismatch', path };
  if (!resolved.exists) return { text: null, path };
  if (!(await stat(resolved.filesystem_path)).isFile()) return { problem: 'not_file', path };
  const decoded = decodeMemoryBytes(await readFile(resolved.filesystem_path));
  if (decoded === null) return { problem: 'not_text', path };
  return { text: decoded, path };
}

const MAX_ID_DRAWS = 16;

// A record ID must be unique within its file (the codec rejects a duplicate ID). A ULID collision is astronomically
// unlikely with the default providers, but an injected provider may repeat itself: redraw a bounded number of times.
function drawRecordId(existing, newId) {
  const taken = existing === null
    ? new Set()
    : new Set(parseMarkdownRecords(existing, MEMORY_RECORD_SPEC).records.map(({ value }) => value.id));
  for (let attempt = 0; attempt < MAX_ID_DRAWS; attempt += 1) {
    const id = newId();
    if (!taken.has(id)) return id;
  }
  throw new TypeError('providers.runId keeps returning an ID that is already used in this Memory file');
}

// document: the NORMALIZED input (valid against the closed input schema). newId(): the record ID, drawn only when the
// proposal is accepted.
export async function validateMemoryProposal({ repositoryRoot, workflowRoot, document, file = null, newId }) {
  const schema = validateMemoryDocument(document, { file });
  if (!schema.ok) return schema;
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const findings = [];

  const target = await readTopicFile(service, document.topic);
  if (target.problem !== undefined) findings.push(fileFinding(target.problem, document.topic, target.path));
  else if (target.text !== null) {
    const table = analyzeTable(target.text);
    if (table.hasTable && !table.last) findings.push(fileFinding('table_not_last', document.topic, target.path));
  }
  findings.push(...await pointerFindings({ repositoryRoot, workflowRoot }, document, file));

  if (findings.length > 0) {
    return {
      ok: false, kind: 'findings', reason: 'proposal_rejected', schema: MEMORY_INPUT_SCHEMA, findings: sorted(findings), missing_inputs: [],
    };
  }

  const id = drawRecordId(target.text, newId);
  const record = {
    id,
    label: document.label,
    decided_by: document.decided_by,
    owner_plan: document.owner_plan,
    text: document.text,
    pointers: document.pointers.map(({ path, lines }) => ({ path, lines })),
  };
  const { row, hash } = renderMemoryRecord(record);
  const addition = planAddition(target.text, { topic: document.topic, row });
  const after = `${target.text ?? ''}${addition.content}`;
  // The whole file must read back through the one codec: the record is declared and equals what was submitted.
  const check = parseMarkdownRecords(after, MEMORY_RECORD_SPEC);
  const written = check.records.find(({ value }) => value.id === id);
  if (written === undefined || written.state !== 'declared' || JSON.stringify(written.value) !== JSON.stringify(record)) {
    throw new TypeError('the rendered Memory record does not read back as written');
  }
  const workflowPath = memoryPath(document.topic);
  return {
    ok: true,
    document,
    record,
    hash,
    line: written.line,
    operation: { type: addition.type, path: workflowPath, content: addition.content },
    workflowPath,
    path: target.path,
    warnings: [],
    findings: [],
  };
}
