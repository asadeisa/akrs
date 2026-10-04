// The browser driver of the scenario browser steps, over one CDP connection (P2-W13). Every expression sent to the page is a
// fixed built-in program that starts with a `/*akrs:<name>*/` marker and receives the contract's values as JSON data, never
// spliced into code: a contract cannot run JavaScript.
import { CdpTimeoutError } from '../browser/cdp.js';
import { BROWSER_POLICY } from '../browser/policy.js';
import { collectConsole, collectNetwork, outlineAccessibility, timingsOf } from '../browser/collectors.js';
import { withBrowser } from '../browser/launch.js';

const { caps } = BROWSER_POLICY;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LOCATE = (target) => `/*akrs:locate*/(() => {
  const target = ${JSON.stringify(target)};
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const roles = { button: 'button,input[type=button],input[type=submit],[role=button]', link: 'a[href],[role=link]', textbox: 'input:not([type]),input[type=text],input[type=email],input[type=search],input[type=password],textarea,[role=textbox]',
    checkbox: 'input[type=checkbox],[role=checkbox]', heading: 'h1,h2,h3,h4,h5,h6,[role=heading]', img: 'img,[role=img]', listitem: 'li,[role=listitem]', tab: '[role=tab]', menuitem: '[role=menuitem]' };
  const nameOf = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || '').trim();
  let found = null;
  if (target.selector !== undefined) found = document.querySelector(target.selector);
  else if (target.text !== undefined) {
    const all = [...document.body.querySelectorAll('*')].filter((el) => visible(el) && (el.innerText || el.value || '').includes(target.text));
    const exact = all.filter((el) => (el.innerText || el.value || '').trim() === target.text);
    const pool = exact.length > 0 ? exact : all;
    found = pool.find((el) => !pool.some((other) => other !== el && el.contains(other))) || null;
  } else {
    const selector = roles[target.role] || '[role="' + target.role + '"]';
    found = [...document.querySelectorAll(selector)].find((el) => visible(el) && nameOf(el) === target.name) || null;
  }
  if (!found) return null;
  found.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = found.getBoundingClientRect();
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
})()`;
const FOCUS = (selector) => `/*akrs:focus*/(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.focus(); if (typeof el.select === 'function') el.select(); return true; })()`;
const WAIT = (target) => `/*akrs:wait*/(() => { const target = ${JSON.stringify(target)};
  if (target.text !== undefined) return document.body ? document.body.innerText.includes(target.text) : false;
  if (target.selector !== undefined) return document.querySelector(target.selector) !== null;
  return location.href === target.url || (target.url.startsWith('/') && location.pathname + location.search === target.url); })()`;
const TEXT = (text) => `/*akrs:text*/(document.body ? document.body.innerText.includes(${JSON.stringify(text)}) : false)`;
const TIMING = '/*akrs:timing*/(() => { const entry = performance.getEntriesByType("navigation")[0]; return entry ? entry.toJSON() : null; })()';
const LCP = '/*akrs:lcp*/new Promise((resolve) => { let last = null; try { new PerformanceObserver((list) => { for (const entry of list.getEntries()) last = entry.startTime; }).observe({ type: "largest-contentful-paint", buffered: true }); } catch (error) { resolve(null); return; } setTimeout(() => resolve(last), 100); })';

const KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' }, Tab: { code: 'Tab', vk: 9 }, Escape: { code: 'Escape', vk: 27 }, Backspace: { code: 'Backspace', vk: 8 }, Delete: { code: 'Delete', vk: 46 },
  ArrowUp: { code: 'ArrowUp', vk: 38 }, ArrowDown: { code: 'ArrowDown', vk: 40 }, ArrowLeft: { code: 'ArrowLeft', vk: 37 }, ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 }, End: { code: 'End', vk: 35 }, PageUp: { code: 'PageUp', vk: 33 }, PageDown: { code: 'PageDown', vk: 34 }, ' ': { code: 'Space', vk: 32, text: ' ' },
};
function keyIdentity(key) {
  if (KEYS[key] !== undefined) return KEYS[key];
  if (/^[a-z]$/i.test(key)) return { code: `Key${key.toUpperCase()}`, vk: key.toUpperCase().charCodeAt(0), text: key };
  if (/^[0-9]$/.test(key)) return { code: `Digit${key}`, vk: key.charCodeAt(0), text: key };
  throw new Error(`unknown key: ${key}`);
}

const describe = (target) => {
  if (target.selector !== undefined) return `no element matches ${target.selector}`;
  if (target.text !== undefined) return `no element with the text ${JSON.stringify(target.text)}`;
  return `no ${target.role} named ${JSON.stringify(target.name)}`;
};

