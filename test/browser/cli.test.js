// P2-W13: the `page` command: manifest class, usage errors, blocked/failed/ok packets and where evidence goes.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runCliAdapter } from '../../bin/cli-adapter.js';
import { commandHandlers } from '../../lib/commands/meta.js';
import { commandManifest } from '../../lib/commands/manifest.js';
import { createPagePacket } from '../../lib/commands/page.js';
import { validatePage } from '../../lib/schemas/page.js';
import { validateReadOnlyPacket } from '../../lib/schemas/packet.js';
import { COMMAND_SNAPSHOT_TABLE } from '../../lib/store/snapshots/projections.js';
import { fakeProviders } from '../idempotency/support.js';
import { planWorld } from '../tester/support.js';

const PNG = Buffer.from('PNG-BYTES');
const goodPage = (extra = {}) => ({
  title: 'Demo', final_url: 'http://localhost:3000/', viewport: null, browser: 'Chrome/154.0',
  text: { text: 'Hello', chars: 5, truncated: false },
  a11y: null,
  console: { entries: [], errors: 0, total: 0, truncated: false },
  network: { failed: [], failed_total: 0, total_requests: 3, truncated: false },
  timings: { ttfb_ms: 12, dom_content_loaded_ms: 80, load_ms: 121 },
  wait_for: null,
  ...extra,
});
const engineOk = (extra = {}, screenshot = null) => async (request) => ({ ok: true, page: goodPage(extra), screenshot, duration_ms: 400, transport: 'pipe', request });

async function page(repo, args, engine = engineOk(), format = '--json') {
  const calls = [];
  const handlers = { ...commandHandlers, page: (parameters) => createPagePacket({ ...parameters, engine: async (request) => { calls.push(request); return engine(request); } }) };
  const result = await runCliAdapter({
    argv: ['page', ...args, format, '--root', repo.root], cwd: repo.root, manifest: commandManifest, handlers, providers: fakeProviders({ firstId: 9500 }),
    readStdin: async () => Buffer.alloc(0),
  });
  const text = result.stdout === '' ? result.stderr : result.stdout;
  return { ...result, calls, packet: format === '--json' ? JSON.parse(text) : null, text };
}

test('page is a derived_write, any-role command with an MCP read action and no snapshot input', () => {
  const entry = commandManifest.commands.find(({ id }) => id === 'page');
  assert.deepEqual([entry.tokens, entry.mutability, entry.idempotency, entry.expected_snapshot, entry.dry_run, entry.required_role], [['page'], 'derived_write', 'none', 'not_applicable', false, 'any']);
  assert.deepEqual([entry.mcp_tool, entry.mcp_action], ['akrs_page', 'read']);
  assert.deepEqual(entry.snapshot_inputs, COMMAND_SNAPSHOT_TABLE.page.inputs);
  assert.deepEqual(entry.positionals, [{ name: 'url', required: true, variadic: false }]);
  for (const flag of ['--text', '--a11y', '--console', '--network', '--screenshot', '--viewport', '--wait-for', '--timeout-ms', '--evidence-dir']) assert.ok(entry.flags.some(({ name }) => name === flag), flag);
});

test('a missing or unusable URL, flag value or evidence directory is a usage error and the browser is never started', async (t) => {
  const repo = await planWorld(t);
  const bad = [
    [], ['file:///etc/passwd'], ['ftp://x/'], ['not a url'], ['http://user:pw@localhost/'], ['javascript:alert(1)'], [`http://localhost/${'a'.repeat(2100)}`],
    ['http://localhost/', '--viewport', '10x10'], ['http://localhost/', '--viewport', 'wide'], ['http://localhost/', '--timeout-ms', '10'], ['http://localhost/', '--timeout-ms', '999999'],
    ['http://localhost/', '--wait-for', ''], ['http://localhost/', '--screenshot', '--evidence-dir', '../outside'], ['http://localhost/', '--screenshot', '--evidence-dir', 'roads'],
    ['http://localhost/', '--evidence-dir', 'verifications/P6/evidence'],
  ];
  for (const args of bad) {
    const run = await page(repo, args);
    assert.equal(run.exitCode, 2, args.join(' '));
    assert.equal(run.calls.length, 0, args.join(' '));
  }
});

test('without collector flags the page is read as text, console and network; the engine gets one normalised request', async (t) => {
  const repo = await planWorld(t);
  const run = await page(repo, ['http://localhost:3000/']);
  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.calls[0], {
    url: 'http://localhost:3000/', collect: { text: true, a11y: false, console: true, network: true, screenshot: false }, viewport: null, waitFor: null, timeoutMs: 30000,
  });
  assert.deepEqual(run.packet.data.collected, ['console', 'network', 'text']);
});

test('named collectors are the only ones asked for; viewport, wait-for and timeout are passed through', async (t) => {
  const repo = await planWorld(t);
  const run = await page(repo, ['http://localhost:3000/', '--a11y', '--viewport', '390x844', '--wait-for', 'Saved', '--timeout-ms', '9000']);
  assert.deepEqual(run.calls[0], {
    url: 'http://localhost:3000/', collect: { text: false, a11y: true, console: false, network: false, screenshot: false }, viewport: { width: 390, height: 844 }, waitFor: 'Saved', timeoutMs: 9000,
  });
});

