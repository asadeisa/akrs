// The collectors: pure functions over raw CDP data. No browser, no clock, no file.
import { BROWSER_POLICY } from './policy.js';

const { caps } = BROWSER_POLICY;
const clip = (value, limit) => (value.length > limit ? value.slice(0, limit) : value);

export function capText(value, limit) {
  const text = typeof value === 'string' ? value : '';
  return { text: clip(text, limit), chars: text.length, truncated: text.length > limit };
}

const SKIPPED_ROLES = new Set(['generic', 'none', 'StaticText', 'InlineTextBox', 'LineBreak']);

// Accessibility.getFullAXTree nodes -> { nodes: [{ depth, role, name }], total, truncated }, parent before child, tree order.
export function outlineAccessibility(nodes, limit) {
  if (!Array.isArray(nodes) || nodes.length === 0) return { nodes: [], total: 0, truncated: false };
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const roots = nodes.filter((node) => node.parentId === undefined || !byId.has(node.parentId));
  const out = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    const role = node.role?.value ?? '';
    const keep = node.ignored !== true && role !== '' && !SKIPPED_ROLES.has(role);
    if (keep) out.push({ depth, role, name: clip(String(node.name?.value ?? ''), caps.entry_text_chars) });
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child !== undefined) walk(child, keep ? depth + 1 : depth);
    }
  };
  for (const root of roots) walk(root, 0);
  return { nodes: out.slice(0, limit), total: out.length, truncated: out.length > limit };
}

const argText = (argument) => {
  if (argument.value !== undefined) return String(argument.value);
  return String(argument.description ?? argument.unserializableValue ?? argument.type ?? '');
};

// Runtime.consoleAPICalled / Runtime.exceptionThrown / Log.entryAdded events -> { entries, errors, total, truncated }
export function collectConsole(events, limit) {
  const all = [];
  for (const { method, params } of events) {
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      const frame = params.stackTrace?.callFrames?.[0];
      all.push({ kind: 'console', text: (params.args ?? []).map(argText).join(' '), url: frame?.url || null, line: frame === undefined ? null : frame.lineNumber + 1 });
    } else if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails ?? {};
      all.push({ kind: 'exception', text: details.exception?.description ?? details.text ?? 'exception', url: details.url || null, line: typeof details.lineNumber === 'number' ? details.lineNumber + 1 : null });
    } else if (method === 'Log.entryAdded' && params.entry?.level === 'error') {
      const entry = params.entry;
      all.push({ kind: 'log', text: entry.text ?? '', url: entry.url || null, line: typeof entry.lineNumber === 'number' && entry.lineNumber > 0 ? entry.lineNumber : null });
    }
  }
  const entries = all.slice(0, limit).map((entry) => ({ ...entry, text: clip(entry.text, caps.entry_text_chars), url: entry.url === null ? null : clip(entry.url, caps.url_chars) }));
  return { entries, errors: all.length, total: all.length, truncated: all.length > limit };
}

// Network.* events -> { failed, failed_total, total_requests, truncated }
export function collectNetwork(events, limit) {
  const requests = new Map();
  const failed = [];
  for (const { method, params } of events) {
    if (method === 'Network.requestWillBeSent') {
      requests.set(params.requestId, { method: params.request?.method ?? 'GET', url: params.request?.url ?? '', type: params.type ?? 'Other' });
    } else if (method === 'Network.responseReceived') {
      const known = requests.get(params.requestId) ?? { method: 'GET', url: params.response?.url ?? '', type: params.type ?? 'Other' };
      const status = params.response?.status ?? 0;
      if (status >= 400) failed.push({ method: known.method, url: known.url, status, error: null, type: known.type });
    } else if (method === 'Network.loadingFailed' && params.canceled !== true) {
      const known = requests.get(params.requestId) ?? { method: 'GET', url: '', type: params.type ?? 'Other' };
      failed.push({ method: known.method, url: known.url, status: null, error: params.errorText ?? 'failed', type: known.type });
    }
  }
  const kept = failed.slice(0, limit).map((entry) => ({ ...entry, url: clip(entry.url, caps.url_chars) }));
  return { failed: kept, failed_total: failed.length, total_requests: requests.size, truncated: failed.length > limit };
}

const whole = (value) => (typeof value === 'number' && value > 0 ? Math.round(value) : null);

// PerformanceNavigationTiming (as JSON) -> whole milliseconds, null where the page did not produce the number
export function timingsOf(navigation) {
  return {
    ttfb_ms: whole(navigation?.responseStart),
    dom_content_loaded_ms: whole(navigation?.domContentLoadedEventEnd),
    load_ms: whole(navigation?.loadEventEnd),
  };
}

// 'WIDTHxHEIGHT' -> { width, height } | null
export function parseViewport(value) {
  const match = /^([0-9]{1,5})x([0-9]{1,5})$/.exec(value);
  if (match === null) return null;
  const [width, height] = [Number(match[1]), Number(match[2])];
  const { min, max } = BROWSER_POLICY.viewport;
  return [width, height].every((side) => side >= min && side <= max) ? { width, height } : null;
}
