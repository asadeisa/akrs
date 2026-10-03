// Internal read-window projection (used later by `road-details`): the Road's declared reads, in declared order,
// each with how it resolves against the repository today. File contents are never part of the result unless the
// caller asks for them with `includeText`, and then they are transient text for the caller to use, never stored.
//
// Status vocabulary (READ_WINDOW_STATUSES) is the snapshot engine's: missing, not_file, not_text, out_of_range,
// case_mismatch, unsafe; plus `ok` and `own_write` (the file is inside the Road's own writes and does not exist
// yet, so there is nothing to resolve). Lines are counted like the engine does: CRLF is one break, a trailing
// newline adds no line.
import { readFile, stat } from 'node:fs/promises';
import { inspectPath, pathOverlap } from '../../schemas/glob.js';
import { PathSafetyError, createPathService } from '../path-service.js';

const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodeText(bytes) {
  if (bytes.includes(0)) return null;
  try {
    return DECODER.decode(bytes);
  } catch {
    return null;
  }
}

export function splitLines(text) {
  if (text === '') return [];
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function ownWritePatterns(writes) {
  const patterns = [];
  for (const { path, class: pathClass } of writes) {
    if (pathClass === 'dir') patterns.push(`${path}/**`);
    else if (pathClass === 'ephemeral') patterns.push(path, `${path}/**`);
    else patterns.push(path);
  }
  return patterns;
}

const withinOwnWrites = (patterns, path) => patterns.some((pattern) => pathOverlap(path, pattern) === 'overlap');

function checkRoad(road) {
  if (road === null || typeof road !== 'object' || !Array.isArray(road.reads)) throw new TypeError('road.reads must be an array');
  const writes = road.writes ?? [];
  if (!Array.isArray(writes)) throw new TypeError('road.writes must be an array');
  for (const entry of road.reads) {
    if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') throw new TypeError('every read needs a path');
  }
  return writes.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string');
}

export async function projectReadWindows({ repositoryRoot, workflowRoot, road, includeText = false } = {}) {
  const writes = checkRoad(road);
  const patterns = ownWritePatterns(writes);
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const projected = [];

  for (const [index, read] of road.reads.entries()) {
    const { path } = read;
    const lines = read.lines ?? null;
    const why = read.why ?? null;
    const entry = { index, path, lines, why, kind: lines === null ? 'file' : 'window', status: 'ok', line_count: null };
    projected.push(entry);
    if (lines === null && inspectPath(path).class === 'glob') {
      entry.kind = 'glob';
      continue;
    }
    let resolved;
    try {
      resolved = await service.resolveRepositoryPath(path);
    } catch (error) {
      if (!(error instanceof PathSafetyError)) throw error;
      entry.status = 'unsafe';
      continue;
    }
    if (!resolved.case_matches) {
      entry.status = 'case_mismatch';
      continue;
    }
    if (!resolved.exists) {
      entry.status = withinOwnWrites(patterns, path) ? 'own_write' : 'missing';
      continue;
    }
    if ((await stat(resolved.filesystem_path)).isDirectory()) {
      if (lines === null) entry.kind = 'dir';
      else entry.status = 'not_file';
      continue;
    }
    const text = decodeText(await readFile(resolved.filesystem_path));
    if (text === null) {
      if (lines !== null) entry.status = 'not_text';
      continue;
    }
    const all = splitLines(text);
    entry.line_count = all.length;
    if (lines !== null && lines[1] > all.length) {
      entry.status = 'out_of_range';
      continue;
    }
    if (includeText) entry.text = lines === null ? all.join('\n') : all.slice(lines[0] - 1, lines[1]).join('\n');
  }
  return projected;
}
