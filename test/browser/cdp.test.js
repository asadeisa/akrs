// P2-W13: the CDP client against a fake peer: id correlation, events, sessions, deterministic timeouts, pipe framing.
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CdpConnection, CdpError, CdpTimeoutError, pipeTransport } from '../../lib/browser/cdp.js';
import { FakeTransport, flush, manualScheduler } from './support.js';

const connect = (respond, scheduler = manualScheduler()) => {
  const transport = new FakeTransport(respond);
  return { transport, scheduler, conn: new CdpConnection(transport, { schedule: scheduler.schedule, timeoutMs: 1000 }) };
};

test('replies are matched to their request by id, in any order', async () => {
  const { transport, conn } = connect(() => undefined);
  const first = conn.send('A.one');
  const second = conn.send('B.two', { x: 1 });
  await flush();
  assert.deepEqual(transport.sent.map(({ id, method }) => [id, method]), [[1, 'A.one'], [2, 'B.two']]);
  transport.push({ id: 2, result: { b: true } });
  transport.push({ id: 1, result: { a: true } });
  assert.deepEqual([await first, await second], [{ a: true }, { b: true }]);
});

test('a protocol error rejects with its code and message', async () => {
  const { conn } = connect((message) => ({ id: message.id, error: { code: -32000, message: 'Not allowed' } }));
  await assert.rejects(conn.send('X.y'), (error) => error instanceof CdpError && error.code === -32000 && /Not allowed/.test(error.message));
});

test('a call without an answer times out exactly when the time is up', async () => {
  const { conn, scheduler } = connect(() => undefined);
  const call = conn.send('Slow.call');
  scheduler.advance(999);
  let settled = false;
  call.catch(() => { settled = true; });
  await flush();
  assert.equal(settled, false);
  scheduler.advance(1);
  await assert.rejects(call, (error) => error instanceof CdpTimeoutError && error.method === 'Slow.call');
  assert.equal(scheduler.pending(), 0);
});

test('an answered call cancels its timer', async () => {
  const { conn, scheduler } = connect((message) => ({ id: message.id, result: {} }));
  await conn.send('Quick.call');
  assert.equal(scheduler.pending(), 0);
});

test('events reach listeners with their session, and waitForEvent resolves on the first match', async () => {
  const { transport, conn } = connect(() => undefined);
  const seen = [];
  conn.onEvent((event) => seen.push([event.method, event.sessionId ?? null]));
  const waiting = conn.waitForEvent((event) => event.method === 'Page.loadEventFired', 500);
  transport.event('Network.requestWillBeSent', {}, 'S1');
  transport.event('Page.loadEventFired', { timestamp: 1 }, 'S1');
  const event = await waiting;
  assert.equal(event.params.timestamp, 1);
  assert.deepEqual(seen, [['Network.requestWillBeSent', 'S1'], ['Page.loadEventFired', 'S1']]);
});

test('waitForEvent times out deterministically', async () => {
  const { conn, scheduler } = connect(() => undefined);
  const waiting = conn.waitForEvent(() => false, 400);
  scheduler.advance(400);
  await assert.rejects(waiting, CdpTimeoutError);
});

test('a session id is sent with the call', async () => {
  const { transport, conn } = connect((message) => ({ id: message.id, result: {} }));
  await conn.send('Page.enable', {}, { sessionId: 'S9' });
  assert.equal(transport.sent[0].sessionId, 'S9');
});

test('closing the transport rejects every pending call and later calls', async () => {
  const { transport, conn } = connect(() => undefined);
  const pending = conn.send('Never.answered');
  await flush();
  transport.close();
  await assert.rejects(pending, /closed/);
  await assert.rejects(conn.send('After.close'), /closed/);
});

test('garbage from the peer is ignored, not fatal', async () => {
  const { transport, conn } = connect((message) => ({ id: message.id, result: { ok: 1 } }));
  transport.push('not json');
  assert.deepEqual(await conn.send('Still.works'), { ok: 1 });
});

test('the pipe transport frames messages with NUL in both directions, across chunk boundaries', async () => {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const transport = pipeTransport({ write: toBrowser, read: fromBrowser });
  const received = [];
  transport.onMessage((text) => received.push(text));
  transport.send('{"id":1}');
  assert.equal(toBrowser.read().toString(), '{"id":1}\0');
  fromBrowser.write('{"id":1,"resu');
  fromBrowser.write('lt":{}}\0{"method":"A.b"}\0');
  await flush();
  assert.deepEqual(received, ['{"id":1,"result":{}}', '{"method":"A.b"}']);
  fromBrowser.write('{"multi":"é字"}\0');
  await flush();
  assert.equal(received[2], '{"multi":"é字"}');
});

test('the pipe transport reports the end of the stream as a close', async () => {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const transport = pipeTransport({ write: toBrowser, read: fromBrowser });
  let closed = 0;
  transport.onClose(() => { closed += 1; });
  fromBrowser.end();
  await flush();
  assert.equal(closed, 1);
});
