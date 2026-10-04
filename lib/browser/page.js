// The browser engine of `akrs page`: find a browser, start it, read one page, end the browser. It returns data; it writes no
// workflow file and prints nothing.
import { discoverBrowser } from './discovery.js';
import { withBrowser } from './launch.js';
import { runPageSession } from './session.js';

const REMEDIATION_LAUNCH = 'The browser could not be started. Check that the executable runs (try it with --headless), or set AKRS_BROWSER_PATH to another Chrome, Edge or Chromium; on Linux as root or in a container set AKRS_BROWSER_NO_SANDBOX=1 if the browser refuses to start.';

// request: { url, collect, viewport, waitFor, timeoutMs }; options: { env, platform, signal, launch? (overrides for tests) }
// -> { ok: true, page, screenshot, duration_ms, transport, teardown }
//  | { ok: false, kind: 'blocked', reason, tried?, remediation, message? }
//  | { ok: false, kind: 'failed', reason, message, teardown }
export async function collectPage(request, { env = process.env, platform = process.platform, signal = null, launch = {} } = {}) {
  let executable = launch.executable;
  if (executable === undefined) {
    const found = discoverBrowser({ platform, env });
    if (!found.ok) return { ok: false, kind: 'blocked', reason: found.reason, tried: found.tried, remediation: found.remediation };
    executable = found.path;
  }
  const startedAt = Date.now();
  let transport = 'pipe';
  const run = await withBrowser({ executable, env, platform, signal, timeoutMs: request.timeoutMs, ...launch }, async (conn, launched) => {
    transport = launched.transport;
    const version = await conn.send('Browser.getVersion').then((reply) => String(reply.product ?? ''), () => null);
    return runPageSession(conn, request, { browser: version === '' ? null : version });
  });
  if (!run.ok) {
    if (run.reason === 'launch_failed') return { ok: false, kind: 'blocked', reason: 'launch_failed', tried: [{ source: 'launch', path: executable }], remediation: REMEDIATION_LAUNCH, message: run.message };
    return { ok: false, kind: 'failed', reason: run.reason === 'work_failed' ? 'protocol_error' : run.reason, message: run.message, teardown: run.teardown };
  }
  if (!run.value.ok) return { ok: false, kind: 'failed', reason: run.value.reason, message: run.value.message, teardown: run.teardown };
  return { ok: true, page: run.value.page, screenshot: run.value.screenshot, duration_ms: Date.now() - startedAt, transport, teardown: run.teardown };
}
