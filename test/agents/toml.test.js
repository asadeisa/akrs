// The minimal TOML writer (Codex): value rendering, table rendering, and the scan that finds a definition of a table path outside our block.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findTomlDefinition, renderTomlTable, tomlValue } from '../../lib/agents/toml.js';

test('values: strings are escaped basic strings, arrays hold strings, booleans and integers', () => {
  assert.equal(tomlValue('node'), '"node"');
  assert.equal(tomlValue('C:/a b/"q"\\x'), '"C:/a b/\\"q\\"\\\\x"');
  assert.equal(tomlValue('line\nbreak\ttab'), '"line\\nbreak\\ttab"');
  assert.equal(tomlValue('\u0001'), '"\\u0001"');
  assert.equal(tomlValue('héllo'), '"héllo"');
  assert.equal(tomlValue(true), 'true');
  assert.equal(tomlValue(42), '42');
  assert.equal(tomlValue(['a', 'b']), '["a", "b"]');
  assert.equal(tomlValue([]), '[]');
  assert.throws(() => tomlValue({}), TypeError);
  assert.throws(() => tomlValue(1.5), TypeError);
  assert.throws(() => tomlValue(null), TypeError);
  assert.throws(() => tomlValue([['nested']]), TypeError);
});

test('a table renders its header and keys in the given order, bare or quoted keys, newline terminated', () => {
  assert.equal(
    renderTomlTable(['mcp_servers', 'akrs'], { command: 'node', args: ['/p/bin/akrs.js', 'mcp'] }),
    '[mcp_servers.akrs]\ncommand = "node"\nargs = ["/p/bin/akrs.js", "mcp"]\n',
  );
  assert.equal(renderTomlTable(['a', 'b c'], { 'k-1': 1, 'odd key': false }), '[a."b c"]\nk-1 = 1\n"odd key" = false\n');
  assert.throws(() => renderTomlTable([], { a: 1 }), TypeError);
});

test('findTomlDefinition finds the table, a sub-table, a dotted key and an inline definition of the path', () => {
  const at = (text) => findTomlDefinition(text, ['mcp_servers', 'akrs']);
  assert.equal(at(''), null);
  assert.equal(at('[other]\nx = 1\n'), null);
  assert.equal(at('[mcp_servers.other]\ncommand = "x"\n'), null);
  assert.deepEqual(at('a = 1\n[mcp_servers.akrs]\ncommand = "x"\n'), { line: 2, kind: 'table' });
  assert.deepEqual(at('[ mcp_servers . akrs ]\n'), { line: 1, kind: 'table' });
  assert.deepEqual(at('[mcp_servers."akrs"]\n'), { line: 1, kind: 'table' });
  assert.deepEqual(at("[mcp_servers.'akrs']\n"), { line: 1, kind: 'table' });
  assert.deepEqual(at('[mcp_servers.akrs.env]\nK = "v"\n'), { line: 1, kind: 'table' });
  assert.deepEqual(at('[[mcp_servers.akrs]]\n'), { line: 1, kind: 'table' });
  assert.deepEqual(at('mcp_servers.akrs.command = "x"\n'), { line: 1, kind: 'dotted_key' });
  assert.deepEqual(at('[mcp_servers]\nother = { command = "y" }\nakrs = { command = "x" }\n'), { line: 3, kind: 'key' });
  assert.deepEqual(at('[mcp_servers]\n"akrs".command = "x"\n'), { line: 2, kind: 'key' });
  assert.deepEqual(at('[mcp_servers]\nakrs.command = "x"\n'), { line: 2, kind: 'key' });
});

test('findTomlDefinition finds a definition inside an inline table of the parent key', () => {
  const at = (text) => findTomlDefinition(text, ['mcp_servers', 'akrs']);
  assert.deepEqual(at('mcp_servers = { other = { command = "y" }, akrs = { command = "x" } }\n'), { line: 1, kind: 'inline' });
  assert.deepEqual(at('mcp_servers = { "akrs".command = "x" }\n'), { line: 1, kind: 'inline' });
  assert.equal(at('mcp_servers = { other = { command = "akrs" } }\n'), null);
});

test('findTomlDefinition ignores comments, multi-line strings and similar names', () => {
  const at = (text) => findTomlDefinition(text, ['mcp_servers', 'akrs']);
  assert.equal(at('# [mcp_servers.akrs]\n'), null);
  assert.equal(at('note = """\n[mcp_servers.akrs]\n"""\n'), null);
  assert.equal(at("note = '''\n[mcp_servers.akrs]\n'''\nx = 1\n"), null);
  assert.equal(at('[mcp_servers.akrs2]\n'), null);
  assert.equal(at('[mcp_servers]\nakrs2 = 1\n'), null);
  assert.equal(at('[mcp_servers.other.akrs]\n'), null);
  assert.equal(at('[x]\nmcp_servers.akrs = 1\n'), null);
  assert.deepEqual(at('s = "a # b"\n[mcp_servers.akrs] # trailing\n'), { line: 2, kind: 'table' });
  assert.deepEqual(at('note = """\nx\n"""\n[mcp_servers.akrs]\n'), { line: 4, kind: 'table' });
  assert.deepEqual(at('\uFEFF[mcp_servers.akrs]\r\ncommand = "x"\r\n'), { line: 1, kind: 'table' });
});
