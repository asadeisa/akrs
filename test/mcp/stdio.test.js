// P2-W15 separate-process conformance: `node bin/akrs.js mcp` speaks newline-delimited JSON-RPC on stdout and nothing else, logs on
// stderr, tolerates CRLF input, answers everything already received when stdin ends and exits 0 without cutting stdout short.
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { commandHandlers } from '../../lib/commands/meta.js';
import { normalizeAbsolutePath } from '../../lib/core/roots.js';
import { serveStdio } from '../../lib/mcp/stdio.js';
import { fakeProviders } from '../idempotency/support.js';
import { runCli } from '../helpers/process.js';
import { createRepo } from '../road/support.js';
import { MODERN, modernMeta, spawnServer } from './support.js';

const assertProtocolOnly = (stdout) => {
  assert.ok(stdout.endsWith('\n'));
  for (const line of stdout.slice(0, -1).split('\n')) {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, '2.0');
    assert.ok(Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'), line.slice(0, 80));
  }
};

test('legacy era over a real process: initialize -> tools/list -> tools/call -> stdin close -> exit 0', async (t) => {
  const repo = await createRepo(t);
  const server = spawnServer({ cwd: repo.root });
  server.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal((await server.response(1)).result.protocolVersion, '2025-06-18');
  server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  // CRLF line endings (a Windows client) are tolerated
  server.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { eol: '\r\n' });
  assert.equal((await server.response(2)).result.tools.length, 7);
  server.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'akrs_status', arguments: { action: 'status' } } });
  const called = await server.response(3);
  assert.deepEqual([called.result.isError, called.result.structuredContent.command, called.result.structuredContent.root], [false, 'status', normalizeAbsolutePath(repo.root)]);
  server.end();
  const finished = await server.finish();
  assert.deepEqual([finished.code, finished.signal], [0, null]);
  assertProtocolOnly(finished.stdout);
  assert.equal(finished.lines.length, 3);
  assert.match(finished.stderr, /akrs mcp/);
});

test('modern era over a real process: server/discover, a stateless tools/call, and -32022', async (t) => {
  const repo = await createRepo(t);
  const server = spawnServer({ cwd: repo.root });
  server.send({ jsonrpc: '2.0', id: 'd', method: 'server/discover', params: { _meta: modernMeta() } });
  assert.deepEqual((await server.response('d')).result.supportedVersions, [MODERN]);
  server.send({ jsonrpc: '2.0', id: 'c', method: 'tools/call', params: { name: 'akrs_road', arguments: { action: 'template', kind: 'road' }, _meta: modernMeta() } });
  const called = await server.response('c');
  assert.deepEqual([called.result.resultType, called.result.isError, called.result.structuredContent.command], ['complete', false, 'template']);
  server.send({ jsonrpc: '2.0', id: 'v', method: 'tools/list', params: { _meta: modernMeta('2025-03-26') } });
  assert.equal((await server.response('v')).error.code, -32022);
  server.end();
  const finished = await server.finish();
  assert.equal(finished.code, 0);
  assertProtocolOnly(finished.stdout);
});

test('stdin closing right after the requests still delivers every answer in full (no exit before stdout drains)', async (t) => {
  const repo = await createRepo(t);
  const server = spawnServer({ cwd: repo.root });
  const lines = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } }];
  for (let id = 2; id < 12; id += 1) lines.push({ jsonrpc: '2.0', id, method: 'tools/list' });
  lines.push({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'akrs_status', arguments: { action: 'validate' } } });
  server.write(`﻿${lines.map((line) => JSON.stringify(line)).join('\n')}`); // a BOM first and no final newline
  server.end();
  const finished = await server.finish();
  assert.equal(finished.code, 0, finished.stderr);
  assertProtocolOnly(finished.stdout);
  assert.deepEqual(finished.lines.map((line) => JSON.parse(line).id), Array.from({ length: 12 }, (_, index) => index + 1));
});

test('akrs mcp refuses unknown arguments on stderr with exit 2 and writes nothing to stdout; --json describes the server', async (t) => {
  const repo = await createRepo(t);
  const refused = await runCli(['mcp', '--bogus'], { cwd: repo.root });
  assert.deepEqual([refused.exitCode, refused.stdout], [2, '']);
  assert.match(refused.stderr, /--bogus/);
  const described = await runCli(['mcp', '--json'], { cwd: repo.root });
  assert.equal(described.exitCode, 0, described.stderr);
  const packet = JSON.parse(described.stdout);
  assert.deepEqual([packet.command, packet.status, packet.data.kind], ['mcp', 'ok', 'mcp_server']);
  assert.deepEqual(packet.data.tools.map(({ name }) => name), ['akrs_status', 'akrs_write', 'akrs_scope', 'akrs_test', 'akrs_road', 'akrs_work', 'akrs_page']);
  assert.deepEqual(packet.data.modern_versions, [MODERN]);
});

test('a handler that prints to the console cannot corrupt stdout: console output is moved to stderr while serving', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk) => { out += chunk; });
  stderr.on('data', (chunk) => { err += chunk; });
  const handlers = {
    ...commandHandlers,
    explain: (parameters) => {
      console.log('noise from a handler');
      console.info('more noise');
      return commandHandlers.explain(parameters);
    },
  };
  const serving = serveStdio({ stdin, stdout, stderr, manifest: commandManifest, handlers, providers: fakeProviders(), cwd: process.cwd(), rootFlags: {} });
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })}\n`);
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'akrs_status', arguments: { action: 'explain', id: 'AKRS-C001' } } })}\n`);
  stdin.end();
  await serving;
  assertProtocolOnly(out);
  assert.match(err, /noise from a handler/);
  assert.match(err, /more noise/);
  assert.equal(typeof console.log, 'function');
  assert.equal(out.split('\n').filter(Boolean).length, 2);
});
