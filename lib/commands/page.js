// Handler of `page` (P2-W13): reads one running web page through an installed Chromium-family browser. It parses and checks
// the input, asks the browser engine, then wraps the result. The only write is the screenshot, to the snapshot-excluded
// cache or to a named evidence slot; no screenshot means no write.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { collectPage } from '../browser/page.js';
import { parseViewport } from '../browser/collectors.js';
import { PAGE_NEXT_COMMAND_BUILDERS } from '../browser/next-commands.js';
import { BROWSER_POLICY, PAGE_FINDING_CODES } from '../browser/policy.js';
import { CliUsageError } from '../core/errors.js';
import { createPacket } from '../core/packet.js';
import { isId } from '../schemas/common.js';
import { PAGE_SCHEMA } from '../schemas/page.js';
import { createPathService } from '../store/path-service.js';
import { EMPTY_SNAPSHOT } from '../store/snapshots/projections.js';
import { knownCommandsOf, resolveRoots, rootArgsOf } from './authoring.js';

const INTERRUPTIONS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const COLLECTOR_FLAGS = Object.freeze([['--text', 'text'], ['--a11y', 'a11y'], ['--console', 'console'], ['--network', 'network']]);
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const { timeouts } = BROWSER_POLICY;

function parseUrl(value) {
  if (value === undefined || value === '') throw new CliUsageError('page takes a URL: akrs page <url> [--text] [--a11y] [--console] [--network] [--screenshot] [--viewport 390x844] [--wait-for "<text>"] [--timeout-ms N]');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliUsageError(`page: ${JSON.stringify(value.slice(0, 80))} is not a URL`);
  }
  if (!BROWSER_POLICY.url.schemes.includes(url.protocol.slice(0, -1))) throw new CliUsageError('page reads http and https URLs only');
  if (url.username !== '' || url.password !== '') throw new CliUsageError('page does not take credentials in the URL');
  if (value.length > BROWSER_POLICY.url.max_chars) throw new CliUsageError(`page: the URL is longer than ${BROWSER_POLICY.url.max_chars} characters`);
  return url.href;
}

// --evidence-dir: workflow-relative verifications/<plan>/evidence[/<type>...], never anything else
function parseEvidenceDirectory(value) {
  const segments = value.split('/');
  const [head, plan, evidence, ...rest] = segments;
  if (head !== 'verifications' || !isId(plan) || evidence !== 'evidence' || !rest.every((segment) => SEGMENT.test(segment) && segment !== '..')) {
    throw new CliUsageError('--evidence-dir takes a workflow-relative evidence slot: verifications/<plan>/evidence[/<type>]');
  }
  return value;
}

function parseRequest(input) {
  const { flags } = input;
  const url = parseUrl(input.positionals.url);
  const named = COLLECTOR_FLAGS.filter(([flag]) => flags[flag] === true).map(([, name]) => name);
  const selected = named.length === 0 && flags['--screenshot'] !== true ? BROWSER_POLICY.collectors.default : named;
  const viewport = flags['--viewport'] === undefined ? null : parseViewport(flags['--viewport']);
  if (flags['--viewport'] !== undefined && viewport === null) throw new CliUsageError(`--viewport takes WIDTHxHEIGHT between ${BROWSER_POLICY.viewport.min} and ${BROWSER_POLICY.viewport.max}, for example 390x844`);
  const timeoutMs = flags['--timeout-ms'] ?? timeouts.default_ms;
  if (!Number.isInteger(timeoutMs) || timeoutMs < timeouts.min_ms || timeoutMs > timeouts.max_ms) throw new CliUsageError(`--timeout-ms takes a whole number between ${timeouts.min_ms} and ${timeouts.max_ms}`);
  const waitFor = flags['--wait-for'] ?? null;
  if (waitFor !== null && (waitFor.trim() === '' || waitFor.length > 200 || /[\r\n]/.test(waitFor))) throw new CliUsageError('--wait-for takes one line of text, at most 200 characters');
  let evidenceDirectory = null;
  if (flags['--evidence-dir'] !== undefined) {
    if (flags['--screenshot'] !== true) throw new CliUsageError('--evidence-dir is only used with --screenshot');
    evidenceDirectory = parseEvidenceDirectory(flags['--evidence-dir']);
  }
  const request = {
    url,
    collect: { text: selected.includes('text'), a11y: selected.includes('a11y'), console: selected.includes('console'), network: selected.includes('network'), screenshot: flags['--screenshot'] === true },
    viewport, waitFor, timeoutMs,
  };
  // the arguments that repeat this read (a retry offers them with a longer timeout)
  const args = [url, ...named.map((name) => `--${name}`), ...(request.collect.screenshot ? ['--screenshot'] : []), ...(viewport === null ? [] : ['--viewport', flags['--viewport']]),
    ...(waitFor === null ? [] : ['--wait-for', waitFor]), ...(evidenceDirectory === null ? [] : ['--evidence-dir', evidenceDirectory])];
  return { request, evidenceDirectory, args };
}

