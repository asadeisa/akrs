// Markdown record codec (F4, Q18): a table with one row per record and a hidden id/hash marker
// `<!-- akrs:record <ULID> sha256:<hex> -->` at the end of the last cell. Render/parse only; schema
// validation of the record lives in the artifact schemas.
//
// spec = { columns: [{ key, header, kind: 'text' | 'json' }] }; record = { id, <column keys...> }.
// Cell escapes (lossless): \\ for backslash, \| for pipe, \< for <, <br> for a line feed.
import { SNAPSHOT_PATTERN, isUlid } from '../../schemas/common.js';
import { contentHash } from './hash.js';
import { MAX_DEPTH, parseStrictJson } from './strict-json.js';

const KINDS = ['text', 'json'];
const MARKER = /^(.*) <!-- akrs:record (\S+) (\S+) -->$/s;
const MARKER_OPEN = '<!-- akrs:record ';

function checkSpec(spec) {
  const columns = spec?.columns;
  if (!Array.isArray(columns) || columns.length === 0) throw new TypeError('invalid markdown spec: columns are required');
  const keys = new Set();
  const headers = new Set();
  for (const column of columns) {
    const valid = column !== null && typeof column === 'object'
      && typeof column.key === 'string' && /^[a-z][a-z0-9_]*$/.test(column.key) && column.key !== 'id'
      && typeof column.header === 'string' && column.header !== '' && !/[|\n\r<\\]/.test(column.header)
      && KINDS.includes(column.kind);
    if (!valid || keys.has(column.key) || headers.has(column.header)) {
      throw new TypeError('invalid markdown spec: bad or duplicate column');
    }
    keys.add(column.key);
    headers.add(column.header);
  }
  return columns;
}

function hasLoneSurrogate(text) {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// Each JSON cell is parsed on its own by the strict reader (root = level 1, cap 64), so the writer applies the same cap.
function checkedJson(value, path = '$', level = 1) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) throw new TypeError(`lone surrogate at ${path}`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new TypeError(`not a canonical integer at ${path}`);
    return value;
  }
  if (Array.isArray(value)) {
    if (level > MAX_DEPTH) throw new TypeError(`value too deep at ${path}`);
    return value.map((item, index) => checkedJson(item, `${path}[${index}]`, level + 1));
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    if (level > MAX_DEPTH) throw new TypeError(`value too deep at ${path}`);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, checkedJson(item, `${path}.${key}`, level + 1)]));
  }
  throw new TypeError(`not a JSON value at ${path}`);
}

function escapeCell(text) {
  if (typeof text !== 'string') throw new TypeError('a text cell requires a string');
  if (text.includes('\r')) throw new TypeError('carriage returns are not allowed in cells');
  if (text.includes('\u0000')) throw new TypeError('NUL is not allowed in cells');
  if (hasLoneSurrogate(text)) throw new TypeError('lone surrogate in cell');
  return text.replace(/[\\|<\n]/g, (character) => (character === '\n' ? '<br>' : `\\${character}`));
}

function unescapeCell(text) {
  return text.replace(/\\([\\|<])|<br>/g, (match, escaped) => (escaped === undefined ? '\n' : escaped));
}

function splitRow(line) {
  const pieces = [];
  let current = '';
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '\\' && index + 1 < line.length) {
      current += character + line[index + 1];
      index += 1;
    } else if (character === '|') {
      pieces.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  pieces.push(current);
  return pieces;
}

const headerLine = (columns) => `| ${columns.map(({ header }) => header).join(' | ')} |`;
const separatorLine = (columns) => `|${'---|'.repeat(columns.length)}`;
const rowHash = (id, rawCells) => contentHash([id, ...rawCells].join('\n'));

export function renderMarkdownHeader(spec) {
  const columns = checkSpec(spec);
  return `${headerLine(columns)}\n${separatorLine(columns)}\n`;
}

export function renderMarkdownRecord(record, spec) {
  const columns = checkSpec(spec);
  if (record === null || typeof record !== 'object') throw new TypeError('record must be an object');
  const allowed = ['id', ...columns.map(({ key }) => key)];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new TypeError(`unknown key: ${key}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(record, key)) throw new TypeError(`missing key: ${key}`);
  }
  if (!isUlid(record.id)) throw new TypeError('record id must be a ULID');
  const cells = columns.map(({ key, kind }) => escapeCell(
    kind === 'text'
      ? record[key]
      : JSON.stringify(checkedJson(record[key])).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029'),
  ));
  const hash = rowHash(record.id, cells);
  cells[cells.length - 1] += ` <!-- akrs:record ${record.id} ${hash} -->`;
  return `| ${cells.join(' | ')} |\n`;
}

export function parseMarkdownRecords(text, spec) {
  const columns = checkSpec(spec);
  const issues = [];
  const records = [];
  const lines = String(text).replaceAll('\r\n', '\n').split('\n');
  const start = lines.findIndex((line, index) => line === headerLine(columns) && lines[index + 1] === separatorLine(columns));
  if (start === -1) {
    return { ok: false, records, issues: [{ path: '$', code: 'missing_header', message: 'record table header not found' }] };
  }
  const seen = new Set();
  let tableEnd = start + 2;
  while (tableEnd < lines.length && lines[tableEnd].startsWith('|')) tableEnd += 1;
  // Records must never be dropped silently: anything outside the table that looks like a record is reported.
  lines.forEach((text, index) => {
    const outside = index < start || index >= tableEnd;
    if (outside && (text.includes(MARKER_OPEN) || (index >= tableEnd && text.startsWith('|')))) {
      issues.push({ path: '$', line: index + 1, code: 'row_outside_table', message: 'record row or marker outside the record table' });
    }
  });
  for (let index = start + 2; index < tableEnd; index += 1) {
    const line = index + 1;
    const report = (code, message) => issues.push({ path: '$', line, code, message });
    const pieces = splitRow(lines[index]);
    const inner = pieces.slice(1, -1);
    const wellFormed = pieces.length >= 3 && pieces[0] === '' && pieces.at(-1) === ''
      && inner.every((cell) => cell.length >= 2 && cell.startsWith(' ') && cell.endsWith(' '));
    if (!wellFormed || inner.length !== columns.length) {
      report('invalid_row', 'row does not match the column layout');
      continue;
    }
    const cells = inner.map((cell) => cell.slice(1, -1));
    const marker = MARKER.exec(cells.at(-1));
    if (!marker) {
      report('missing_marker', 'row has no id/hash marker');
      continue;
    }
    const [, last, id, hash] = marker;
    if (!isUlid(id) || !SNAPSHOT_PATTERN.test(hash)) {
      report('invalid_marker', 'row marker is malformed');
      continue;
    }
    cells[cells.length - 1] = last;
    const value = { id };
    let decodable = true;
    columns.forEach(({ key, kind }, column) => {
      const raw = unescapeCell(cells[column]);
      if (kind === 'text') {
        value[key] = raw;
        return;
      }
      const parsed = parseStrictJson(raw);
      if (parsed.ok) {
        value[key] = parsed.value;
      } else {
        decodable = false;
        report('invalid_json', `column ${key}: ${parsed.issues[0].message}`);
      }
    });
    const state = rowHash(id, cells) === hash ? 'declared' : 'unverified';
    if (state === 'unverified') report('unverified_record', 'row hash does not match its content');
    if (!decodable) continue;
    if (seen.has(id)) {
      report('duplicate_record_id', `duplicate record id: ${id}`);
      continue;
    }
    seen.add(id);
    records.push({ value, line, state });
  }
  return { ok: issues.length === 0, records, issues };
}
