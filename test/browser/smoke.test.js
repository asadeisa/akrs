// P2-W13: the real-browser smoke. It runs where a Chromium-family browser is installed and is reported `skipped`, never
// passed, where none is. A browser is found exactly the way `akrs page` finds it.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { collectPage } from '../../lib/browser/page.js';
import { discoverBrowser } from '../../lib/browser/discovery.js';

const found = discoverBrowser({ platform: process.platform, env: process.env });
const PAGE = '<!doctype html><title>Smoke page</title><h1>Reservations</h1><button>Save</button><img src="/missing.png"><script>console.error("smoke-boom");</script>';

test('a real browser reads text, outline, console, failed requests, timings and a screenshot, and leaves nothing behind', { skip: found.ok ? false : `no browser found (${found.reason})` }, async (t) => {
  const server = createServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(PAGE);
    } else {
      response.writeHead(404);
      response.end('no');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const result = await collectPage({
    url: `http://127.0.0.1:${port}/`, collect: { text: true, a11y: true, console: true, network: true, screenshot: true }, viewport: { width: 390, height: 844 }, waitFor: 'Reservations', timeoutMs: 30000,
  }, { env: process.env, platform: process.platform });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.page.title, 'Smoke page');
  assert.match(result.page.text.text, /Reservations/);
  assert.ok(result.page.a11y.nodes.some(({ role, name }) => role === 'button' && name === 'Save'));
  assert.ok(result.page.console.entries.some(({ text }) => text.includes('smoke-boom')));
  assert.ok(result.page.network.failed.some(({ url, status }) => url.endsWith('/missing.png') && status === 404));
  assert.ok(result.page.timings.load_ms > 0);
  assert.deepEqual([...result.screenshot.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  assert.equal(result.teardown.profile_removed, true);
  assert.equal(existsSync(result.teardown.profile_dir), false);
});