const stamp = (iso) => iso.replace(/[-:.]/g, '');

async function writeScreenshot({ roots, directory, now, url, bytes }) {
  const paths = await createPathService({ repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root });
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 8);
  for (let attempt = 1; attempt <= 9; attempt += 1) {
    const name = `page-${stamp(now)}-${hash}${attempt === 1 ? '' : `-${attempt}`}.png`;
    const target = await paths.resolveWorkflowPath(`${directory}/${name}`);
    if (target.exists) continue;
    await mkdir(dirname(target.filesystem_path), { recursive: true });
    try {
      await writeFile(target.filesystem_path, bytes, { flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    return target.relative_path;
  }
  throw new Error('page: could not find a free screenshot name');
}

const finding = (code, severity, message, detail) => ({ code, severity, message, file: null, line: null, detail });
const COLLECTORS = ['a11y', 'console', 'network', 'text'];

export async function createPagePacket(parameters) {
  const { input, manifest, providers, engine = collectPage } = parameters;
  const roots = resolveRoots(parameters);
  const { request, evidenceDirectory, args } = parseRequest(input);
  const rootArgs = rootArgsOf(input.flags);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  for (const name of INTERRUPTIONS) process.on(name, interrupt);
  let result;
  try {
    result = await engine(request, { env: process.env, platform: process.platform, signal: controller.signal });
  } finally {
    for (const name of INTERRUPTIONS) process.removeListener(name, interrupt);
  }
  const base = { command: 'page', root: roots.repository_root, snapshot: { before: EMPTY_SNAPSHOT, after: EMPTY_SNAPSHOT }, providers, knownCommands: knownCommandsOf(manifest) };
  const failed = (reason, message) => createPacket({
    ...base,
    status: 'error',
    data: { kind: 'page_failed', packet_version: PAGE_SCHEMA, url: request.url, reason, message },
    findings: [finding(PAGE_FINDING_CODES.failed, 'error', `The page could not be read (${reason}): ${message}`, { reason, url: request.url })],
    nextCommands: PAGE_NEXT_COMMAND_BUILDERS.page({ phase: reason === 'timeout' || reason === 'wait_for_timeout' ? 'timeout' : 'none', args, timeoutMs: request.timeoutMs, rootArgs }),
  });

  if (!result.ok && result.kind === 'blocked') {
    return createPacket({
      ...base,
      status: 'blocked',
      data: { kind: 'page_blocked', packet_version: PAGE_SCHEMA, url: request.url, reason: result.reason, searched: result.tried ?? [], remediation: result.remediation, message: result.message ?? null },
      findings: [finding(PAGE_FINDING_CODES.blocked, 'error', `No browser could be used (${result.reason}). ${result.remediation}`, { reason: result.reason, url: request.url })],
      nextCommands: PAGE_NEXT_COMMAND_BUILDERS.page({ phase: 'none' }),
    });
  }
  if (!result.ok) return failed(result.reason, result.message);
  if (request.collect.screenshot && (result.screenshot === null || result.screenshot === undefined || result.screenshot.length === 0)) return failed('screenshot_missing', 'the browser returned no screenshot');

  const changed = [];
  let screenshot = null;
  if (request.collect.screenshot) {
    const path = await writeScreenshot({ roots, directory: evidenceDirectory ?? BROWSER_POLICY.evidence.default_directory, now: providers.now(), url: request.url, bytes: result.screenshot });
    changed.push(path);
    screenshot = { path, bytes: result.screenshot.length };
  }
  const { page } = result;
  const cut = COLLECTORS.filter((name) => (name === 'network' ? page.network?.truncated : page[name]?.truncated) === true);
  return createPacket({
    ...base,
    status: cut.length === 0 ? 'ok' : 'warning',
    data: {
      kind: 'page', packet_version: PAGE_SCHEMA, url: request.url, final_url: page.final_url, title: page.title, untrusted: true, transport: result.transport, browser: page.browser,
      viewport: page.viewport, collected: COLLECTORS.filter((name) => request.collect[name]), duration_ms: result.duration_ms, text: page.text, a11y: page.a11y, console: page.console,
      network: page.network, timings: page.timings, wait_for: page.wait_for, screenshot,
    },
    findings: cut.length === 0 ? [] : [finding(PAGE_FINDING_CODES.truncated, 'warning', `Cut at the frozen cap: ${cut.join(', ')}. The packet keeps the first part and the true total.`, { what: cut, url: request.url })],
    changed,
    nextCommands: PAGE_NEXT_COMMAND_BUILDERS.page({ phase: 'none' }),
  });
}
