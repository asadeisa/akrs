// P2-W15: cancellation and oversized results. notifications/cancelled stops a running `test run` (its app is ended, nothing is written)
// and no response is ever sent for a cancelled request; a queued call that is cancelled never runs. A prompt rendering above 16 KiB is
// written to the snapshot-excluded cache and the text names that file, while structuredContent stays the complete packet.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { commandHandlers } from '../../lib/commands/meta.js';
import { createPacket } from '../../lib/core/packet.js';
import { renderPrompt } from '../../lib/renderers/prompt.js';
import { createRepo } from '../road/support.js';
import { APP, freePort, runWorld } from '../scenario/support.js';
import { inProcess } from './support.js';

const reachable = (port) => fetch(`http://127.0.0.1:${port}/health`).then(() => true, () => false);
const EMPTY = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const knownCommands = commandManifest.commands.map(({ id }) => id);

test('cancelling a running test run ends the app, writes no evidence and sends no response', async (t) => {
  const port = await freePort();
  // the app never answers the readiness status, so the run waits until it is cancelled
  const repo = await runWorld(t, { port, contract: { launch: { argv: [process.execPath, APP, String(port)], url: `http://127.0.0.1:${port}`, ready: { url: `http://127.0.0.1:${port}/health`, status: 201, timeout_ms: 20000 } } } });
  const client = inProcess({ root: repo.root, providers: repo.providers });
  await client.legacy();
  const running = client.start('tools/call', { name: 'akrs_test', arguments: { action: 'run', plan: 'P6' } });
  // a queued call behind it, cancelled before it starts
  const queued = client.start('tools/call', { name: 'akrs_status', arguments: { action: 'status' } });
  await client.notify('notifications/cancelled', { requestId: queued.id, reason: 'not needed' });
  for (let attempt = 0; attempt < 100 && !await reachable(port); attempt += 1) await new Promise((resolve) => { setTimeout(resolve, 50); });
  assert.equal(await reachable(port), true, 'the app was launched');
  const started = Date.now();
  await client.notify('notifications/cancelled', { requestId: running.id, reason: 'user stopped it' });
  assert.equal(await running.done, undefined, 'no response for a cancelled request');
  assert.equal(await queued.done, undefined, 'no response for a cancelled queued request');
  assert.ok(Date.now() - started < 15000, 'the run stopped well before its readiness timeout');
  assert.equal(await reachable(port), false, 'the app is no longer running');
  assert.equal(existsSync(repo.path('akrs/verifications/P6/evidence')), false, 'nothing was written');
  assert.equal(client.server.ranCommands.includes('status'), false, 'the cancelled queued call never ran');
  // the server keeps serving afterwards; cancelling an unknown or finished request is ignored
  await client.notify('notifications/cancelled', { requestId: 999 });
  assert.equal((await client.call('akrs_status', { action: 'status' })).isError, false);
});

test('closing the server (stdin end) raises the abort signal of every pending call, still answers them and waits for them', async (t) => {
  const repo = await createRepo(t);
  const seen = [];
  const waitForAbort = (name) => ({ deps }) => new Promise((resolve, reject) => {
    const stop = () => { seen.push(name); reject(new Error(`${name} interrupted`)); };
    if (deps.signal.aborted) stop();
    else deps.signal.addEventListener('abort', stop);
  });
  const client = inProcess({ root: repo.root, handlers: { ...commandHandlers, status: waitForAbort('status'), next: waitForAbort('next') } });
  await client.legacy();
  const first = client.start('tools/call', { name: 'akrs_status', arguments: { action: 'status' } });
  const second = client.start('tools/call', { name: 'akrs_status', arguments: { action: 'next' } });
  await new Promise((resolve) => { setImmediate(resolve); });
  await client.server.close();
  assert.deepEqual(seen, ['status', 'next'], 'the running call was aborted, the queued one started already aborted');
  for (const call of [first, second]) {
    const response = await call.done;
    assert.equal(response.result.isError, true);
    assert.match(response.result.structuredContent.findings[0].message, /interrupted/);
  }
});

test('a prompt rendering above 16 KiB goes to akrs/.cache/mcp and the text names the file; structuredContent stays complete', async (t) => {
  const repo = await createRepo(t);
  let made = null;
  const handlers = {
    ...commandHandlers,
    status: ({ providers }) => {
      made = createPacket({
        command: 'status', status: 'ok', root: repo.root, snapshot: { before: EMPTY, after: EMPTY }, data: { kind: 'big', blob: 'x'.repeat(40_000) }, providers, knownCommands,
      });
      return made;
    },
  };
  const client = inProcess({ root: repo.root, handlers });
  await client.legacy();
  const result = await client.call('akrs_status', { action: 'status' });
  assert.deepEqual(result.structuredContent, made);
  const [{ text }] = result.content;
  assert.ok(Buffer.byteLength(text) < 2048, `${Buffer.byteLength(text)} bytes`);
  const relative = `akrs/.cache/mcp/${made.run_id}.md`;
  assert.ok(text.includes(relative), text);
  assert.ok(text.includes(`akrs/.cache/mcp/${made.run_id}.json`), text);
  assert.equal(await repo.read(relative), renderPrompt(made, { knownCommands, commandTokens: new Map(commandManifest.commands.map(({ id, tokens }) => [id, tokens])) }));
  assert.deepEqual(JSON.parse(await repo.read(`akrs/.cache/mcp/${made.run_id}.json`)), made);
  // a small result is never written anywhere
  const small = await client.call('akrs_status', { action: 'explain', id: 'AKRS-C001' });
  assert.equal(existsSync(repo.path(`akrs/.cache/mcp/${small.structuredContent.run_id}.md`)), false);
});
