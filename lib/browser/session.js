// One page session over a CDP connection: open a target, navigate, wait for the navigation to be idle, collect. It starts
// no process and writes no file; the caller owns both.
import { BROWSER_POLICY } from './policy.js';
import { capText, collectConsole, collectNetwork, outlineAccessibility, timingsOf } from './collectors.js';
import { CdpTimeoutError } from './cdp.js';

const { caps } = BROWSER_POLICY;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failure = (reason, message) => ({ ok: false, reason, message });
const evaluate = async (conn, sessionId, expression) => {
  const { result, exceptionDetails } = await conn.send('Runtime.evaluate', { expression, returnByValue: true }, { sessionId });
  if (exceptionDetails !== undefined) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'evaluation failed');
  return result?.value;
};

// request: { url, collect, viewport, waitFor, timeoutMs }; options: { sleep, schedule, browser }
// -> { ok: true, page, screenshot } | { ok: false, reason, message }
export async function runPageSession(conn, request, { sleep = defaultSleep, browser = null } = {}) {
  const { collect, timeoutMs } = request;
  const events = [];
  let sessionId = null;
  let targetId = null;
  const off = conn.onEvent((event) => {
    if (event.sessionId === sessionId && sessionId !== null) events.push(event);
  });
  try {
    ({ targetId } = await conn.send('Target.createTarget', { url: 'about:blank' }));
    ({ sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true }));
    const call = (method, params = {}) => conn.send(method, params, { sessionId });
    await call('Page.enable');
    await call('Page.setLifecycleEventsEnabled', { enabled: true });
    await call('Runtime.enable');
    if (collect.console) await call('Log.enable');
    if (collect.network) await call('Network.enable');
    if (request.viewport !== null) await call('Emulation.setDeviceMetricsOverride', { width: request.viewport.width, height: request.viewport.height, deviceScaleFactor: 1, mobile: false });

    const startedAt = Date.now();
    const navigation = await call('Page.navigate', { url: request.url });
    if (navigation.errorText !== undefined) return failure('navigation_failed', `the browser could not open ${request.url}: ${navigation.errorText}`);
    const idle = await conn.waitForEvent((event) => event.sessionId === sessionId && event.method === 'Page.lifecycleEvent'
      && event.params.name === 'networkIdle' && event.params.loaderId === navigation.loaderId, timeoutMs).then(() => true, (error) => {
      if (error instanceof CdpTimeoutError) return false;
      throw error;
    });
    if (!idle) return failure('timeout', `the page was not idle within ${timeoutMs} ms`);

    let waitFor = null;
    if (request.waitFor !== null) {
      const expression = `document.body ? document.body.innerText.includes(${JSON.stringify(request.waitFor)}) : false`;
      let found = await evaluate(conn, sessionId, expression);
      while (!found && Date.now() - startedAt < timeoutMs) {
        await sleep(BROWSER_POLICY.timeouts.poll_ms);
        found = await evaluate(conn, sessionId, expression);
      }
      if (!found) return failure('wait_for_timeout', `the text was not on the page within ${timeoutMs} ms`);
      waitFor = { text: request.waitFor, found: true };
    }

    const identity = JSON.parse(await evaluate(conn, sessionId, 'JSON.stringify({ title: document.title, url: location.href })'));
    const timing = JSON.parse(await evaluate(conn, sessionId, 'JSON.stringify(performance.getEntriesByType("navigation")[0] || null)'));
    const page = {
      title: String(identity.title).slice(0, caps.entry_text_chars),
      final_url: String(identity.url).slice(0, caps.url_chars),
      viewport: request.viewport,
      browser,
      text: collect.text ? capText(await evaluate(conn, sessionId, 'document.body ? document.body.innerText : ""'), caps.text_chars) : null,
      a11y: collect.a11y ? outlineAccessibility((await call('Accessibility.getFullAXTree')).nodes, caps.a11y_nodes) : null,
      console: collect.console ? collectConsole(events, caps.console_entries) : null,
      network: collect.network ? collectNetwork(events, caps.network_entries) : null,
      timings: timingsOf(timing),
      wait_for: waitFor,
    };
    let screenshot = null;
    if (collect.screenshot) screenshot = Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64');
    return { ok: true, page, screenshot };
  } catch (error) {
    if (error instanceof CdpTimeoutError) return failure('timeout', error.message);
    return failure('protocol_error', error instanceof Error ? error.message : 'protocol error');
  } finally {
    off();
    if (targetId !== null && !conn.closed) await conn.send('Target.closeTarget', { targetId }, { timeoutMs: 1000 }).catch(() => {});
  }
}
