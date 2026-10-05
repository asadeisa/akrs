// P2-W15 F19 freeze: protocol versions and negotiation, the method set, the error mapping, the schema subset, the projection and coercion
// rules, cancellation and the server instructions. A change to any of these is a change to the public MCP surface.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import {
  MCP_CANCELLATION, MCP_COERCION, MCP_ERRORS, MCP_FRAMING, MCP_INSTRUCTIONS, MCP_PROJECTION, MCP_PROTOCOL, MCP_RESULT_POLICY, MCP_SCHEMA_RULES, MCP_SERVER_NAME,
} from '../../lib/mcp/policy.js';

test('F19 protocol: dual era, the modern 2026-07-28 revision plus three legacy revisions, tools only', () => {
  assert.equal(MCP_SERVER_NAME, 'akrs');
  assert.deepEqual(MCP_PROTOCOL.modern_versions, ['2026-07-28']);
  assert.deepEqual(MCP_PROTOCOL.legacy_versions, ['2025-11-25', '2025-06-18', '2025-03-26']);
  assert.equal(MCP_PROTOCOL.legacy_fallback, '2025-11-25');
  assert.deepEqual(MCP_PROTOCOL.capabilities, { tools: { listChanged: false } });
  assert.equal(MCP_PROTOCOL.meta_keys.protocol_version, 'io.modelcontextprotocol/protocolVersion');
  assert.equal(MCP_PROTOCOL.meta_keys.server_info, 'io.modelcontextprotocol/serverInfo');
  assert.equal(MCP_PROTOCOL.result_type, 'complete');
  assert.deepEqual(MCP_PROTOCOL.cache, { ttl_ms: 3_600_000, scope: 'public' });
  assert.deepEqual(MCP_PROTOCOL.methods, {
    legacy: ['initialize', 'ping', 'tools/call', 'tools/list'],
    modern: ['server/discover', 'tools/call', 'tools/list'],
    notifications: ['notifications/cancelled', 'notifications/initialized'],
  });
  assert.equal(Object.isFrozen(MCP_PROTOCOL.methods.modern), true);
});

test('F19 errors: protocol faults only; packets are tool results and the exit code decides isError', () => {
  assert.deepEqual(MCP_ERRORS, {
    parse_error: -32700, invalid_request: -32600, method_not_found: -32601, invalid_params: -32602, internal_error: -32603, unsupported_protocol_version: -32022,
  });
  assert.deepEqual(MCP_RESULT_POLICY.is_error_exit_codes, [2, 3, 4]);
  assert.equal(MCP_RESULT_POLICY.usage_finding, 'AKRS-C001');
  assert.equal(MCP_RESULT_POLICY.text_cap_bytes, 16_384);
  assert.equal(MCP_RESULT_POLICY.overflow_directory, '.cache/mcp');
});

test('F19 schema subset and projection rules', () => {
  assert.equal(MCP_SCHEMA_RULES.max_tools, 7);
  assert.equal(MCP_SCHEMA_RULES.tool_name_pattern, '^[a-z][a-z0-9_]{0,29}$');
  assert.deepEqual(MCP_SCHEMA_RULES.property_types, ['string', 'integer', 'boolean', 'array']);
  assert.equal(MCP_SCHEMA_RULES.array_items, 'string');
  for (const keyword of ['$ref', 'oneOf', 'anyOf', 'allOf', 'const', 'default', 'format']) assert.ok(MCP_SCHEMA_RULES.forbidden_keywords.includes(keyword), keyword);
  assert.deepEqual(MCP_PROJECTION.excluded_flags, ['--json', '--jsonl', '--prompt', '--request-id', '--root', '--workflow-root']);
  assert.deepEqual(MCP_PROJECTION.renamed_flags, { '--input': 'input_path' });
  assert.deepEqual(MCP_PROJECTION.positional_aliases, {
    akrs_scope: { target: ['request', 'road'] }, akrs_status: { code: ['id'] }, akrs_write: { plan: ['id'], road: ['id'] },
  });
  // every tool the manifest names has a purpose sentence under the description cap
  const tools = [...new Set(commandManifest.commands.map(({ mcp_tool: tool }) => tool).filter((tool) => tool !== null))].sort();
  assert.deepEqual(Object.keys(MCP_PROJECTION.tool_purposes).sort(), tools);
  for (const purpose of Object.values(MCP_PROJECTION.tool_purposes)) assert.ok(purpose.length < 140 && purpose.endsWith('.'), purpose);
  assert.deepEqual(Object.keys(MCP_COERCION), ['null', 'boolean', 'integer', 'array', 'path', 'string', 'rejected']);
  assert.equal(MCP_CANCELLATION.notification, 'notifications/cancelled');
  assert.deepEqual([MCP_FRAMING.delimiter, MCP_FRAMING.max_line_bytes], ['\n', 4 * 1024 * 1024]);
});

test('F19 the server instructions put the essentials in the first 512 characters', () => {
  const head = MCP_INSTRUCTIONS.slice(0, 512);
  for (const phrase of ['--json', 'next_commands', 'akrs_work work', 'akrs_work done', 'akrs_test details', 'akrs_status boot', 'input_path', 'Never pass hashes']) {
    assert.ok(head.includes(phrase), phrase);
  }
  assert.ok(MCP_INSTRUCTIONS.length <= 1024);
});
