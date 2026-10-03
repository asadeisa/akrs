import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { dirname } from 'node:path';
import { PathSafetyError } from './path-service.js';

// Marker grammar (closed). One marker per line, starting in column 0, nothing after it:
//   html: <!-- akrs:begin <id> sha256=<hex> -->   <!-- akrs:end <id> -->
//   hash: # akrs:begin <id> sha256=<hex>          # akrs:end <id>
// <id> = [a-z][a-z0-9]*([-.][a-z0-9]+)*, at most 64 characters. <hex> = lowercase SHA-256 of the
// block body with CRLF normalized to LF. The body is every line between the two markers.
// Any other line that opens like a marker in the requested style is an invalid_marker conflict.
// Writes never replace a file that appeared after planning: a new file is placed with link()/exclusive copy and
// loses to a concurrent creator with the target_created_concurrently conflict (the other file stays intact).
export const MANAGED_BLOCK_STYLES = Object.freeze(['html', 'hash']);
export const MANAGED_BLOCK_OUTCOMES = Object.freeze(['created', 'updated', 'unchanged', 'conflict']);
export const MANAGED_BLOCK_CONFLICTS = Object.freeze([
  'content_edited',
  'duplicate_block',
  'invalid_encoding',
  'invalid_marker',
  'mismatched_markers',
  'nested_markers',
  'target_created_concurrently',
  'unbalanced_markers',
]);
const POSITIONS = Object.freeze(['end', 'start']);
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK']);
const ID_PATTERN = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const BOM = '﻿';

const GRAMMAR = Object.freeze({
  html: Object.freeze({
    begin: /^<!-- akrs:begin (\S+) sha256=(\S+) -->$/,
    end: /^<!-- akrs:end (\S+) -->$/,
    candidate: /^\s*<!--\s*akrs:/,
    render: (verb, text) => `<!-- akrs:${verb} ${text} -->`,
  }),
  hash: Object.freeze({
    begin: /^# akrs:begin (\S+) sha256=(\S+)$/,
    end: /^# akrs:end (\S+)$/,
    candidate: /^\s*#\s*akrs:/,
    render: (verb, text) => `# akrs:${verb} ${text}`,
  }),
});

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');
const sha256 = (bytes) => `sha256:${sha256Hex(bytes)}`;

function normalizeContent(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  return normalized === '' || normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

export function hashManagedContent(content) {
  if (typeof content !== 'string') throw new TypeError('content must be a string');
  return sha256Hex(normalizeContent(content));
}

function checkOptions(text, { id, style, content, position = 'end' }) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (!MANAGED_BLOCK_STYLES.includes(style)) throw new TypeError(`unknown managed-block style: ${style}`);
  if (typeof id !== 'string' || id.length > 64 || !ID_PATTERN.test(id)) {
    throw new TypeError(`invalid managed-block id: ${String(id)}`);
  }
  if (typeof content !== 'string') throw new TypeError('content must be a string');
  if (!POSITIONS.includes(position)) throw new TypeError(`unknown managed-block position: ${position}`);
  const normalized = normalizeContent(content);
  if (normalized.split('\n').some((line) => GRAMMAR[style].candidate.test(line))) {
    throw new TypeError('content cannot contain lines that look like managed-block markers');
  }
  return { id, style, position, normalized };
}

function splitLines(text) {
  const lines = [];
  let start = 0;
  while (start < text.length) {
    const lineFeed = text.indexOf('\n', start);
    const end = lineFeed === -1 ? text.length : lineFeed + 1;
    const contentEnd = lineFeed === -1 ? end : (text[lineFeed - 1] === '\r' && lineFeed > start ? lineFeed - 1 : lineFeed);
    lines.push({
      number: lines.length + 1,
      start,
      contentStart: lines.length === 0 && text.startsWith(BOM) ? start + 1 : start,
      contentEnd,
      end,
      terminator: text.slice(contentEnd, end),
    });
    start = end;
  }
  return lines;
}

function scan(text, style) {
  const grammar = GRAMMAR[style];
  const blocks = [];
  const seen = new Set();
  const stack = [];
  const fail = (reason, line) => ({ error: { reason, line }, blocks });

  for (const line of splitLines(text)) {
    const content = text.slice(line.contentStart, line.contentEnd);
    const begin = grammar.begin.exec(content);
    const end = begin ? null : grammar.end.exec(content);
    if (begin) {
      if (!ID_PATTERN.test(begin[1]) || begin[1].length > 64 || !HASH_PATTERN.test(begin[2])) {
        return fail('invalid_marker', line.number);
      }
      if (stack.length > 0) return fail('nested_markers', line.number);
      if (seen.has(begin[1])) return fail('duplicate_block', line.number);
      seen.add(begin[1]);
      stack.push({ id: begin[1], hash: begin[2], begin: line });
    } else if (end) {
      if (!ID_PATTERN.test(end[1]) || end[1].length > 64) return fail('invalid_marker', line.number);
      if (stack.length === 0) return fail('unbalanced_markers', line.number);
      const open = stack.pop();
      if (open.id !== end[1]) return fail('mismatched_markers', line.number);
      blocks.push({ id: open.id, hash: open.hash, begin: open.begin, end: line });
    } else if (grammar.candidate.test(content)) {
      return fail('invalid_marker', line.number);
    }
  }
  if (stack.length > 0) return fail('unbalanced_markers', stack[0].begin.number);
  return { error: null, blocks };
}

