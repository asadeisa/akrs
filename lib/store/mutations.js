import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PathSafetyError } from './path-service.js';
import { compareStrings } from '../schemas/common.js';

export const NEWLINE_POLICIES = Object.freeze(['lf', 'crlf', 'none', 'mixed']);
const changeSetOperations = new WeakMap();

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function detectNewlinePolicy(bytes) {
  const text = bytes.toString('utf8');
  const lineFeeds = (text.match(/\n/g) ?? []).length;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  if (lineFeeds === 0 && !text.includes('\r')) return 'none';
  if (lineFeeds === crlf && !/(^|[^\r])\n/.test(text)) return 'crlf';
  if (crlf === 0 && !text.includes('\r')) return 'lf';
  return 'mixed';
}

function encodeText(text, newlinePolicy) {
  if (!NEWLINE_POLICIES.includes(newlinePolicy)) {
    throw new TypeError(`unknown newline policy: ${newlinePolicy}`);
  }
  if (newlinePolicy === 'mixed') {
    throw new TypeError('changed mixed-newline documents require an explicit lf or crlf policy');
  }
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (newlinePolicy === 'none' && normalized.includes('\n')) {
    throw new TypeError('none newline policy cannot encode line breaks');
  }
  return Buffer.from(newlinePolicy === 'crlf' ? normalized.replace(/\n/g, '\r\n') : normalized);
}

export async function readTextDocument(pathService, relativePath) {
  const target = await pathService.resolveRepositoryPath(relativePath, { mustExist: true });
  if (target.findings.length > 0) throw new PathSafetyError(target.findings[0].message);
  const bytes = await readFile(target.filesystem_path);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return Object.freeze({
    path: target.relative_path,
    filesystem_path: target.filesystem_path,
    bytes,
    text,
    newline_policy: detectNewlinePolicy(bytes),
    snapshot: sha256(bytes),
  });
}

export async function prepareTextChange(pathService, document, nextText, options = {}) {
  if (typeof nextText !== 'string') throw new TypeError('nextText must be a string');
  const target = await pathService.resolveRepositoryPath(document.path, { mustExist: true });
  const newlinePolicy = options.newlinePolicy ?? document.newline_policy;
  const after = nextText === document.text
    ? Buffer.from(document.bytes)
    : encodeText(nextText, newlinePolicy);
  return Object.freeze({
    kind: 'write',
    path: target.relative_path,
    filesystem_path: target.filesystem_path,
    before_bytes: Buffer.from(document.bytes),
    after_bytes: after,
    before_snapshot: document.snapshot,
    after_snapshot: sha256(after),
    newline_policy: newlinePolicy,
    changed: !document.bytes.equals(after),
  });
}

export function createChangeSet(pathService, proposedChanges) {
  if (!Array.isArray(proposedChanges)) throw new TypeError('proposedChanges must be an array');
  const changes = proposedChanges.filter(({ changed }) => changed);
  changes.sort((left, right) => compareStrings(left.path, right.path));
  const seen = new Set();
  for (const change of changes) {
    pathService.assertWritableTarget(change.path);
    if (seen.has(change.path)) throw new PathSafetyError(`duplicate writable target: ${change.path}`);
    seen.add(change.path);
  }
  const publicChanges = changes.map((change) => Object.freeze({
    kind: change.kind,
    path: change.path,
    before_snapshot: change.before_snapshot,
    after_snapshot: change.after_snapshot,
    newline_policy: change.newline_policy,
  }));
  const changeSet = Object.freeze({
    schema_version: 'akrs.change-set/v1',
    changes: Object.freeze(publicChanges),
  });
  changeSetOperations.set(changeSet, changes);
  return changeSet;
}

export async function applyChangeSet(changeSet, { dryRun = true } = {}) {
  if (dryRun) return Object.freeze({ applied: false, changes: changeSet.changes });
  const operations = changeSetOperations.get(changeSet);
  if (operations === undefined) throw new TypeError('change set was not created by this store');
  if (operations.length > 1) {
    throw new PathSafetyError('multi-file writes require the P1 recoverable transaction service');
  }
  for (const change of operations) {
    const current = await readFile(change.filesystem_path);
    if (sha256(current) !== change.before_snapshot) {
      throw new PathSafetyError(`snapshot changed before write: ${change.path}`);
    }
    await mkdir(dirname(change.filesystem_path), { recursive: true });
    await writeFile(change.filesystem_path, change.after_bytes);
  }
  return Object.freeze({ applied: true, changes: changeSet.changes });
}

function parseTableRow(line) {
  if (!line.startsWith('|') || !line.endsWith('|')) return null;
  return line.slice(1, -1).split('|').map((value) => value.trim());
}

export function replaceMarkdownTableCell(text, { keyColumn, key, column, value }) {
  if ([keyColumn, key, column, value].some((item) => typeof item !== 'string')) {
    throw new TypeError('table mutation selectors and value must be strings');
  }
  if (value.includes('|') || /[\r\n]/.test(value)) throw new TypeError('table values cannot contain pipes or newlines');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = parseTableRow(lines[index]);
    const separator = parseTableRow(lines[index + 1]);
    if (!header || !separator || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const keyIndex = header.indexOf(keyColumn);
    const valueIndex = header.indexOf(column);
    if (keyIndex === -1 || valueIndex === -1) continue;
    const matches = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const row = parseTableRow(lines[rowIndex]);
      if (!row) break;
      if (row[keyIndex] === key) matches.push({ rowIndex, row });
    }
    if (matches.length !== 1) {
      throw new PathSafetyError(`table selector must match exactly one row: ${keyColumn}=${key}`);
    }
    matches[0].row[valueIndex] = value;
    lines[matches[0].rowIndex] = `| ${matches[0].row.join(' | ')} |`;
    return lines.join(newline);
  }
  throw new PathSafetyError(`table columns not found: ${keyColumn}, ${column}`);
}

export function selectOwnedTargets(records, ownerId) {
  if (!Array.isArray(records) || typeof ownerId !== 'string') {
    throw new TypeError('records and ownerId are required');
  }
  return records
    .filter(({ owner_id: candidate }) => candidate === ownerId)
    .map((record) => ({ ...record }))
    .sort((left, right) => compareStrings(left.path, right.path));
}
