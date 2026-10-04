// The HTTP step of a scenario: built-in fetch to a loopback or allow-listed host, no redirect followed, mechanical facts only.
const BODY_CAP_BYTES = 1048576;
const DETAIL_CAP = 200;
const LOOPBACK = /^(?:localhost|\[::1\]|127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3}))$/;

export const cutLine = (value, limit = DETAIL_CAP) => {
  const line = String(value).split(/\r?\n/)[0];
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
};

export function resolveUrl(url, baseUrl) {
  return url.startsWith('/') ? new URL(url, baseUrl).href : url;
}

export function hostAllowed(url, allowedHosts) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return LOOPBACK.test(host) || allowedHosts.includes(host);
}

// RFC 6901: -> { found: true, value } | { found: false }
export function resolvePointer(value, pointer) {
  if (pointer === '') return { found: true, value };
  let current = value;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length) return { found: false };
      current = current[Number(key)];
    } else if (current !== null && typeof current === 'object' && Object.hasOwn(current, key)) {
      current = current[key];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const shown = (value) => cutLine(JSON.stringify(value));

// step: the closed `http` scenario step; options: { baseUrl, allowedHosts, timeoutMs, fetchImpl }
// -> { status: 'passed' | 'failed', detail }
export async function runHttpStep(step, { baseUrl, allowedHosts, timeoutMs, fetchImpl = fetch }) {
  const url = resolveUrl(step.url, baseUrl);
  const label = `${step.method} ${step.url}`;
  if (!hostAllowed(url, allowedHosts)) {
    return { status: 'failed', detail: `${label}: host ${new URL(url).hostname} is neither loopback nor listed in allowed_hosts` };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = Object.fromEntries((step.headers ?? []).map(({ name, value }) => [name, value]));
    const response = await fetchImpl(url, {
      method: step.method, headers, redirect: 'manual', signal: controller.signal, ...(step.body === null || step.body === undefined ? {} : { body: step.body }),
    });
    const problems = [];
    if (step.expect_status !== null && step.expect_status !== undefined && response.status !== step.expect_status) problems.push(`expected status ${step.expect_status}`);
    if (step.expect_json !== null && step.expect_json !== undefined) {
      const raw = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(Buffer.from(raw).subarray(0, BODY_CAP_BYTES).toString('utf8'));
      } catch {
        problems.push('the body is not JSON');
      }
      if (parsed !== undefined) {
        const found = resolvePointer(parsed, step.expect_json.pointer);
        if (!found.found) problems.push(`${step.expect_json.pointer} is absent`);
        else if (!same(found.value, step.expect_json.equals)) problems.push(`${step.expect_json.pointer} is ${shown(found.value)}, expected ${shown(step.expect_json.equals)}`);
      }
    }
    const answer = `${label} -> ${response.status}`;
    return problems.length === 0 ? { status: 'passed', detail: answer } : { status: 'failed', detail: `${answer}; ${problems.join('; ')}` };
  } catch (error) {
    if (error?.name === 'AbortError') return { status: 'failed', detail: `${label}: no answer within ${timeoutMs} ms` };
    return { status: 'failed', detail: `${label}: ${cutLine(error instanceof Error ? error.message : 'request failed')}` };
  } finally {
    clearTimeout(timer);
  }
}
