// The JSON merge writers: a server entry under a container key, and the Claude Code PreToolUse hook entry. Ownership is by recognition.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeHookEntry, mergeServerEntry } from '../../lib/agents/json-config.js';

const DESIRED = { command: 'node', args: ['/pkg/bin/akrs.js', 'mcp'] };
const spec = (extra = {}) => ({ container: ['mcpServers'], key: 'akrs', desired: DESIRED, launchKeys: ['command', 'args'], ...extra });
const parsed = (text) => JSON.parse(text.replace(/^﻿/, ''));

test('an absent file is created with the container and the entry, two-space indent, final newline', () => {
  const result = mergeServerEntry(null, spec());
  assert.equal(result.state, 'missing');
  assert.equal(result.after, '{\n  "mcpServers": {\n    "akrs": {\n      "command": "node",\n      "args": [\n        "/pkg/bin/akrs.js",\n        "mcp"\n      ]\n    }\n  }\n}\n');
});

test('an existing file keeps every other key, value and order; the entry is appended', () => {
  const before = '{\n  "theme": "dark",\n  "mcpServers": {\n    "other": { "command": "x" }\n  },\n  "tail": [1, 2]\n}\n';
  const result = mergeServerEntry(before, spec());
  assert.equal(result.state, 'missing');
  const after = parsed(result.after);
  assert.deepEqual(Object.keys(after), ['theme', 'mcpServers', 'tail']);
  assert.deepEqual(Object.keys(after.mcpServers), ['other', 'akrs']);
  assert.deepEqual(after.mcpServers.akrs, DESIRED);
  assert.deepEqual(after.tail, [1, 2]);
});

test('a missing container is created; a container of the wrong shape is a conflict', () => {
  assert.deepEqual(parsed(mergeServerEntry('{"a":1}', spec()).after), { a: 1, mcpServers: { akrs: DESIRED } });
  for (const text of ['{"mcpServers": []}', '{"mcpServers": 1}', '[]', '"x"', 'null']) {
    const result = mergeServerEntry(text, spec());
    assert.deepEqual([result.state, result.reason, result.after], ['conflict', 'unexpected_shape', null], text);
  }
  const nested = mergeServerEntry('{"mcp": {"x": 1}}', spec({ container: ['mcp'] }));
  assert.deepEqual(parsed(nested.after).mcp.akrs, DESIRED);
});

test('invalid JSON (including comments and an empty file) is a conflict that leaves the file alone', () => {
  for (const text of ['{ "a": 1, }', '// c\n{}', '{', '']) {
    const result = mergeServerEntry(text, spec());
    assert.deepEqual([result.state, result.reason, result.after], ['conflict', 'unparsable_json', null], JSON.stringify(text));
  }
});

test('an entry equal to the desired one is current and produces no text', () => {
  const result = mergeServerEntry(`${JSON.stringify({ mcpServers: { akrs: DESIRED } }, null, 2)}\n`, spec());
  assert.deepEqual([result.state, result.after], ['current', null]);
});

test('a recognized entry that differs only in the launch fields is outdated and replaced in place', () => {
  const before = JSON.stringify({ mcpServers: { a: {}, akrs: { command: 'node', args: ['/old/bin/akrs.js', 'mcp'] }, z: {} } }, null, 2);
  const result = mergeServerEntry(before, spec());
  assert.equal(result.state, 'outdated');
  const after = parsed(result.after);
  assert.deepEqual(Object.keys(after.mcpServers), ['a', 'akrs', 'z']);
  assert.deepEqual(after.mcpServers.akrs, DESIRED);
});

test('a recognized entry with another key changed or added is hand_modified and untouched', () => {
  for (const entry of [
    { command: 'node', args: ['/pkg/bin/akrs.js', 'mcp'], env: { A: '1' } },
    { command: 'node', args: ['/pkg/bin/akrs.js', 'mcp'], disabled: true },
  ]) {
    const result = mergeServerEntry(JSON.stringify({ mcpServers: { akrs: entry } }), spec());
    assert.deepEqual([result.state, result.reason, result.after], ['hand_modified', 'hand_modified_entry', null]);
  }
});

test('an entry under the key that is not an akrs launch is an unmanaged conflict', () => {
  for (const entry of [{ command: 'other' }, { command: 'node', args: ['server.js'] }, 'text', [], null]) {
    const result = mergeServerEntry(JSON.stringify({ mcpServers: { akrs: entry } }), spec());
    assert.deepEqual([result.state, result.reason, result.after], ['conflict', 'unmanaged_entry', null], JSON.stringify(entry));
  }
});

