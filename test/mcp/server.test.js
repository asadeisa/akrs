// P2-W15: the JSON-RPC lifecycle of both eras, in process. Legacy: initialize selects the 2025 semantics for the process. Modern
// (2026-07-28): every request names its version in _meta, server/discover is mandatory, -32022 on a mismatch, resultType everywhere.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import packageJson from '../../package.json' with { type: 'json' };
import { MCP_INSTRUCTIONS } from '../../lib/mcp/policy.js';
import { createRepo } from '../road/support.js';
import { MODERN, inProcess, modernMeta } from './support.js';

const SERVER_INFO = { name: 'akrs', version: packageJson.version };

test('legacy: initialize echoes a supported version, else answers the newest legacy one; tools only', async () => {
  for (const [asked, answered] of [['2025-11-25', '2025-11-25'], ['2025-06-18', '2025-06-18'], ['2025-03-26', '2025-03-26'], ['2024-11-05', '2025-11-25'], [MODERN, '2025-11-25']]) {
    const client = inProcess();
    const response = await client.legacy(asked);
    assert.deepEqual(response.result, {
      protocolVersion: answered, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: MCP_INSTRUCTIONS,
    }, asked);
  }
});

test('legacy: notifications get no answer, ping is empty, unknown methods are -32601, a second initialize is refused', async () => {
  const client = inProcess();
  await client.legacy();
  assert.equal(client.sent.length, 1, 'notifications/initialized is never answered');
  assert.deepEqual((await client.request('ping')).result, {});
  assert.equal((await client.request('resources/list')).error.code, -32601);
  assert.equal((await client.request('server/discover')).error.code, -32601, 'discover without _meta is not a legacy method');
  const fresh = inProcess();
  assert.deepEqual((await fresh.request('server/discover')).error.data, { supported: [MODERN], requested: null }, 'on a fresh process it names no version');
  assert.equal((await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } })).error.code, -32600);
  await client.notify('notifications/unknown');
  assert.equal(client.sent.every((message) => message.id !== undefined), true);
});

test('legacy: tools/list is the projected tool list, tools/call answers with a packet result', async (t) => {
  const repo = await createRepo(t);
  const client = inProcess({ root: repo.root });
  await client.legacy();
  const listed = await client.request('tools/list');
  assert.deepEqual(Object.keys(listed.result), ['tools']);
  assert.equal(listed.result.tools.length, 7);
  const result = await client.call('akrs_status', { action: 'explain', id: 'AKRS-C001' });
  assert.deepEqual(Object.keys(result).sort(), ['content', 'isError', 'structuredContent']);
  assert.equal(result.isError, false);
  assert.deepEqual(result.content.map(({ type }) => type), ['text']);
  assert.equal(result.structuredContent.command, 'explain');
  assert.equal(result.structuredContent.status, 'ok');
});

test('modern: server/discover advertises versions, capabilities, identity and instructions, cacheable', async () => {
  const client = inProcess();
  const response = await client.request('server/discover', { _meta: modernMeta() });
  assert.deepEqual(response.result, {
    resultType: 'complete',
    supportedVersions: [MODERN],
    capabilities: { tools: { listChanged: false } },
    instructions: MCP_INSTRUCTIONS,
    ttlMs: 3_600_000,
    cacheScope: 'public',
    _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
  });
});

test('modern: every request is checked statelessly; a mismatch is -32022 with the supported list', async (t) => {
  const repo = await createRepo(t);
  const client = inProcess({ root: repo.root });
  const listed = await client.request('tools/list', { _meta: modernMeta() });
  assert.equal(listed.result.resultType, 'complete');
  assert.deepEqual([listed.result.ttlMs, listed.result.cacheScope], [3_600_000, 'public']);
  assert.deepEqual(listed.result._meta, { 'io.modelcontextprotocol/serverInfo': SERVER_INFO });
  assert.equal(listed.result.tools.length, 7);
  const called = await client.request('tools/call', { name: 'akrs_status', arguments: { action: 'status' }, _meta: modernMeta() });
  assert.equal(called.result.resultType, 'complete');
  assert.equal(called.result.structuredContent.command, 'status');
  for (const version of ['2025-06-18', '1900-01-01', 7]) {
    const refused = await client.request('tools/list', { _meta: modernMeta(version) });
    assert.deepEqual(refused.error, { code: -32022, message: 'Unsupported protocol version', data: { supported: [MODERN], requested: version } });
  }
  // no initialize and no version: the server cannot tell the era, the modern error tells a dual-era client what to send
  assert.deepEqual((await client.request('tools/list')).error, { code: -32022, message: 'Unsupported protocol version', data: { supported: [MODERN], requested: null } });
  assert.equal((await client.request('ping', { _meta: modernMeta() })).error.code, -32601, 'ping is removed in 2026-07-28');
  assert.equal((await client.request('initialize', { _meta: modernMeta() })).error.code, -32601, 'initialize is not a modern method');
});

test('a legacy session still serves a request that carries modern _meta (both eras on one process)', async () => {
  const client = inProcess();
  await client.legacy();
  const legacyList = await client.request('tools/list');
  const modernList = await client.request('tools/list', { _meta: modernMeta() });
  assert.equal(Object.hasOwn(legacyList.result, 'resultType'), false);
  assert.equal(modernList.result.resultType, 'complete');
  assert.deepEqual(modernList.result.tools, legacyList.result.tools);
});

test('framing faults are JSON-RPC errors; client responses are ignored', async () => {
  const client = inProcess();
  await client.raw('{not json');
  assert.deepEqual(client.sent.at(-1), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  await client.raw('[{"jsonrpc":"2.0","id":1,"method":"ping"}]');
  assert.equal(client.sent.at(-1).error.code, -32600);
  await client.raw('{"jsonrpc":"1.0","id":2,"method":"ping"}');
  assert.deepEqual([client.sent.at(-1).id, client.sent.at(-1).error.code], [2, -32600]);
  await client.raw('{"jsonrpc":"2.0","id":3}');
  assert.deepEqual([client.sent.at(-1).id, client.sent.at(-1).error.code], [3, -32600]);
  await client.raw('{"jsonrpc":"2.0","id":{"x":1},"method":"ping"}');
  assert.deepEqual([client.sent.at(-1).id, client.sent.at(-1).error.code], [null, -32600]);
  const count = client.sent.length;
  await client.raw('{"jsonrpc":"2.0","id":9,"result":{}}');
  await client.raw('   ');
  assert.equal(client.sent.length, count);
});

test('tools/call: an unknown tool or a malformed name is -32602; bad arguments are a tool error carrying AKRS-C001', async (t) => {
  const repo = await createRepo(t);
  const client = inProcess({ root: repo.root });
  await client.legacy();
  const unknown = await client.request('tools/call', { name: 'akrs_nope', arguments: {} });
  assert.equal(unknown.error.code, -32602);
  assert.match(unknown.error.message, /akrs_nope/);
  assert.equal((await client.request('tools/call', { arguments: {} })).error.code, -32602);
  assert.equal((await client.request('tools/call')).error.code, -32602);
  for (const args of [{ action: 'nope' }, { action: 'status', bogus: true }, 'status']) {
    const result = await client.call('akrs_status', args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.deepEqual(result.structuredContent.findings.map(({ code }) => code), ['AKRS-C001']);
    assert.equal(result.structuredContent.status, 'error');
    assert.match(result.content[0].text, /AKRS-C001/);
  }
  // absent arguments are an empty object (the action is then missing)
  const missing = await client.call('akrs_status', undefined);
  assert.match(missing.structuredContent.findings[0].message, /action/);
});
