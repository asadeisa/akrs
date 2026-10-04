// P2-W14: the CDP driver of the browser steps against a fake peer. Every page expression starts with a `/*akrs:<name>*/`
// marker, so the fake can answer by name; the real JavaScript is exercised by the real-browser smoke test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CdpConnection } from '../../lib/browser/cdp.js';
import { createCdpDriver } from '../../lib/scenario/driver.js';
import { FakeTransport, SAMPLE_AX } from '../browser/support.js';

function setup(answers = {}) {
  const transport = new FakeTransport((message, peer) => {
    const reply = (result) => ({ id: message.id, ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }), result });
    if (message.method === 'Target.createTarget') return reply({ targetId: 'T1' });
    if (message.method === 'Target.attachToTarget') return reply({ sessionId: 'S1' });
    if (message.method === 'Page.navigate') {
      if (answers.navigateError !== undefined) return reply({ frameId: 'F', loaderId: 'L2', errorText: answers.navigateError });
      setTimeout(() => {
        for (const [method, params] of answers.events ?? []) peer.event(method, params);
        peer.event('Page.lifecycleEvent', { name: 'networkIdle', loaderId: 'about-blank', frameId: 'F' });
        peer.event('Page.lifecycleEvent', { name: 'networkIdle', loaderId: 'L2', frameId: 'F' });
      }, 0);
      return reply({ frameId: 'F', loaderId: 'L2' });
    }
    if (message.method === 'Runtime.evaluate') {
      const marker = /^\/\*akrs:([a-z-]+)\*\//.exec(message.params.expression)?.[1] ?? 'unmarked';
      const value = typeof answers[marker] === 'function' ? answers[marker](message.params.expression) : answers[marker];
      return reply({ result: { type: 'object', value } });
    }
    if (message.method === 'Page.captureScreenshot') return reply({ data: Buffer.from('PNGDATA').toString('base64') });
    if (message.method === 'Accessibility.getFullAXTree') return reply(SAMPLE_AX);
    return reply({});
  });
  const conn = new CdpConnection(transport, { timeoutMs: 2000 });
  const driver = createCdpDriver(conn, { timeoutMs: 2000, sleep: () => new Promise((resolve) => setTimeout(resolve, 5)) });
  return { transport, driver, methods: () => transport.sent.map(({ method }) => method), sent: (method) => transport.sent.filter((entry) => entry.method === method) };
}

