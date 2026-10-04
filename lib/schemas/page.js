// The closed `data` schema of `page` (P2-W13). Everything read from the page is untrusted data; nothing here can express a
// verdict. Three kinds: the page was read (`page`), no browser could be used (`page_blocked`), the page could not be read
// (`page_failed`).
import { PAGE_BLOCK_REASONS, PAGE_FAILURE_REASONS } from '../browser/policy.js';
import { checkBoolean, checkEach, checkEnum, checkInteger, checkLiteral, checkText, validateClosedObject } from './artifact-kit.js';
import { issue, validationResult } from './validation.js';

export const PAGE_SCHEMA = 'akrs.page/v1';
export const PAGE_KINDS = Object.freeze(['page', 'page_blocked', 'page_failed']);
export const PAGE_COLLECTORS = Object.freeze(['a11y', 'console', 'network', 'text']);
export const PAGE_KEYS = Object.freeze([
  'kind', 'packet_version', 'url', 'final_url', 'title', 'untrusted', 'transport', 'browser', 'viewport', 'collected', 'duration_ms', 'text', 'a11y',
  'console', 'network', 'timings', 'wait_for', 'screenshot',
]);
export const PAGE_BLOCKED_KEYS = Object.freeze(['kind', 'packet_version', 'url', 'reason', 'searched', 'remediation', 'message']);
export const PAGE_FAILED_KEYS = Object.freeze(['kind', 'packet_version', 'url', 'reason', 'message']);
const known = (value, keys, path, issues) => validateClosedObject(value, keys, path, issues);
const line = (value, path, issues, nullable = false) => checkText(value, path, issues, { singleLine: true, nullable, allowEmpty: true });
const count = (value, path, issues) => checkInteger(value, path, issues, { min: 0 });

function checkTimings(value, path, issues) {
  if (!known(value, ['ttfb_ms', 'dom_content_loaded_ms', 'load_ms'], path, issues)) return;
  for (const key of ['ttfb_ms', 'dom_content_loaded_ms', 'load_ms']) checkInteger(value[key], `${path}.${key}`, issues, { min: 1, nullable: true });
}

export function validatePage(value) {
  const issues = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issue(issues, '$', 'invalid_type', 'must be an object');
    return validationResult(issues);
  }
  const kind = value.kind;
  const keys = { page: PAGE_KEYS, page_blocked: PAGE_BLOCKED_KEYS, page_failed: PAGE_FAILED_KEYS }[kind];
  if (keys === undefined) {
    issue(issues, '$.kind', 'invalid_value', `must be one of: ${PAGE_KINDS.join(', ')}`);
    return validationResult(issues);
  }
  if (!known(value, keys, '$', issues)) return validationResult(issues);
  checkLiteral(value.packet_version, PAGE_SCHEMA, '$.packet_version', issues);
  line(value.url, '$.url', issues);
  if (kind === 'page_failed') {
    checkEnum(value.reason, PAGE_FAILURE_REASONS, '$.reason', issues);
    line(value.message, '$.message', issues);
    return validationResult(issues);
  }
  if (kind === 'page_blocked') {
    checkEnum(value.reason, PAGE_BLOCK_REASONS, '$.reason', issues);
    checkEach(value.searched, '$.searched', issues, (entry, at) => {
      if (known(entry, ['source', 'path'], at, issues)) {
        line(entry.source, `${at}.source`, issues);
        line(entry.path, `${at}.path`, issues);
      }
    });
    line(value.remediation, '$.remediation', issues);
    line(value.message, '$.message', issues, true);
    return validationResult(issues);
  }
  line(value.final_url, '$.final_url', issues);
  line(value.title, '$.title', issues);
  checkLiteral(value.untrusted, true, '$.untrusted', issues);
  checkEnum(value.transport, ['pipe', 'port'], '$.transport', issues);
  line(value.browser, '$.browser', issues, true);
  if (value.viewport !== null && known(value.viewport, ['width', 'height'], '$.viewport', issues)) {
    count(value.viewport.width, '$.viewport.width', issues);
    count(value.viewport.height, '$.viewport.height', issues);
  }
  checkEach(value.collected, '$.collected', issues, (entry, at) => checkEnum(entry, PAGE_COLLECTORS, at, issues));
  count(value.duration_ms, '$.duration_ms', issues);
  if (value.text !== null && known(value.text, ['text', 'chars', 'truncated'], '$.text', issues)) {
    checkText(value.text.text, '$.text.text', issues, { allowEmpty: true });
    count(value.text.chars, '$.text.chars', issues);
    checkBoolean(value.text.truncated, '$.text.truncated', issues);
  }
  if (value.a11y !== null && known(value.a11y, ['nodes', 'total', 'truncated'], '$.a11y', issues)) {
    checkEach(value.a11y.nodes, '$.a11y.nodes', issues, (entry, at) => {
      if (!known(entry, ['depth', 'role', 'name'], at, issues)) return;
      count(entry.depth, `${at}.depth`, issues);
      line(entry.role, `${at}.role`, issues);
      checkText(entry.name, `${at}.name`, issues, { allowEmpty: true });
    });
    count(value.a11y.total, '$.a11y.total', issues);
    checkBoolean(value.a11y.truncated, '$.a11y.truncated', issues);
  }
  if (value.console !== null && known(value.console, ['entries', 'errors', 'total', 'truncated'], '$.console', issues)) {
    checkEach(value.console.entries, '$.console.entries', issues, (entry, at) => {
      if (!known(entry, ['kind', 'text', 'url', 'line'], at, issues)) return;
      checkEnum(entry.kind, ['console', 'exception', 'log'], `${at}.kind`, issues);
      checkText(entry.text, `${at}.text`, issues, { allowEmpty: true });
      line(entry.url, `${at}.url`, issues, true);
      checkInteger(entry.line, `${at}.line`, issues, { min: 1, nullable: true });
    });
    count(value.console.errors, '$.console.errors', issues);
    count(value.console.total, '$.console.total', issues);
    checkBoolean(value.console.truncated, '$.console.truncated', issues);
  }
  if (value.network !== null && known(value.network, ['failed', 'failed_total', 'total_requests', 'truncated'], '$.network', issues)) {
    checkEach(value.network.failed, '$.network.failed', issues, (entry, at) => {
      if (!known(entry, ['method', 'url', 'status', 'error', 'type'], at, issues)) return;
      line(entry.method, `${at}.method`, issues);
      line(entry.url, `${at}.url`, issues);
      checkInteger(entry.status, `${at}.status`, issues, { min: 100, max: 999, nullable: true });
      line(entry.error, `${at}.error`, issues, true);
      line(entry.type, `${at}.type`, issues);
    });
    count(value.network.failed_total, '$.network.failed_total', issues);
    count(value.network.total_requests, '$.network.total_requests', issues);
    checkBoolean(value.network.truncated, '$.network.truncated', issues);
  }
  checkTimings(value.timings, '$.timings', issues);
  if (value.wait_for !== null && known(value.wait_for, ['text', 'found'], '$.wait_for', issues)) {
    line(value.wait_for.text, '$.wait_for.text', issues);
    checkBoolean(value.wait_for.found, '$.wait_for.found', issues);
  }
  if (value.screenshot !== null && known(value.screenshot, ['path', 'bytes'], '$.screenshot', issues)) {
    line(value.screenshot.path, '$.screenshot.path', issues);
    checkInteger(value.screenshot.bytes, '$.screenshot.bytes', issues, { min: 1 });
  }
  return validationResult(issues);
}
