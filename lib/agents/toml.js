// A minimal, zero-dependency TOML writer for the one thing the Codex adapter needs: render a table of strings, booleans, integers and string
// arrays, and find whether a file already defines a table path (so a managed block is never added beside a definition that would make the
// file invalid). This is not a TOML parser: it reads table headers and key names only, never values.

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function tomlString(value) {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0);
    if (char === '"') out += '\\"';
    else if (char === '\\') out += '\\\\';
    else if (char === '\n') out += '\\n';
    else if (char === '\t') out += '\\t';
    else if (char === '\r') out += '\\r';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += char;
  }
  return `${out}"`;
}

export function tomlValue(value) {
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Number.isInteger(value)) return String(value);
  if (Array.isArray(value)) {
    if (value.some((item) => Array.isArray(item))) throw new TypeError('nested arrays are not supported');
    return `[${value.map(tomlValue).join(', ')}]`;
  }
  throw new TypeError(`unsupported TOML value: ${String(value)}`);
}

const tomlKey = (key) => (BARE_KEY.test(key) ? key : tomlString(key));

export function renderTomlTable(path, values) {
  if (!Array.isArray(path) || path.length === 0) throw new TypeError('a table path needs at least one key');
  const lines = [`[${path.map(tomlKey).join('.')}]`];
  for (const [key, value] of Object.entries(values)) lines.push(`${tomlKey(key)} = ${tomlValue(value)}`);
  return `${lines.join('\n')}\n`;
}

// Parses one key (bare, "basic" or 'literal') starting at index; returns { key, end } or null.
function parseKey(text, start) {
  let index = start;
  while (text[index] === ' ' || text[index] === '\t') index += 1;
  const first = text[index];
  if (first === '"') {
    let key = '';
    index += 1;
    while (index < text.length && text[index] !== '"') {
      if (text[index] === '\\' && index + 1 < text.length) {
        key += text[index + 1];
        index += 2;
      } else {
        key += text[index];
        index += 1;
      }
    }
    return index < text.length ? { key, end: index + 1 } : null;
  }
  if (first === "'") {
    const close = text.indexOf("'", index + 1);
    return close === -1 ? null : { key: text.slice(index + 1, close), end: close + 1 };
  }
  const match = /^[A-Za-z0-9_-]+/.exec(text.slice(index));
  return match === null ? null : { key: match[0], end: index + match[0].length };
}

// Parses a dotted key path; returns { keys, end } or null.
function parseKeyPath(text, start) {
  const keys = [];
  let index = start;
  for (;;) {
    const parsed = parseKey(text, index);
    if (parsed === null) return null;
    keys.push(parsed.key);
    index = parsed.end;
    while (text[index] === ' ' || text[index] === '\t') index += 1;
    if (text[index] !== '.') return { keys, end: index };
    index += 1;
  }
}

// Scans one line outside a multi-line string; returns the multi-line delimiter still open at the end of the line, or null.
function openMultiline(line, from, open) {
  let index = from;
  let state = open;
  while (index < line.length) {
    if (state === '"""' || state === "'''") {
      const close = line.indexOf(state, index);
      if (close === -1) return state;
      index = close + 3;
      state = null;
      continue;
    }
    const char = line[index];
    if (char === '#') return null;
    if (line.startsWith('"""', index)) {
      state = '"""';
      index += 3;
    } else if (line.startsWith("'''", index)) {
      state = "'''";
      index += 3;
    } else if (char === '"') {
      index += 1;
      while (index < line.length && line[index] !== '"') index += line[index] === '\\' ? 2 : 1;
      index += 1;
    } else if (char === "'") {
      const close = line.indexOf("'", index + 1);
      index = close === -1 ? line.length : close + 1;
    } else {
      index += 1;
    }
  }
  return state;
}

const startsWithPath = (keys, path) => keys.length >= path.length && path.every((key, index) => keys[index] === key);

// The first definition of `path` (the table, a sub-table, a dotted or inline key) in the document, or null: { line, kind } with kind
// table | key | dotted_key | inline and a 1-based line.
export function findTomlDefinition(text, path) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let table = [];
  let multiline = null;
  for (let number = 1; number <= lines.length; number += 1) {
    const line = lines[number - 1];
    const wasOpen = multiline !== null;
    const afterString = (from) => { multiline = openMultiline(line, from, multiline); };
    if (wasOpen) {
      afterString(0);
      continue;
    }
    let start = 0;
    while (line[start] === ' ' || line[start] === '\t') start += 1;
    if (line[start] === undefined || line[start] === '#') continue;
    if (line[start] === '[') {
      const array = line[start + 1] === '[';
      const parsed = parseKeyPath(line, start + (array ? 2 : 1));
      if (parsed !== null && line[parsed.end] === ']') {
        table = parsed.keys;
        if (startsWithPath(table, path)) return { line: number, kind: 'table' };
      }
      continue;
    }
    const parsed = parseKeyPath(line, start);
    if (parsed !== null && line[parsed.end] === '=') {
      const full = [...table, ...parsed.keys];
      if (startsWithPath(full, path)) return { line: number, kind: table.length === 0 ? 'dotted_key' : 'key' };
      const value = line.slice(parsed.end + 1).trim();
      if (full.length < path.length && startsWithPath(path, full) && value.startsWith('{')) {
        const wanted = path[full.length];
        const pattern = new RegExp(`[{,]\\s*(?:"${wanted}"|'${wanted}'|${wanted})\\s*[.=]`);
        if (pattern.test(value)) return { line: number, kind: 'inline' };
      }
      afterString(parsed.end + 1);
    } else {
      afterString(start);
    }
  }
  return null;
}
