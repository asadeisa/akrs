// P2-W13: the collectors are pure functions over raw CDP data: no browser, no clock, no file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BROWSER_POLICY } from '../../lib/browser/policy.js';
import { capText, collectConsole, collectNetwork, outlineAccessibility, parseViewport, timingsOf } from '../../lib/browser/collectors.js';
import { SAMPLE_AX } from './support.js';

const caps = BROWSER_POLICY.caps;

test('text is kept whole under the cap and cut with its real length over it', () => {
  assert.deepEqual(capText('hello', 10), { text: 'hello', chars: 5, truncated: false });
  assert.deepEqual(capText('abcdef', 3), { text: 'abc', chars: 6, truncated: true });
  assert.equal(capText('x'.repeat(caps.text_chars + 1), caps.text_chars).truncated, true);
});

test('the accessibility outline keeps meaningful nodes in tree order with their depth', () => {
  const outline = outlineAccessibility(SAMPLE_AX.nodes, 100);
  assert.deepEqual(outline, {
    nodes: [
      { depth: 0, role: 'RootWebArea', name: 'Demo' },
      { depth: 1, role: 'heading', name: 'Reservations' },
      { depth: 1, role: 'button', name: 'Save' },
      { depth: 1, role: 'link', name: 'Back' },
    ],
    total: 4,
    truncated: false,
  });
});

test('the outline cap is a truncation with the true total', () => {
  const outline = outlineAccessibility(SAMPLE_AX.nodes, 2);
  assert.deepEqual([outline.nodes.length, outline.total, outline.truncated], [2, 4, true]);
});

test('an empty or unusable tree gives an empty outline', () => {
  assert.deepEqual(outlineAccessibility([], 10), { nodes: [], total: 0, truncated: false });
  assert.deepEqual(outlineAccessibility(undefined, 10), { nodes: [], total: 0, truncated: false });
});

test('console errors and uncaught exceptions are collected, other output is not', () => {
  const events = [
    { method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ type: 'string', value: 'fine' }] } },
    { method: 'Runtime.consoleAPICalled', params: { type: 'error', args: [{ type: 'string', value: 'boom' }, { type: 'number', value: 3 }], stackTrace: { callFrames: [{ url: 'http://x/app.js', lineNumber: 6 }] } } },
    { method: 'Runtime.exceptionThrown', params: { exceptionDetails: { text: 'Uncaught', lineNumber: 1, url: 'http://x/a.js', exception: { description: 'TypeError: nope' } } } },
    { method: 'Log.entryAdded', params: { entry: { level: 'error', text: 'Failed to load resource', url: 'http://x/img.png', lineNumber: 0 } } },
    { method: 'Log.entryAdded', params: { entry: { level: 'info', text: 'ignored' } } },
  ];
  const result = collectConsole(events, caps.console_entries);
  assert.deepEqual(result.entries.map(({ kind, text }) => [kind, text]), [
    ['console', 'boom 3'],
    ['exception', 'TypeError: nope'],
    ['log', 'Failed to load resource'],
  ]);
  assert.deepEqual([result.errors, result.total, result.truncated], [3, 3, false]);
  assert.deepEqual([result.entries[0].url, result.entries[0].line], ['http://x/app.js', 7]);
});

test('console entries are capped, long messages are cut and both are reported', () => {
  const events = Array.from({ length: 5 }, (_, index) => ({ method: 'Runtime.consoleAPICalled', params: { type: 'error', args: [{ type: 'string', value: `m${index}${'x'.repeat(2000)}` }] } }));
  const result = collectConsole(events, 3);
  assert.deepEqual([result.entries.length, result.total, result.truncated], [3, 5, true]);
  assert.equal(result.entries[0].text.length, caps.entry_text_chars);
});

test('failed requests and 4xx/5xx responses are collected; ordinary and cancelled ones are only counted', () => {
  const events = [
    { method: 'Network.requestWillBeSent', params: { requestId: '1', type: 'Document', request: { url: 'http://x/', method: 'GET' } } },
    { method: 'Network.responseReceived', params: { requestId: '1', type: 'Document', response: { url: 'http://x/', status: 200 } } },
    { method: 'Network.requestWillBeSent', params: { requestId: '2', type: 'Image', request: { url: 'http://x/missing.png', method: 'GET' } } },
    { method: 'Network.responseReceived', params: { requestId: '2', type: 'Image', response: { url: 'http://x/missing.png', status: 404 } } },
    { method: 'Network.requestWillBeSent', params: { requestId: '3', type: 'Fetch', request: { url: 'http://x/api', method: 'POST' } } },
    { method: 'Network.loadingFailed', params: { requestId: '3', errorText: 'net::ERR_CONNECTION_REFUSED', canceled: false, type: 'Fetch' } },
    { method: 'Network.requestWillBeSent', params: { requestId: '4', type: 'Script', request: { url: 'http://x/a.js', method: 'GET' } } },
    { method: 'Network.loadingFailed', params: { requestId: '4', errorText: 'net::ERR_ABORTED', canceled: true, type: 'Script' } },
    { method: 'Network.requestWillBeSent', params: { requestId: '5', type: 'XHR', request: { url: 'http://x/boom', method: 'GET' } } },
    { method: 'Network.responseReceived', params: { requestId: '5', type: 'XHR', response: { url: 'http://x/boom', status: 503 } } },
  ];
  const result = collectNetwork(events, caps.network_entries);
  assert.deepEqual(result.failed, [
    { method: 'GET', url: 'http://x/missing.png', status: 404, error: null, type: 'Image' },
    { method: 'POST', url: 'http://x/api', status: null, error: 'net::ERR_CONNECTION_REFUSED', type: 'Fetch' },
    { method: 'GET', url: 'http://x/boom', status: 503, error: null, type: 'XHR' },
  ]);
  assert.deepEqual([result.total_requests, result.truncated], [5, false]);
});

test('the failed-request cap is a truncation with the true count', () => {
  const events = [];
  for (let index = 0; index < 4; index += 1) {
    events.push({ method: 'Network.requestWillBeSent', params: { requestId: String(index), type: 'Image', request: { url: `http://x/${index}`, method: 'GET' } } });
    events.push({ method: 'Network.responseReceived', params: { requestId: String(index), type: 'Image', response: { url: `http://x/${index}`, status: 500 } } });
  }
  const result = collectNetwork(events, 2);
  assert.deepEqual([result.failed.length, result.failed_total, result.truncated], [2, 4, true]);
});

test('timings are whole milliseconds and null when the page has no navigation entry', () => {
  assert.deepEqual(timingsOf({ responseStart: 12.4, domContentLoadedEventEnd: 80.2, loadEventEnd: 120.7 }), { ttfb_ms: 12, dom_content_loaded_ms: 80, load_ms: 121 });
  assert.deepEqual(timingsOf(null), { ttfb_ms: null, dom_content_loaded_ms: null, load_ms: null });
  assert.equal(timingsOf({ responseStart: 1, domContentLoadedEventEnd: 0, loadEventEnd: 0 }).load_ms, null);
});

test('a viewport is WIDTHxHEIGHT inside the frozen range', () => {
  assert.deepEqual(parseViewport('390x844'), { width: 390, height: 844 });
  for (const bad of ['390', '390X844', '0x10', '10000x10', '390x844x2', '-1x5', '']) assert.equal(parseViewport(bad), null, bad);
});
