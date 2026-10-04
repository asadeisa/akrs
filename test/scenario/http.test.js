// P2-W14: the HTTP step: built-in fetch, host guard, no followed redirects, mechanical facts only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostAllowed, resolvePointer, resolveUrl, runHttpStep } from '../../lib/scenario/http.js';

const reply = (status, body = '') => async () => ({ status, text: async () => body });
const step = (extra = {}) => ({ step: 'http', method: 'GET', url: '/api', headers: [], body: null, expect_status: 200, expect_json: null, soft: false, ...extra });
const options = (fetchImpl, extra = {}) => ({ baseUrl: 'http://127.0.0.1:3000', allowedHosts: [], timeoutMs: 500, fetchImpl, ...extra });

test('a path is resolved against the launch URL and an absolute URL is kept', () => {
  assert.equal(resolveUrl('/x?y=1', 'http://127.0.0.1:3000'), 'http://127.0.0.1:3000/x?y=1');
  assert.equal(resolveUrl('/x', 'http://127.0.0.1:3000/app/'), 'http://127.0.0.1:3000/x');
  assert.equal(resolveUrl('http://localhost:9/a', 'http://127.0.0.1:3000'), 'http://localhost:9/a');
});

test('loopback hosts are always allowed; any other host must be listed', () => {
  for (const url of ['http://127.0.0.1:1/', 'http://localhost/', 'http://[::1]:8080/', 'http://127.1.2.3/']) assert.equal(hostAllowed(url, []), true, url);
  assert.equal(hostAllowed('http://example.com/', []), false);
  assert.equal(hostAllowed('http://example.com/', ['example.com']), true);
  assert.equal(hostAllowed('http://EXAMPLE.com:81/', ['example.com']), true);
  assert.equal(hostAllowed('not a url', []), false);
});

test('a JSON pointer reads objects and arrays and tells found from absent', () => {
  const value = { a: [{ b: 1 }], 'x/y': 2, 'm~n': 3, n: null };
  assert.deepEqual(resolvePointer(value, '/a/0/b'), { found: true, value: 1 });
  assert.deepEqual(resolvePointer(value, ''), { found: true, value });
  assert.deepEqual(resolvePointer(value, '/x~1y'), { found: true, value: 2 });
  assert.deepEqual(resolvePointer(value, '/m~0n'), { found: true, value: 3 });
  assert.deepEqual(resolvePointer(value, '/n'), { found: true, value: null });
  assert.deepEqual(resolvePointer(value, '/a/5'), { found: false });
  assert.deepEqual(resolvePointer(value, '/a/b'), { found: false });
  assert.deepEqual(resolvePointer(value, '/missing/deeper'), { found: false });
});

test('the status is compared exactly and the answer is a mechanical detail', async () => {
  const ok = await runHttpStep(step(), options(reply(200)));
  assert.deepEqual([ok.status, ok.detail], ['passed', 'GET /api -> 200']);
  const bad = await runHttpStep(step(), options(reply(500)));
  assert.deepEqual([bad.status, bad.detail], ['failed', 'GET /api -> 500; expected status 200']);
});

test('expect_json compares the value at the pointer with the declared literal', async () => {
  const json = JSON.stringify({ total: 1, paid: true, items: [{ id: 1 }] });
  const pass = await runHttpStep(step({ expect_status: null, expect_json: { pointer: '/total', equals: 1 } }), options(reply(200, json)));
  assert.equal(pass.status, 'passed');
  const object = await runHttpStep(step({ expect_status: null, expect_json: { pointer: '/items/0', equals: { id: 1 } } }), options(reply(200, json)));
  assert.equal(object.status, 'passed');
  const wrong = await runHttpStep(step({ expect_status: null, expect_json: { pointer: '/total', equals: 2 } }), options(reply(200, json)));
  assert.deepEqual([wrong.status, wrong.detail], ['failed', 'GET /api -> 200; /total is 1, expected 2']);
  const absent = await runHttpStep(step({ expect_status: null, expect_json: { pointer: '/nope', equals: 1 } }), options(reply(200, json)));
  assert.match(absent.detail, /\/nope is absent/);
  const notJson = await runHttpStep(step({ expect_status: null, expect_json: { pointer: '/a', equals: 1 } }), options(reply(200, '<html>')));
  assert.match(notJson.detail, /not JSON/);
});

test('method, headers and body reach the server; redirects are never followed', async () => {
  const seen = [];
  await runHttpStep(step({ method: 'POST', headers: [{ name: 'x-token', value: 't' }], body: 'hello', expect_status: 200 }), options(async (url, init) => {
    seen.push([url, init.method, init.headers, init.body, init.redirect]);
    return { status: 200, text: async () => '' };
  }));
  assert.deepEqual(seen, [['http://127.0.0.1:3000/api', 'POST', { 'x-token': 't' }, 'hello', 'manual']]);
  const redirect = await runHttpStep(step({ expect_status: 302 }), options(reply(302)));
  assert.equal(redirect.status, 'passed');
});

test('a host that is neither loopback nor allowed fails without any request', async () => {
  let calls = 0;
  const result = await runHttpStep(step({ url: 'http://example.com/x' }), options(async () => { calls += 1; return { status: 200, text: async () => '' }; }));
  assert.equal(result.status, 'failed');
  assert.match(result.detail, /example\.com is neither loopback nor listed in allowed_hosts/);
  assert.equal(calls, 0);
});

test('a request that does not answer in time fails with its timeout', async () => {
  const result = await runHttpStep(step(), options((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))), { timeoutMs: 30 }));
  assert.deepEqual([result.status, result.detail], ['failed', 'GET /api: no answer within 30 ms']);
});

test('a connection error is the detail, not an exception', async () => {
  const result = await runHttpStep(step(), options(async () => { throw new TypeError('fetch failed'); }));
  assert.deepEqual([result.status, result.detail], ['failed', 'GET /api: fetch failed']);
});
