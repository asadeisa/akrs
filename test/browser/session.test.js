// P2-W13: a page session over the fake peer: what it asks the browser, what it keeps and how it fails.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CdpConnection } from '../../lib/browser/cdp.js';
import { BROWSER_POLICY } from '../../lib/browser/policy.js';
import { runPageSession } from '../../lib/browser/session.js';
import { fakeBrowser } from './support.js';

const request = (extra = {}) => ({ url: 'http://localhost:3000/', collect: { text: true, a11y: false, console: true, network: true, screenshot: false }, viewport: null, waitFor: null, timeoutMs: 5000, ...extra });
const open = (page) => {
  const browser = fakeBrowser(page);
  const conn = new CdpConnection(browser.transport, { timeoutMs: 5000 });
  return { browser, conn };
};
const run = (page, extra) => {
  const { browser, conn } = open(page);
  return runPageSession(conn, request(extra), { sleep: () => new Promise((resolve) => setTimeout(resolve, 5)) }).then((result) => ({ result, browser }));
};

test('a page is opened in its own target and the collectors named are the only ones enabled', async () => {
  const { result, browser } = await run({});
  assert.equal(result.ok, true);
  const methods = browser.methods();
  assert.deepEqual(methods.slice(0, 2), ['Target.createTarget', 'Target.attachToTarget']);
  assert.ok(methods.includes('Network.enable') && methods.includes('Runtime.enable') && methods.includes('Log.enable'));
  assert.ok(!methods.includes('Accessibility.getFullAXTree'));
  assert.ok(!methods.includes('Page.captureScreenshot'));
  assert.ok(methods.includes('Target.closeTarget'));
});

test('text, title, final URL and timings come from the page', async () => {
  const { result } = await run({ text: 'Hello reservations', title: 'Demo', url: 'http://localhost:3000/final' });
  assert.deepEqual([result.page.title, result.page.final_url, result.page.text.text], ['Demo', 'http://localhost:3000/final', 'Hello reservations']);
  assert.deepEqual(result.page.timings, { ttfb_ms: 12, dom_content_loaded_ms: 80, load_ms: 121 });
});

test('console errors, exceptions and failed requests that happen while the page loads are kept', async () => {
  const { result } = await run({
    events: [
      ['Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'boom' }] }],
      ['Network.requestWillBeSent', { requestId: '1', type: 'Image', request: { url: 'http://x/m.png', method: 'GET' } }],
      ['Network.responseReceived', { requestId: '1', type: 'Image', response: { url: 'http://x/m.png', status: 404 } }],
    ],
  });
  assert.equal(result.page.console.errors, 1);
  assert.equal(result.page.network.failed[0].status, 404);
});

test('the outline and the screenshot are collected only when asked for', async () => {
  const { result, browser } = await run({}, { collect: { text: false, a11y: true, console: false, network: false, screenshot: true } });
  assert.equal(result.page.text, null);
  assert.equal(result.page.a11y.nodes[0].role, 'RootWebArea');
  assert.equal(Buffer.from(result.screenshot).toString(), 'PNG-BYTES');
  assert.ok(!browser.methods().includes('Network.enable'));
});

test('the viewport is applied before the page is opened', async () => {
  const { result, browser } = await run({}, { viewport: { width: 390, height: 844 } });
  assert.deepEqual(result.page.viewport, { width: 390, height: 844 });
  const methods = browser.methods();
  assert.ok(methods.indexOf('Emulation.setDeviceMetricsOverride') < methods.indexOf('Page.navigate'));
  const override = browser.transport.sent.find(({ method }) => method === 'Emulation.setDeviceMetricsOverride');
  assert.deepEqual(override.params, { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
});

test('networkIdle of about:blank does not end the wait; only the navigation loaderId does', async () => {
  const { result } = await run({ loaderId: 'REAL' });
  assert.equal(result.ok, true);
});

test('a navigation that never goes idle is a timeout, not a hang', async () => {
  const { result } = await run({ idle: false }, { timeoutMs: 50 });
  assert.deepEqual([result.ok, result.reason], [false, 'timeout']);
});

test('a navigation error is reported with the browser text', async () => {
  const { result } = await run({ navigateError: 'net::ERR_CONNECTION_REFUSED' });
  assert.deepEqual([result.ok, result.reason], [false, 'navigation_failed']);
  assert.match(result.message, /ERR_CONNECTION_REFUSED/);
});

test('--wait-for succeeds when the text is there and times out when it never is', async () => {
  const found = await run({ text: 'Saved!' }, { waitFor: 'Saved' });
  assert.deepEqual(found.result.page.wait_for, { text: 'Saved', found: true });
  const missing = await run({ text: 'Nothing' }, { waitFor: 'Saved', timeoutMs: 80 });
  assert.deepEqual([missing.result.ok, missing.result.reason], [false, 'wait_for_timeout']);
});

test('an over-long text is cut at the frozen cap', async () => {
  const { result } = await run({ text: 'x'.repeat(BROWSER_POLICY.caps.text_chars + 10) });
  assert.deepEqual([result.page.text.truncated, result.page.text.text.length], [true, BROWSER_POLICY.caps.text_chars]);
});

test('the target is closed even when the navigation fails', async () => {
  const { browser } = await run({ navigateError: 'net::ERR_FAILED' });
  assert.ok(browser.methods().includes('Target.closeTarget'));
});
