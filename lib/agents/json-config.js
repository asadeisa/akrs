// The JSON merge writers of the agent adapters (F20). JSON cannot carry a managed-block marker, so an entry is owned by recognition (see
// AGENT_POLICY.json_ownership): an entry under the key `akrs` that launches akrs.js mcp, or a hook whose command runs akrs-guard.js.
// Every function is pure: it takes the file text (null when the file is absent) and returns { state, reason, after } where `after` is the
// complete new text, or null when nothing may be written.
import { isDeepStrictEqual } from 'node:util';

const BOM = '﻿';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const result = (state, reason = null, after = null) => ({ state, reason, after });

function parseDocument(text) {
  if (text === null) return { value: {}, bom: '', newline: '\n', indent: '  ', finalNewline: true };
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = text.slice(bom.length);
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    return { error: 'unparsable_json' };
  }
  if (!isObject(value)) return { error: 'unexpected_shape' };
  const crlf = (body.match(/\r\n/g) ?? []).length;
  const lineFeeds = (body.match(/\n/g) ?? []).length - crlf;
  const margin = /\n([ \t]+)\S/.exec(body.replace(/\r\n/g, '\n'));
  let indent = '  ';
  if (margin !== null) indent = margin[1].startsWith('\t') ? '\t' : ' '.repeat(margin[1].length);
  return { value, bom, newline: crlf > lineFeeds ? '\r\n' : '\n', indent, finalNewline: body.endsWith('\n') };
}

function serialize(value, document) {
  let text = JSON.stringify(value, null, document.indent);
  if (document.finalNewline) text += '\n';
  if (document.newline === '\r\n') text = text.replace(/\n/g, '\r\n');
  return `${document.bom}${text}`;
}

const normalizedPath = (token) => token.replaceAll('\\', '/');

// An entry launches akrs.js mcp: `command` + `args`, or a `command` array (opencode).
function launchTokens(entry) {
  if (!isObject(entry)) return [];
  if (Array.isArray(entry.command)) return entry.command.filter((token) => typeof token === 'string');
  const args = Array.isArray(entry.args) ? entry.args.filter((token) => typeof token === 'string') : [];
  return typeof entry.command === 'string' ? [entry.command, ...args] : args;
}

function recognizedServer(entry) {
  const tokens = launchTokens(entry);
  return tokens.some((token, index) => /(?:^|\/)akrs\.js$/.test(normalizedPath(token)) && tokens[index + 1] === 'mcp');
}

// Walks (and, for a write, creates) the container objects; null when one on the path has another shape.
function containerOf(root, path, create) {
  let current = root;
  for (const segment of path) {
    if (current[segment] === undefined) {
      if (!create) return { missing: true };
      current[segment] = {};
    } else if (!isObject(current[segment])) {
      return null;
    }
    current = current[segment];
  }
  return { value: current };
}

export function mergeServerEntry(text, { container, key, desired, launchKeys }) {
  const document = parseDocument(text);
  if (document.error) return result('conflict', document.error);
  const probe = containerOf(document.value, container, false);
  if (probe === null) return result('conflict', 'unexpected_shape');
  const existing = probe.missing ? undefined : probe.value[key];
  if (existing === undefined) {
    containerOf(document.value, container, true).value[key] = structuredClone(desired);
    return result('missing', null, serialize(document.value, document));
  }
  if (isDeepStrictEqual(existing, desired)) return result('current');
  if (!recognizedServer(existing)) return result('conflict', 'unmanaged_entry');
  const keys = new Set([...Object.keys(existing), ...Object.keys(desired)]);
  for (const name of keys) {
    if (launchKeys.includes(name)) continue;
    if (!isDeepStrictEqual(existing[name], desired[name]) || Object.hasOwn(existing, name) !== Object.hasOwn(desired, name)) {
      return result('hand_modified', 'hand_modified_entry');
    }
  }
  probe.value[key] = structuredClone(desired);
  return result('outdated', null, serialize(document.value, document));
}

const isGuardHook = (hook) => isObject(hook) && typeof hook.command === 'string' && hook.command.includes('akrs-guard.js');
const recognizedHookItem = (item) => isObject(item) && Array.isArray(item.hooks) && item.hooks.some(isGuardHook);

// The Claude Code PreToolUse entry: hooks.PreToolUse is an array of { matcher, hooks: [{ type, command }] }.
export function mergeHookEntry(text, { desired }) {
  const document = parseDocument(text);
  if (document.error) return result('conflict', document.error);
  const { value } = document;
  if (value.hooks !== undefined && !isObject(value.hooks)) return result('conflict', 'unexpected_shape');
  if (value.hooks?.PreToolUse !== undefined && !Array.isArray(value.hooks.PreToolUse)) return result('conflict', 'unexpected_shape');
  const list = value.hooks?.PreToolUse ?? [];
  const index = list.findIndex(recognizedHookItem);
  if (index === -1) {
    if (value.hooks === undefined) value.hooks = {};
    value.hooks.PreToolUse = [...list, structuredClone(desired)];
    return result('missing', null, serialize(value, document));
  }
  const item = list[index];
  if (isDeepStrictEqual(item, desired)) return result('current');
  const command = desired.hooks[0].command;
  const normalized = { ...item, hooks: item.hooks.map((hook) => (isGuardHook(hook) ? { ...hook, command } : hook)) };
  if (!isDeepStrictEqual(normalized, desired)) return result('hand_modified', 'hand_modified_entry');
  list[index] = structuredClone(desired);
  return result('outdated', null, serialize(value, document));
}
