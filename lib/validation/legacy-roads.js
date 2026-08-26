import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

function statusWord(text) {
  const match = text.match(/^\s*Status:\s*(.+)\s*$/im);
  if (!match) return null;
  const raw = match[1].trim();
  if (/^ACTIVE$/i.test(raw)) return { word: 'ACTIVE', raw, legal: true };
  if (/^QUEUED$/i.test(raw)) return { word: 'QUEUED', raw, legal: true };
  if (/^DONE\b/i.test(raw)) {
    return { word: 'DONE', raw, legal: /superseded by\s+\S/i.test(raw) };
  }
  return { word: raw.split(/\s+/)[0].toUpperCase(), raw, legal: false };
}

function statusLine(text) {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => /^\s*Status:/i.test(line));
  return index < 0 ? null : index + 1;
}

// These two parsers intentionally preserve v1 characterization. They are not v2 contracts.
function legacyExpectedFiles(text) {
  const lines = text.split(/\r?\n/);
  const files = [];
  let capture = false;
  for (const line of lines) {
    if (/expected files/i.test(line)) {
      capture = true;
      continue;
    }
    if (!capture) continue;
    if (/^\s*#{1,6}\s/.test(line)) break;
    if (/^\s*$/.test(line) && files.length) break;
    const match = line.match(/^\s*[-*]\s+(.+)$/);
    if (match) {
      const token = match[1].replace(/`/g, '').trim().split(/\s+/)[0];
      if (token) files.push(token);
    } else if (files.length) {
      break;
    }
  }
  return files;
}

function legacyDependencyIds(text) {
  const match = text.match(/^\s*Deps:\s*(.+)\s*$/im);
  if (!match) return [];
  return match[1]
    .split(/[,\s]+/)
    .map((value) => value.replace(/`/g, '').replace(/\.md$/i, '').trim())
    .filter(Boolean)
    .filter((value) => !/^none$/i.test(value));
}

export async function loadLegacyRoads({ pathService }) {
  const files = (await pathService.walkWorkflowFiles('roads'))
    .filter((path) => path.toLowerCase().endsWith('.md'))
    .filter((path) => basename(path).toLowerCase() !== 'readme.md');
  const roads = [];
  for (const file of files) {
    const path = await pathService.resolveRepositoryPath(file, { mustExist: true });
    let text = '';
    let readable = true;
    try {
      text = await readFile(path.filesystem_path, 'utf8');
    } catch {
      readable = false;
    }
    const status = statusWord(text);
    roads.push({
      id: basename(file).replace(/\.md$/i, ''),
      file,
      line: statusLine(text),
      readable,
      status: status?.word ?? null,
      status_raw: status?.raw ?? null,
      status_legal: status?.legal ?? false,
      deps: legacyDependencyIds(text),
      expected: legacyExpectedFiles(text),
    });
  }
  return roads;
}