test('extra desired keys (directTools) count as part of the owned entry', () => {
  const wanted = { ...DESIRED, directTools: true };
  const fresh = mergeServerEntry(null, spec({ desired: wanted }));
  assert.deepEqual(parsed(fresh.after).mcpServers.akrs, wanted);
  const stale = mergeServerEntry(JSON.stringify({ mcpServers: { akrs: { command: 'node', args: ['/old/bin/akrs.js', 'mcp'], directTools: true } } }), spec({ desired: wanted }));
  assert.equal(stale.state, 'outdated');
  const edited = mergeServerEntry(JSON.stringify({ mcpServers: { akrs: { command: 'node', args: ['/old/bin/akrs.js', 'mcp'], directTools: false } } }), spec({ desired: wanted }));
  assert.equal(edited.state, 'hand_modified');
});

test('the opencode shape (command is an array) is recognized and merged', () => {
  const desired = { type: 'local', command: ['node', '/pkg/bin/akrs.js', 'mcp'], enabled: true };
  const wanted = { container: ['mcp'], key: 'akrs', desired, launchKeys: ['command'] };
  assert.equal(mergeServerEntry('{}', wanted).state, 'missing');
  const stale = mergeServerEntry(JSON.stringify({ mcp: { akrs: { type: 'local', command: ['node', '/old/bin/akrs.js', 'mcp'], enabled: true } } }), wanted);
  assert.equal(stale.state, 'outdated');
  assert.deepEqual(parsed(stale.after).mcp.akrs, desired);
  assert.equal(mergeServerEntry(JSON.stringify({ mcp: { akrs: desired } }), wanted).state, 'current');
  assert.equal(mergeServerEntry(JSON.stringify({ mcp: { akrs: { type: 'remote', url: 'https://x' } } }), wanted).reason, 'unmanaged_entry');
});

test('serialization follows the file: tab and four-space indents, CRLF, BOM, and a missing final newline', () => {
  const tabbed = mergeServerEntry('{\n\t"a": 1\n}\n', spec());
  assert.match(tabbed.after, /^\{\n\t"a": 1,\n\t"mcpServers": \{\n\t\t"akrs"/);
  const four = mergeServerEntry('{\n    "a": 1\n}', spec());
  assert.match(four.after, /^\{\n    "a": 1,\n    "mcpServers": \{\n        "akrs"/);
  assert.equal(four.after.endsWith('}'), true);
  const crlf = mergeServerEntry('{\r\n  "a": 1\r\n}\r\n', spec());
  assert.equal(/(^|[^\r])\n/.test(crlf.after), false);
  assert.equal(crlf.after.endsWith('}\r\n'), true);
  const bom = mergeServerEntry('﻿{"a":1}\n', spec());
  assert.equal(bom.after.startsWith('﻿{'), true);
  assert.equal(bom.after.indexOf('﻿', 1), -1);
});

test('the hook entry: appended to PreToolUse, current when equal, outdated by command, hand_modified by matcher, conflict when unrecognized', () => {
  const item = { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: 'node "/pkg/bin/akrs-guard.js"' }] };
  const wanted = { desired: item };
  const fresh = mergeHookEntry(null, wanted);
  assert.equal(fresh.state, 'missing');
  assert.deepEqual(parsed(fresh.after), { hooks: { PreToolUse: [item] } });

  const mine = { hooks: { PostToolUse: [{ matcher: 'x', hooks: [] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint' }] }] }, model: 'x' };
  const appended = mergeHookEntry(JSON.stringify(mine, null, 2), wanted);
  assert.equal(appended.state, 'missing');
  const merged = parsed(appended.after);
  assert.deepEqual(Object.keys(merged), ['hooks', 'model']);
  assert.equal(merged.hooks.PreToolUse.length, 2);
  assert.deepEqual(merged.hooks.PreToolUse[1], item);
  assert.deepEqual(merged.hooks.PostToolUse, mine.hooks.PostToolUse);

  assert.equal(mergeHookEntry(appended.after, wanted).state, 'current');

  const old = { hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: 'node "/old/bin/akrs-guard.js"' }] }] } };
  const outdated = mergeHookEntry(JSON.stringify(old), wanted);
  assert.equal(outdated.state, 'outdated');
  assert.deepEqual(parsed(outdated.after).hooks.PreToolUse, [item]);

  const edited = { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node "/old/bin/akrs-guard.js"' }] }] } };
  const handModified = mergeHookEntry(JSON.stringify(edited), wanted);
  assert.deepEqual([handModified.state, handModified.reason, handModified.after], ['hand_modified', 'hand_modified_entry', null]);

  for (const text of ['{"hooks": []}', '{"hooks": {"PreToolUse": {}}}']) {
    assert.deepEqual([mergeHookEntry(text, wanted).state, mergeHookEntry(text, wanted).reason], ['conflict', 'unexpected_shape'], text);
  }
  assert.equal(mergeHookEntry('{', wanted).reason, 'unparsable_json');
});