test('opening makes one target and enables only the domains the steps need', async () => {
  const { driver, methods } = setup();
  await driver.open();
  assert.deepEqual(methods().slice(0, 2), ['Target.createTarget', 'Target.attachToTarget']);
  for (const domain of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable']) assert.ok(methods().includes(domain), domain);
});

test('goto waits for the idle of its own navigation and fails with the browser text', async () => {
  const ok = setup();
  await ok.driver.open();
  await ok.driver.goto('http://127.0.0.1:3000/');
  assert.deepEqual(ok.sent('Page.navigate')[0].params, { url: 'http://127.0.0.1:3000/' });
  const bad = setup({ navigateError: 'net::ERR_CONNECTION_REFUSED' });
  await bad.driver.open();
  await assert.rejects(bad.driver.goto('http://127.0.0.1:1/'), /navigation failed: net::ERR_CONNECTION_REFUSED/);
});

test('console errors count only what happened since the last goto', async () => {
  const { driver, transport } = setup({ events: [['Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'after-goto' }] }]] });
  await driver.open();
  transport.event('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'before-goto' }] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await driver.goto('http://127.0.0.1:3000/');
  const errors = await driver.consoleErrors();
  assert.deepEqual(errors.map(({ text }) => text), ['after-goto']);
});

test('click finds its target in the page and clicks the centre with the mouse', async () => {
  const { driver, sent } = setup({ locate: { x: 120, y: 44 } });
  await driver.open();
  await driver.click({ selector: '#save' });
  assert.deepEqual(sent('Input.dispatchMouseEvent').map(({ params }) => [params.type, params.x, params.y, params.button, params.clickCount]), [['mousePressed', 120, 44, 'left', 1], ['mouseReleased', 120, 44, 'left', 1]]);
});

test('a click target that is not there fails with what was looked for', async () => {
  const { driver } = setup({ locate: null });
  await driver.open();
  await assert.rejects(driver.click({ text: 'Save' }), /no element with the text "Save"/);
  await assert.rejects(driver.click({ selector: '#x' }), /no element matches #x/);
  await assert.rejects(driver.click({ role: 'button', name: 'Go' }), /no button named "Go"/);
});

test('the target is passed to the page as data, never spliced into code', async () => {
  const seen = [];
  const { driver } = setup({ locate: (expression) => { seen.push(expression); return { x: 1, y: 1 }; } });
  await driver.open();
  await driver.click({ text: '"); alert(1); ("' });
  assert.ok(seen[0].includes(JSON.stringify('"); alert(1); ("')));
  assert.ok(!/alert\(1\);\s*\(/.test(seen[0].replace(JSON.stringify('"); alert(1); ("'), '')));
});

test('fill focuses the field and inserts the text', async () => {
  const { driver, sent } = setup({ focus: true });
  await driver.open();
  await driver.fill('#name', 'Ada');
  assert.deepEqual(sent('Input.insertText').map(({ params }) => params), [{ text: 'Ada' }]);
  const missing = setup({ focus: false });
  await missing.driver.open();
  await assert.rejects(missing.driver.fill('#nope', 'x'), /no element matches #nope/);
});

test('press sends a key down and a key up with the key identity', async () => {
  const { driver, sent } = setup();
  await driver.open();
  await driver.press('Enter');
  await driver.press('a');
  const keys = sent('Input.dispatchKeyEvent').map(({ params }) => [params.type, params.key, params.code, params.windowsVirtualKeyCode]);
  assert.deepEqual(keys, [['keyDown', 'Enter', 'Enter', 13], ['keyUp', 'Enter', 'Enter', 13], ['keyDown', 'a', 'KeyA', 65], ['keyUp', 'a', 'KeyA', 65]]);
  await assert.rejects(driver.press('NoSuchKey'), /unknown key/);
});

test('waitFor polls until the page has it and says false at the deadline', async () => {
  let calls = 0;
  const { driver } = setup({ wait: () => { calls += 1; return calls >= 3; } });
  await driver.open();
  assert.equal(await driver.waitFor({ text: 'Saved' }, 2000), true);
  assert.equal(calls, 3);
  const never = setup({ wait: false });
  await never.driver.open();
  assert.equal(await never.driver.waitFor({ selector: '#x' }, 60), false);
});

test('expectText asks the page for the text', async () => {
  const { driver } = setup({ text: (expression) => expression.includes(JSON.stringify('Hello')) });
  await driver.open();
  assert.equal(await driver.expectText('Hello'), true);
  assert.equal(await driver.expectText('Bye'), false);
});

test('a screenshot is the PNG bytes; the viewport is a device override', async () => {
  const { driver, sent } = setup();
  await driver.open();
  assert.equal((await driver.screenshot()).toString(), 'PNGDATA');
  await driver.viewport(390, 844);
  assert.deepEqual(sent('Emulation.setDeviceMetricsOverride')[0].params, { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
});

test('measure reads load and ttfb from the navigation timing and lcp from its observer', async () => {
  const { driver } = setup({ timing: { responseStart: 12.4, loadEventEnd: 120.7 }, lcp: 301.2 });
  await driver.open();
  assert.equal(await driver.measure('load'), 121);
  assert.equal(await driver.measure('ttfb'), 12);
  assert.equal(await driver.measure('lcp'), 301);
  const none = setup({ timing: null, lcp: null });
  await none.driver.open();
  assert.equal(await none.driver.measure('load'), null);
  assert.equal(await none.driver.measure('lcp'), null);
});

test('the evidence texts are built from what the page did', async () => {
  const { driver, transport } = setup({
    events: [
      ['Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'boom' }] }],
      ['Network.requestWillBeSent', { requestId: '1', type: 'Image', request: { url: 'http://x/m.png', method: 'GET' } }],
      ['Network.responseReceived', { requestId: '1', type: 'Image', response: { url: 'http://x/m.png', status: 404 } }],
    ],
  });
  await driver.open();
  await driver.goto('http://127.0.0.1:3000/');
  assert.match(await driver.consoleLog(), /console: boom/);
  assert.deepEqual(JSON.parse(await driver.networkLog()).failed[0], { method: 'GET', url: 'http://x/m.png', status: 404, error: null, type: 'Image' });
  assert.match(await driver.a11yText(), /RootWebArea "Demo"\n {2}heading "Reservations"/);
  assert.equal(transport.closed, false);
});

test('close closes the target', async () => {
  const { driver, methods } = setup();
  await driver.open();
  await driver.close();
  assert.ok(methods().includes('Target.closeTarget'));
});
