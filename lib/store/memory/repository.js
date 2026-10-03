// Memory reader API (for P1-W13 validation and every later reader). Memory files are parsed with the same codec the
// writer uses, so no second syntax exists. Every record is `declared` or `unverified`: a hash mismatch, or content
// that breaks the closed record schema, is unverified and never accepted silently. Arbitrary prose is never scanned:
// a file without the canonical table has no records and is reported as unstructured.
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { compareStrings, isId } from '../../schemas/common.js';
import { MEMORY_RECORD_SPEC, validateMemoryRecord } from '../../schemas/memory.js';
import { toJsonPointer } from '../../schemas/primitives.js';
import { parseMarkdownRecords } from '../canonical/index.js';
import { PathSafetyError, createPathService } from '../path-service.js';
import { markerOfRow } from './codec.js';
import { memoryPath } from './paths.js';
import { MEMORY_DIRECTORY } from './policy.js';

const MARKDOWN_EXTENSION = '.md';
const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function decodeMemoryBytes(bytes) {
  if (bytes.includes(0)) return null;
  try {
    return DECODER.decode(bytes).replace(/^﻿/, '');
  } catch {
    return null;
  }
}

// text -> { structured, ok, issues, records }. `structured` is false when the canonical table header is absent.
// record = { id, topic, path, line, hash, label, decided_by, owner_plan, text, pointers, meta_state, issues }
// where `issues` is [{ code: 'unverified_record' | 'schema_violation', message, pointer }].
export function parseMemoryText(text, { topic = null, path = null } = {}) {
  const source = String(text).replace(/^﻿/, '');
  const parsed = parseMarkdownRecords(source, MEMORY_RECORD_SPEC);
  if (parsed.issues.some(({ code }) => code === 'missing_header')) {
    return { structured: false, ok: false, issues: parsed.issues.map((entry) => ({ ...entry })), records: [] };
  }
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const issues = parsed.issues.map((entry) => ({ ...entry }));
  const records = parsed.records.map(({ value, line, state }) => {
    const recordIssues = [];
    if (state !== 'declared') {
      recordIssues.push({ code: 'unverified_record', message: 'the row hash does not match its content', pointer: null });
    }
    for (const { path: issuePath, message } of validateMemoryRecord(value).issues) {
      const pointer = toJsonPointer(issuePath);
      recordIssues.push({ code: 'schema_violation', message, pointer });
      issues.push({ path: '$', line, code: 'schema_violation', message: `${message} (at ${pointer === '' ? '/' : pointer})`, record: value.id, pointer });
    }
    return {
      id: value.id,
      topic,
      path,
      line,
      hash: markerOfRow(lines[line - 1])?.hash ?? null,
      label: value.label,
      decided_by: value.decided_by,
      owner_plan: value.owner_plan,
      text: value.text,
      pointers: value.pointers,
      meta_state: recordIssues.length === 0 ? 'declared' : 'unverified',
      issues: recordIssues,
    };
  });
  return { structured: true, ok: parsed.ok && records.every(({ meta_state: state }) => state === 'declared'), issues, records };
}

const byTopic = (left, right) => compareStrings(left.topic, right.topic) || compareStrings(left.path, right.path);

// Every top-level memory/*.md file, sorted by topic: [{ topic, path, workflow_path }]. Nested folders are not topics.
export async function listMemoryFiles({ repositoryRoot, workflowRoot }) {
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const prefix = service.workflow_relative_path === '' ? '' : `${service.workflow_relative_path}/`;
  const directory = `${prefix}${MEMORY_DIRECTORY}/`;
  return (await service.walkWorkflowFiles(MEMORY_DIRECTORY))
    .filter((path) => path.startsWith(directory) && path.endsWith(MARKDOWN_EXTENSION)
      && !path.slice(directory.length).includes('/') && path.length > directory.length + MARKDOWN_EXTENSION.length)
    .map((path) => ({ topic: basename(path).slice(0, -MARKDOWN_EXTENSION.length), path, workflow_path: path.slice(prefix.length) }))
    .sort(byTopic);
}

async function readEntry(service, entry) {
  const base = { topic: entry.topic, path: entry.path, workflow_path: entry.workflow_path };
  let resolved;
  try {
    resolved = await service.resolveRepositoryPath(entry.path);
  } catch (error) {
    if (!(error instanceof PathSafetyError)) throw error;
    return {
      ...base, structured: false, ok: false, issues: [{ path: '$', code: 'unsafe_path', message: error.message }], records: [],
    };
  }
  const text = decodeMemoryBytes(await readFile(resolved.filesystem_path));
  if (text === null) {
    return {
      ...base,
      structured: false,
      ok: false,
      issues: [{ path: '$', code: 'not_text', message: `${entry.path} is not UTF-8 text` }],
      records: [],
    };
  }
  return { ...base, ...parseMemoryText(text, { topic: entry.topic, path: entry.path }) };
}

// The parsed file of one topic, or null when there is none.
export async function readMemoryFile({ repositoryRoot, workflowRoot, topic }) {
  if (!isId(topic)) throw new TypeError('topic must be a valid ID');
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const workflowPath = memoryPath(topic);
  let resolved;
  try {
    resolved = await service.resolveWorkflowPath(workflowPath);
  } catch (error) {
    if (!(error instanceof PathSafetyError)) throw error;
    return null;
  }
  if (!resolved.exists || !resolved.case_matches || !(await stat(resolved.filesystem_path)).isFile()) return null;
  return readEntry(service, { topic, path: resolved.actual_relative_path, workflow_path: workflowPath });
}

// Everything: { files, records, facts, unknown, unverified, issues }.
//   facts      declared Decided and Assumption records only (an Unknown is never a fact);
//   unknown    every Unknown record, declared or unverified, with its owner Plan;
//   unverified every record that is not declared;
//   issues     the file-level issues of every file, each with its file and topic.
export async function readMemory({ repositoryRoot, workflowRoot }) {
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const files = [];
  for (const entry of await listMemoryFiles({ repositoryRoot, workflowRoot })) files.push(await readEntry(service, entry));
  const records = files.flatMap((file) => file.records);
  return {
    files,
    records,
    facts: records.filter(({ label, meta_state: state }) => label !== 'Unknown' && state === 'declared'),
    unknown: records.filter(({ label }) => label === 'Unknown'),
    unverified: records.filter(({ meta_state: state }) => state !== 'declared'),
    issues: files.flatMap((file) => file.issues.map((issue) => ({ file: file.path, topic: file.topic, ...issue }))),
  };
}