function detectNewline(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lineFeeds = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lineFeeds ? '\r\n' : '\n';
}

function result(outcome, text, reason = null, line = null) {
  return Object.freeze({ outcome, text, reason, line });
}

export function applyManagedBlock(text, options) {
  const { id, style, position, normalized } = checkOptions(text, options ?? {});
  const grammar = GRAMMAR[style];
  const hash = sha256Hex(normalized);
  const scanned = scan(text, style);
  if (scanned.error) return result('conflict', text, scanned.error.reason, scanned.error.line);

  const existing = scanned.blocks.find((block) => block.id === id);
  if (existing) {
    const body = text.slice(existing.begin.end, existing.end.start);
    if (sha256Hex(body.replace(/\r\n/g, '\n')) !== existing.hash) {
      return result('conflict', text, 'content_edited', existing.begin.number);
    }
    if (existing.hash === hash) return result('unchanged', text);
    const newline = existing.begin.terminator;
    const marker = grammar.render('begin', `${id} sha256=${hash}`);
    const updated = text.slice(0, existing.begin.contentStart)
      + marker
      + newline
      + normalized.replace(/\n/g, newline)
      + text.slice(existing.end.start);
    return result('updated', updated);
  }

  const newline = detectNewline(text);
  const lines = [
    grammar.render('begin', `${id} sha256=${hash}`),
    ...(normalized === '' ? [] : normalized.slice(0, -1).split('\n')),
    grammar.render('end', id),
  ];
  const block = lines.join(newline);
  const bom = text.startsWith(BOM) ? BOM : '';
  const core = text.slice(bom.length);
  if (core === '') return result('created', `${bom}${block}${newline}`);
  if (position === 'start') return result('created', `${bom}${block}${newline}${core}`);
  const terminated = core.endsWith('\n');
  return result('created', `${text}${terminated ? '' : newline}${block}${terminated ? newline : ''}`);
}

async function placeWithoutReplacing(fs, temporary, destination) {
  try {
    await fs.link(temporary, destination);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    if (!LINK_UNSUPPORTED.has(error?.code)) throw error;
  }
  try {
    await fs.copyFile(temporary, destination, constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

export async function applyManagedBlockToFile(pathService, relativePath, options = {}) {
  const { dryRun = true, fsOps = {}, ...blockOptions } = options;
  const fs = { ...nodeFs, ...fsOps };
  pathService.assertWritableTarget(relativePath);
  const target = await pathService.resolveRepositoryPath(relativePath);
  if (target.findings.length > 0) throw new PathSafetyError(target.findings[0].message);

  let before = null;
  let mode = null;
  if (target.exists) {
    mode = await fs.lstat(target.filesystem_path);
    if (!mode.isFile()) {
      throw new PathSafetyError(`managed-block target is not a regular file: ${target.relative_path}`);
    }
    before = await fs.readFile(target.filesystem_path);
  }
  const beforeSnapshot = before === null ? null : sha256(before);
  const report = (outcome, reason, line, applied, changed, afterSnapshot) => Object.freeze({
    path: target.relative_path,
    outcome,
    reason,
    line,
    applied,
    changed,
    before_snapshot: beforeSnapshot,
    after_snapshot: afterSnapshot,
  });

  let text = '';
  if (before !== null) {
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(before);
    } catch {
      checkOptions('', blockOptions);
      return report('conflict', 'invalid_encoding', null, false, false, beforeSnapshot);
    }
  }
  const outcome = applyManagedBlock(text, blockOptions);
  const changed = outcome.outcome === 'created' || outcome.outcome === 'updated';
  if (!changed) {
    return report(outcome.outcome, outcome.reason, outcome.line, false, false, beforeSnapshot);
  }
  const after = Buffer.from(outcome.text);
  const afterSnapshot = sha256(after);
  if (dryRun) return report(outcome.outcome, null, null, false, true, afterSnapshot);

  const slash = target.relative_path.lastIndexOf('/');
  const directory = slash === -1 ? '' : target.relative_path.slice(0, slash + 1);
  const name = target.relative_path.slice(slash + 1);
  const sibling = await pathService.resolveRepositoryPath(
    `${directory}.${name}.akrs-tmp-${randomBytes(6).toString('hex')}`,
  );
  const temporary = sibling.filesystem_path;
  const unchanged = async () => {
    const current = target.exists ? sha256(await fs.readFile(target.filesystem_path)) : null;
    if (current !== beforeSnapshot) {
      throw new PathSafetyError(`snapshot changed before write: ${target.relative_path}`);
    }
  };
  let placed = true;
  try {
    await fs.mkdir(dirname(target.filesystem_path), { recursive: true });
    await fs.writeFile(temporary, after, { flag: 'wx' });
    if (mode !== null) await fs.chmod(temporary, mode.mode & 0o7777);
    if (target.exists) {
      await unchanged();
      await fs.rename(temporary, target.filesystem_path);
    } else {
      placed = await placeWithoutReplacing(fs, temporary, target.filesystem_path);
    }
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  await fs.rm(temporary, { force: true });
  if (!placed) return report('conflict', 'target_created_concurrently', null, false, false, beforeSnapshot);
  return report(outcome.outcome, null, null, true, true, afterSnapshot);
}
