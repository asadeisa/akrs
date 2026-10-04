// Proposal for `log append`: the full proposed ledger state is judged BEFORE any write. The flags are judged against
// the closed closure schema (usage error), then, against the ledger under the lock: every segment readable, the
// subject not already closed. Any error means the caller writes nothing.
import { CLOSURE_SPEC, CLOSURE_SCHEMA, validateClosure } from '../../schemas/closure.js';
import { compareFindings, validateFinding } from '../../schemas/finding.js';
import { decodeJsonl, encodeJsonlRecord } from '../canonical/index.js';
import { segmentName, segmentPath } from './paths.js';
import { LOG_FINDING_CODES, LOG_SEGMENT_LIMIT } from './policy.js';
import { readLog } from './repository.js';

// A real run draws the record ID from the providers; a dry run draws none, so this placeholder stands in.
export const PREVIEW_CLOSURE_ID = '00000000000000000000000000';
const PREVIEW_HASH = `sha256:${'0'.repeat(64)}`;
const MAX_ID_DRAWS = 16;

const finding = ({ code, message, file, line = null, detail }) => ({ code, severity: 'error', message, file, line, detail });
const sorted = (findings) => {
  for (const entry of findings) {
    const verdict = validateFinding(entry);
    if (!verdict.ok) throw new TypeError(`log finding is invalid: ${JSON.stringify(verdict.issues)}`);
  }
  return [...findings].sort(compareFindings);
};

// document = { kind, subject, outcome, deviations } (deviations: string | null).
export function validateLogDocument(document) {
  const preview = {
    id: PREVIEW_CLOSURE_ID,
    hash: PREVIEW_HASH,
    ts: '2000-01-01T00:00:00.000Z',
    kind: document.kind,
    subject: document.subject,
    outcome: document.outcome,
    deviations: document.deviations,
    operation: null,
  };
  const { issues } = validateClosure(preview);
  const relevant = issues.filter(({ path }) => !['$.id', '$.hash', '$.ts'].includes(path));
  return relevant.length === 0
    ? { ok: true, issues: [] }
    : { ok: false, schema: CLOSURE_SCHEMA, issues: relevant.map(({ path, message }) => ({ path: path.replace(/^\$\./, '--'), message })) };
}

const SEGMENT_EXPLANATIONS = {
  invalid_record: (path) => `${path} holds a line that is not a valid closure record`,
  no_final_newline: (path) => `${path} does not end with a newline, so an appended record would join its last line`,
  not_file: (path) => `${path} is not a regular file`,
  not_text: (path) => `${path} is not UTF-8 text`,
  unreadable: (path) => `${path} cannot be read`,
  unsafe: (path) => `${path} is not a safe repository path`,
};

function segmentFinding(segment) {
  const reason = segment.problem;
  const first = segment.issues.find(({ code }) => code !== 'unverified_record');
  return finding({
    code: LOG_FINDING_CODES.segment,
    message: `The closure ledger cannot take a new record: ${SEGMENT_EXPLANATIONS[reason](segment.path)}${first?.line ? ` (line ${first.line})` : ''}.`,
    file: segment.path,
    line: first?.line ?? null,
    detail: { path: segment.path, reason, line: first?.line ?? null },
  });
}

function drawRecordId(taken, newId) {
  for (let attempt = 0; attempt < MAX_ID_DRAWS; attempt += 1) {
    const id = newId();
    if (!taken.has(id)) return id;
  }
  throw new TypeError('providers.runId keeps returning an ID that is already used in the closure ledger');
}

// document: valid against validateLogDocument. newId(): the record id, drawn only when the proposal is accepted.
// now(): the record timestamp.
export async function validateLogProposal({ repositoryRoot, workflowRoot, document, newId, now }) {
  const ledger = await readLog({ repositoryRoot, workflowRoot });
  const findings = ledger.segments.filter(({ problem }) => problem !== null && problem !== undefined).map(segmentFinding);
  if (findings.length === 0) {
    const closed = ledger.records.find((record) => record.kind === document.kind
      && record.subject === document.subject && record.outcome === 'DONE');
    if (closed !== undefined) {
      findings.push(finding({
        code: LOG_FINDING_CODES.duplicate,
        message: `${document.kind} ${document.subject} is already closed as DONE (${closed.path} line ${closed.line}); a closure is recorded once.`,
        file: closed.path,
        line: closed.line,
        detail: {
          kind: document.kind, subject: document.subject, outcome: document.outcome, record: closed.id, path: closed.path, line: closed.line,
        },
      }));
    }
  }
  if (findings.length > 0) {
    return { ok: false, kind: 'findings', reason: 'proposal_rejected', schema: CLOSURE_SCHEMA, findings: sorted(findings) };
  }

  const active = ledger.segments.at(-1) ?? null;
  const rotated = active !== null && active.records.length >= LOG_SEGMENT_LIMIT;
  const opensSegment = active === null || rotated;
  const number = active === null ? 1 : active.number + (rotated ? 1 : 0);
  if (number > 9999) throw new TypeError('the closure ledger has no segment number left');
  const id = drawRecordId(new Set(ledger.records.map((record) => record.id)), newId);
  const line = encodeJsonlRecord({
    id,
    ts: now(),
    kind: document.kind,
    subject: document.subject,
    outcome: document.outcome,
    deviations: document.deviations,
    operation: null,
  }, CLOSURE_SPEC);
  // The line must read back as one declared, schema-valid closure record.
  const check = decodeJsonl(line, () => CLOSURE_SPEC);
  if (!check.ok || check.records.length !== 1 || check.records[0].state !== 'declared' || !validateClosure(check.records[0].value).ok) {
    throw new TypeError('the rendered closure record does not read back as written');
  }
  const workflowPath = segmentPath(number);
  return {
    ok: true,
    document,
    record: check.records[0].value,
    segment: { number, name: segmentName(number), path: `${ledger.workflow_prefix}${workflowPath}`, rotated },
    line: opensSegment ? 1 : active.records.length + 1,
    operation: { type: opensSegment ? 'create' : 'append', path: workflowPath, content: line },
    workflowPath,
    path: `${ledger.workflow_prefix}${workflowPath}`,
    warnings: [],
    findings: [],
  };
}