// -> the driver object the step executor talks to
export function createCdpDriver(conn, { timeoutMs = 30000, sleep = defaultSleep } = {}) {
  let sessionId = null;
  let targetId = null;
  const all = [];
  let since = [];
  const idle = new Set();
  const call = (method, params = {}) => conn.send(method, params, { sessionId });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails !== undefined) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'evaluation failed');
    return result?.value;
  };
  const listen = (event) => {
    if (sessionId === null || event.sessionId !== sessionId) return;
    all.push(event);
    since.push(event);
    if (event.method === 'Page.lifecycleEvent' && event.params.name === 'networkIdle') idle.add(event.params.loaderId);
  };

  const driver = {
    async open() {
      conn.onEvent(listen);
      ({ targetId } = await conn.send('Target.createTarget', { url: 'about:blank' }));
      ({ sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true }));
      await call('Page.enable');
      await call('Page.setLifecycleEventsEnabled', { enabled: true });
      await call('Runtime.enable');
      await call('Log.enable');
      await call('Network.enable');
    },
    async close() {
      if (targetId !== null && !conn.closed) await conn.send('Target.closeTarget', { targetId }, { timeoutMs: 1000 }).catch(() => {});
    },
    async goto(url) {
      since = [];
      const navigation = await call('Page.navigate', { url });
      if (navigation.errorText !== undefined) throw new Error(`navigation failed: ${navigation.errorText}`);
      if (idle.has(navigation.loaderId)) return;
      try {
        await conn.waitForEvent((event) => event.sessionId === sessionId && event.method === 'Page.lifecycleEvent' && event.params.name === 'networkIdle' && event.params.loaderId === navigation.loaderId, timeoutMs);
      } catch (error) {
        if (error instanceof CdpTimeoutError) throw new Error(`the page was not idle within ${timeoutMs} ms`);
        throw error;
      }
    },
    async click(target) {
      const point = await evaluate(LOCATE(target));
      if (point === null || point === undefined) throw new Error(describe(target));
      for (const type of ['mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
    },
    async fill(selector, value) {
      if ((await evaluate(FOCUS(selector))) !== true) throw new Error(`no element matches ${selector}`);
      await call('Input.insertText', { text: value });
    },
    async press(key) {
      const identity = keyIdentity(key);
      const common = { key, code: identity.code, windowsVirtualKeyCode: identity.vk };
      await call('Input.dispatchKeyEvent', { type: 'keyDown', ...common, ...(identity.text === undefined ? {} : { text: identity.text }) });
      await call('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
    },
    async waitFor(target, limitMs) {
      const startedAt = Date.now();
      for (;;) {
        if ((await evaluate(WAIT(target))) === true) return true;
        if (Date.now() - startedAt >= limitMs) return false;
        await sleep(BROWSER_POLICY.timeouts.poll_ms);
      }
    },
    async expectText(text) {
      return (await evaluate(TEXT(text))) === true;
    },
    async consoleErrors() {
      return collectConsole(since, caps.console_entries).entries;
    },
    async screenshot() {
      return Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64');
    },
    async viewport(width, height) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    },
    async timings() {
      return timingsOf(await evaluate(TIMING));
    },
    async measure(metric) {
      if (metric === 'lcp') {
        const value = await evaluate(LCP);
        return typeof value === 'number' ? Math.round(value) : null;
      }
      const timings = await driver.timings();
      return metric === 'ttfb' ? timings.ttfb_ms : timings.load_ms;
    },
    async consoleLog() {
      const { entries, total } = collectConsole(all, caps.console_entries);
      if (total === 0) return 'no console errors\n';
      return `${entries.map(({ kind, text, url, line }) => `${kind}: ${text.replace(/\s*\n\s*/g, ' ')}${url === null ? '' : ` (${url}${line === null ? '' : `:${line}`})`}`).join('\n')}\n${total > entries.length ? `... ${total - entries.length} more not shown\n` : ''}`;
    },
    async networkLog() {
      const { failed, failed_total: failedTotal, total_requests: totalRequests, truncated } = collectNetwork(all, caps.network_entries);
      return `${JSON.stringify({ total_requests: totalRequests, failed_total: failedTotal, truncated, failed }, null, 2)}\n`;
    },
    async a11yText() {
      const { nodes, total, truncated } = outlineAccessibility((await call('Accessibility.getFullAXTree')).nodes, caps.a11y_nodes);
      const lines = nodes.map(({ depth, role, name }) => `${'  '.repeat(depth)}${role}${name === '' ? '' : ` ${JSON.stringify(name)}`}`);
      return `${lines.join('\n')}\n${truncated ? `... ${total - nodes.length} more nodes not shown\n` : ''}`;
    },
  };
  return driver;
}

// A real browser as a driver that stays open until `close()`: -> { ok: true, driver, browser, close() -> teardown }
// | { ok: false, reason, message }.  `close` always ends the browser, its tree and its temp profile.
export async function openRealDriver({ executable, env, platform, signal, timeoutMs }) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let announce;
  const opened = new Promise((resolve) => { announce = resolve; });
  const running = withBrowser({ executable, env, platform, signal, timeoutMs }, async (conn) => {
    const driver = createCdpDriver(conn, { timeoutMs });
    await driver.open();
    const browser = await conn.send('Browser.getVersion').then((reply) => String(reply.product ?? '') || null, () => null);
    announce({ ok: true, driver, browser });
    await held;
  });
  running.then((result) => { if (!result.ok) announce({ ok: false, reason: result.reason, message: result.message }); });
  const first = await opened;
  if (!first.ok) return first;
  return { ...first, close: async () => { release(); return (await running).teardown; } };
}