test('an ok packet validates against the closed page schema, is read-only without a screenshot and never says verified', async (t) => {
  const repo = await planWorld(t);
  const run = await page(repo, ['http://localhost:3000/']);
  assert.equal(run.packet.status, 'ok');
  assert.equal(validatePage(run.packet.data).ok, true, JSON.stringify(validatePage(run.packet.data).issues));
  assert.equal(validateReadOnlyPacket(run.packet).ok, true);
  assert.equal(run.packet.data.untrusted, true);
  assert.equal(existsSync(repo.path('akrs/.cache/page')), false);
});

test('observed page problems are data, not findings: a console error and a 404 do not change the exit code', async (t) => {
  const repo = await planWorld(t);
  const run = await page(repo, ['http://localhost:3000/'], engineOk({
    console: { entries: [{ kind: 'console', text: 'boom', url: 'http://x/app.js', line: 7 }], errors: 1, total: 1, truncated: false },
    network: { failed: [{ method: 'GET', url: 'http://x/m.png', status: 404, error: null, type: 'Image' }], failed_total: 1, total_requests: 3, truncated: false },
  }));
  assert.deepEqual([run.exitCode, run.packet.status, run.packet.findings.length], [0, 'ok', 0]);
  assert.equal(run.packet.data.console.errors, 1);
});

test('a cut collector is a warning finding AKRS-C019 naming what was cut', async (t) => {
  const repo = await planWorld(t);
  const run = await page(repo, ['http://localhost:3000/'], engineOk({ text: { text: 'abc', chars: 99999, truncated: true } }));
  assert.deepEqual([run.packet.status, run.exitCode], ['warning', 1]);
  assert.deepEqual(run.packet.findings.map(({ code, detail }) => [code, detail.what]), [['AKRS-C019', ['text']]]);
});

test('no browser is blocked with AKRS-C018, the places searched and a remediation, never ok', async (t) => {
  const repo = await planWorld(t);
  const run = await page(repo, ['http://localhost:3000/'], async () => ({
    ok: false, kind: 'blocked', reason: 'browser_not_found', tried: [{ source: 'path_lookup', path: '/usr/bin/chromium' }], remediation: 'Install Chrome, Edge or Chromium, or set AKRS_BROWSER_PATH to its executable.',
  }));
  assert.deepEqual([run.packet.status, run.exitCode, run.packet.data.kind, run.packet.data.reason], ['blocked', 1, 'page_blocked', 'browser_not_found']);
  assert.equal(run.packet.findings[0].code, 'AKRS-C018');
  assert.match(run.packet.data.remediation, /AKRS_BROWSER_PATH/);
  assert.equal(validatePage(run.packet.data).ok, true);
});

test('a page that cannot be read is error AKRS-C020 with its reason; a timeout offers a longer retry', async (t) => {
  const repo = await planWorld(t);
  const run = await page(repo, ['http://localhost:3000/', '--timeout-ms', '5000'], async () => ({ ok: false, kind: 'failed', reason: 'timeout', message: 'the page was not idle within 5000 ms' }));
  assert.deepEqual([run.packet.status, run.packet.data.kind, run.packet.data.reason, run.packet.findings[0].code], ['error', 'page_failed', 'timeout', 'AKRS-C020']);
  assert.deepEqual(run.packet.next_commands[0].args.slice(0, 1), ['http://localhost:3000/']);
  assert.ok(run.packet.next_commands[0].args.includes('10000'));
  assert.equal(validatePage(run.packet.data).ok, true);
});

test('a screenshot goes to the snapshot-excluded cache, is listed in changed and the snapshots stay equal', async (t) => {
  const repo = await planWorld(t);
  const run = await page(repo, ['http://localhost:3000/', '--screenshot'], engineOk({}, PNG));
  assert.equal(run.exitCode, 0);
  const [path] = run.packet.changed;
  assert.match(path, /^akrs\/\.cache\/page\/page-[0-9]{8}T[0-9]{9}Z-[0-9a-f]{8}\.png$/);
  assert.deepEqual(await readFile(repo.path(path)), PNG);
  assert.equal(run.packet.data.screenshot.path, path);
  assert.equal(run.packet.data.screenshot.bytes, PNG.length);
  assert.equal(run.packet.snapshot.before, run.packet.snapshot.after);
});

test('an evidence slot receives the screenshot instead of the cache', async (t) => {
  const repo = await planWorld(t);
  const run = await page(repo, ['http://localhost:3000/', '--screenshot', '--evidence-dir', 'verifications/P6/evidence/screenshots'], engineOk({}, PNG));
  assert.match(run.packet.changed[0], /^akrs\/verifications\/P6\/evidence\/screenshots\/page-/);
  assert.equal(existsSync(repo.path(run.packet.changed[0])), true);
  assert.equal(existsSync(repo.path('akrs/.cache/page')), false);
});

test('--screenshot with an engine that returned no image is a failed page, not a silent omission', async (t) => {
  const repo = await planWorld(t);
  const run = await page(repo, ['http://localhost:3000/', '--screenshot'], engineOk({}, null));
  assert.equal(run.packet.data.kind, 'page_failed');
  assert.equal(run.packet.data.reason, 'screenshot_missing');
});
