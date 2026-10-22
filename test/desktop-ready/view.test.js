// P2-W17: `view`, the static visual board. One self-contained HTML file, rendered from the graph packet alone, with the security rules of
// A1 section 8: textContent only, escaped </script> and U+2028, a CSP meta tag and zero network requests (checked in a real browser).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { collectPage } from '../../lib/browser/page.js';
import { discoverBrowser } from '../../lib/browser/discovery.js';
import { commandSnapshot } from '../../lib/store/snapshots/index.js';
import { validateViewData } from '../../lib/schemas/desktop.js';
import { buildGraphData } from '../../lib/store/navigation/graph.js';
import { readWorkflowModel } from '../../lib/store/navigation/model.js';
import { BOARD_SCRIPT, BOARD_STYLE, embedJson, renderBoardHtml } from '../../lib/view/html.js';
import { VIEW_DIRECTORY, VIEW_FILE, VIEW_POLICY, VIEW_SCHEMA, VIEW_SECTIONS } from '../../lib/view/policy.js';
import { auditPacket, auditWorld } from '../git-audit/support.js';
import { claimRoad, closableWorld, navWorld, query, runCommand } from '../navigation/support.js';
import { treeDigest } from './support.js';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const VIEW_PATH = `akrs/${VIEW_DIRECTORY}/${VIEW_FILE}`;
const graphOf = async (repo) => buildGraphData(await readWorkflowModel({ repositoryRoot: repo.root, workflowRoot: repo.path('akrs'), env: {}, rootArgs: [] }));
const runView = async (repo) => {
  const out = await runCommand(repo, ['view', '--json'], { providers: repo.providers });
  return { ...out, packet: JSON.parse(out.stdout === '' ? out.stderr : out.stdout) };
};
const inertJson = (html) => {
  const match = /<script type="application\/json" id="akrs-graph">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match !== null, 'the graph block is present');
  return match[1];
};
const sha = (text) => `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;

test('the view policy is written down: output, source, sections, security, offline, theme', () => {
  assert.equal(VIEW_SCHEMA, 'akrs.view/v1');
  assert.deepEqual([VIEW_DIRECTORY, VIEW_FILE], ['.cache/view', 'index.html']);
  assert.deepEqual([...VIEW_SECTIONS], ['board', 'executors', 'graph', 'leases', 'plans']);
  assert.equal(Object.isFrozen(VIEW_POLICY), true);
  for (const key of ['output', 'source', 'sections', 'security', 'offline', 'theme', 'package']) assert.ok(VIEW_POLICY[key].length > 40, key);
});

test('view writes exactly one file, akrs/.cache/view/index.html, and says so in the packet', async (t) => {
  const repo = await navWorld(t);
  const before = await treeDigest(repo, { exclude: ['akrs/.ops', '.git', 'akrs/.cache'] });
  const out = await runView(repo);
  assert.equal(out.exitCode, 0, out.stderr);
  const { packet } = out;
  assert.deepEqual([packet.command, packet.status, packet.data.kind, packet.data.outcome, packet.data.path], ['view', 'ok', 'view', 'written', VIEW_PATH]);
  assert.equal(validateViewData(packet.data).ok, true, JSON.stringify(validateViewData(packet.data).issues));
  assert.deepEqual(packet.changed, [VIEW_PATH]);
  const bytes = await readFile(repo.path(VIEW_PATH));
  assert.equal(packet.data.bytes, bytes.length);
  assert.equal(packet.data.sha256, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  assert.deepEqual(await readdir(repo.path('akrs/.cache/view')), ['index.html'], 'no temporary file is left');
  assert.deepEqual(await treeDigest(repo, { exclude: ['akrs/.ops', '.git', 'akrs/.cache'] }), before, 'nothing else changed');
  const graph = (await query(repo, ['graph'])).packet.data;
  assert.deepEqual([packet.data.nodes, packet.data.edges], [graph.nodes.length, graph.edges.length]);
});

test('the page is rendered from the graph packet alone: the embedded data is exactly `graph --json` data', async (t) => {
  const repo = await navWorld(t);
  await claimRoad(repo, 'R-P6-1', 'flash');
  await runView(repo);
  const html = await readFile(repo.path(VIEW_PATH), 'utf8');
  const graph = (await query(repo, ['graph'])).packet.data;
  assert.deepEqual(JSON.parse(inertJson(html)), graph);
});

test('running view again writes nothing: same bytes, outcome unchanged, status noop', async (t) => {
  const repo = await navWorld(t);
  await runView(repo);
  const first = await readFile(repo.path(VIEW_PATH));
  const { mtimeMs } = await stat(repo.path(VIEW_PATH));
  const again = await runView(repo);
  assert.deepEqual([again.packet.status, again.packet.data.outcome, again.packet.changed], ['noop', 'unchanged', []]);
  assert.deepEqual(await readFile(repo.path(VIEW_PATH)), first);
  assert.equal((await stat(repo.path(VIEW_PATH))).mtimeMs, mtimeMs);
});

test('a changed workflow gives a changed page; the page never contains a clock or a path of this machine', async (t) => {
  const repo = await navWorld(t);
  await runView(repo);
  const first = await readFile(repo.path(VIEW_PATH), 'utf8');
  await claimRoad(repo, 'R-P6-1', 'flash');
  const second = await runView(repo);
  assert.equal(second.packet.data.outcome, 'written');
  assert.notEqual(await readFile(repo.path(VIEW_PATH), 'utf8'), first);
  assert.equal(first.includes(repo.root), false);
  assert.equal(first.includes(repo.root.replaceAll('\\', '/')), false);
  assert.equal(/20\d\d-\d\d-\d\dT/.test(first), false, 'no timestamp');
});

test('the same graph renders to the same bytes, whatever the order it was built in', () => {
  const graph = { kind: 'graph', packet_version: 'akrs.graph/v1', touches: null, nodes: [], edges: [] };
  assert.equal(renderBoardHtml(graph), renderBoardHtml(structuredClone(graph)));
});

test('the cache file is outside every snapshot and is not an undeclared change for the audit', async (t) => {
  const repo = await navWorld(t);
  const before = await commandSnapshot('status', repo.options);
  await runView(repo);
  assert.equal((await commandSnapshot('status', repo.options)).snapshot, before.snapshot, 'view moves no snapshot');
  const audited = await auditWorld(t);
  const written = await runCommand(audited, ['view', '--json']);
  assert.equal(written.exitCode, 0, written.stderr);
  const packet = await auditPacket(audited);
  assert.deepEqual(packet.data.audit.categories.undeclared, []);
  assert.deepEqual(packet.data.audit.categories.workflow_cache.map(({ path }) => path), [VIEW_PATH]);
});

test('the page has no external reference and starts no request in its own code', async (t) => {
  const repo = await closableWorld(t);
  await runView(repo);
  const html = await readFile(repo.path(VIEW_PATH), 'utf8');
  const script = BOARD_SCRIPT;
  const withoutJson = html.replace(inertJson(html), '');
  for (const pattern of [/<link\b/i, /<img\b/i, /<iframe\b/i, /<form\b/i, /<base\b/i, /<object\b/i, /<embed\b/i, /<video\b/i, /<audio\b/i, /\bsrc\s*=/i, /\bhref\s*=/i, /@import/i, /\bon[a-z]+\s*=/i, /\bstyle\s*=/i]) {
    assert.equal(pattern.test(withoutJson), false, String(pattern));
  }
  assert.equal(/url\((?!#)/.test(BOARD_STYLE + script), false, 'no url() but a fragment reference');
  assert.deepEqual([...(BOARD_STYLE + script).matchAll(/https?:\/\/[^\s'")]+/g)].map(([found]) => found), ['http://www.w3.org/2000/svg'], 'the only URL-like string is the SVG namespace name');
  for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'Function(', 'fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'import(', 'importScripts', 'setAttribute(\'style\'', 'setAttribute("style"', 'localStorage', 'cookie', 'location.']) {
    assert.equal(script.includes(banned), false, banned);
  }
  assert.ok(script.includes('textContent'), 'text goes in through textContent');
});

test('a Content-Security-Policy meta tag forbids everything but this page\'s own inline script and style, by hash', async (t) => {
  const repo = await navWorld(t);
  await runView(repo);
  const html = await readFile(repo.path(VIEW_PATH), 'utf8');
  const [, policy] = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  const directives = Object.fromEntries(policy.split('; ').map((entry) => [entry.split(' ')[0], entry.split(' ').slice(1)]));
  assert.deepEqual(directives['default-src'], ["'none'"]);
  assert.deepEqual(directives['script-src'], [`'${sha(BOARD_SCRIPT)}'`]);
  assert.deepEqual(directives['style-src'], [`'${sha(BOARD_STYLE)}'`]);
  assert.deepEqual([directives['base-uri'], directives['form-action']], [["'none'"], ["'none'"]]);
  assert.equal(policy.includes('unsafe-inline'), false);
  assert.equal(policy.includes('unsafe-eval'), false);
  assert.ok(html.includes(`<script>${BOARD_SCRIPT}</script>`), 'the hashed script is the executed script');
  assert.ok(html.includes(`<style>${BOARD_STYLE}</style>`), 'the hashed style is the applied style');
  assert.equal([...html.matchAll(/<script\b/g)].length, 2, 'one inert data block and one script');
});

test('hostile text cannot close the script block or break out of it', () => {
  const hostile = `</script><script>window.pwned=1</script><img src=x onerror=alert(1)>${LS}${PS}&amp;`;
  const graph = {
    kind: 'graph',
    packet_version: 'akrs.graph/v1',
    touches: null,
    nodes: [
      {
        id: `R-${hostile.replaceAll(LS, ' ').replaceAll(PS, ' ')}`, type: 'road', status: 'QUEUED', class: '<b>weak</b>', lease: null, needs_split: false, plan: null, tester: null,
      },
    ],
    edges: [],
  };
  const html = renderBoardHtml(graph);
  assert.equal([...html.matchAll(/<\/script>/g)].length, 2, 'only the two real closing tags');
  assert.equal([...html.matchAll(/<script\b/g)].length, 2);
  assert.equal(html.includes('window.pwned=1</script>'), false);
  assert.equal(html.includes(LS) || html.includes(PS), false, 'no raw line or paragraph separator');
  assert.deepEqual(JSON.parse(inertJson(html)), graph, 'the data round-trips exactly');
  const encoded = embedJson({ text: `a${LS}b${PS}c</script><!--&` });
  for (const raw of [LS, PS, '<', '>', '&']) assert.equal(encoded.includes(raw), false, JSON.stringify(raw));
  assert.deepEqual(JSON.parse(encoded), { text: `a${LS}b${PS}c</script><!--&` });
});

test('a graph that does not verify is refused, not rendered', () => {
  assert.throws(() => renderBoardHtml({ kind: 'graph' }), /graph/);
  assert.throws(() => renderBoardHtml(null));
});

// ---- a real browser, offline ---------------------------------------------------------------------------------------------
const found = discoverBrowser({ platform: process.platform, env: process.env });

async function loadOffline(file) {
  return collectPage({
    url: pathToFileURL(file).href,
    collect: { text: true, a11y: false, console: true, network: true, screenshot: false },
    viewport: { width: 1000, height: 800 },
    waitFor: 'AKRS board',
    timeoutMs: 30000,
  }, { env: process.env, platform: process.platform });
}

test('loaded in a real browser the board draws every section, requests nothing and raises no error', { skip: found.ok ? false : `no browser found (${found.reason})` }, async (t) => {
  const repo = await navWorld(t);
  await claimRoad(repo, 'R-P6-1', 'flash');
  await runView(repo);
  const result = await loadOffline(repo.path(VIEW_PATH));
  assert.equal(result.ok, true, JSON.stringify(result));
  const { text } = result.page.text;
  for (const expected of ['AKRS board', 'Plans', 'Roads by status', 'Dependency graph', 'Executor classes', 'Leases', 'R-P6-1', 'R-P6-2', 'R-P6-3', 'R-P5-6', 'QUEUED', 'ACTIVE', 'DONE', 'weak', 'medium', 'flash', 'fresh', 'P6', 'unverified']) {
    assert.ok(text.includes(expected), `the page shows ${expected}`);
  }
  assert.equal(result.page.console.errors, 0, JSON.stringify(result.page.console.entries));
  assert.equal(result.page.network.failed_total, 0, JSON.stringify(result.page.network.failed));
  assert.ok(result.page.network.total_requests <= 1, `only the document itself was requested (saw ${result.page.network.total_requests})`);
  assert.equal(result.teardown.profile_removed, true);
});

test('hostile text in the data is shown as text in a real browser: no script runs, no CSP error', { skip: found.ok ? false : `no browser found (${found.reason})` }, async (t) => {
  const repo = await navWorld(t);
  const hostile = "R-<img src=x onerror=console.error('PWNED')></script><script>console.error('PWNED2')</script>";
  const graph = {
    kind: 'graph',
    packet_version: 'akrs.graph/v1',
    touches: null,
    nodes: [{
      id: hostile, type: 'road', status: 'QUEUED', class: '<b>weak</b>', lease: null, needs_split: false, plan: null, tester: null,
    }],
    edges: [],
  };
  const file = await repo.write('hostile-board.html', renderBoardHtml(graph));
  const result = await loadOffline(file);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.page.text.text.includes(hostile), 'the hostile id is visible as plain text');
  assert.ok(result.page.text.text.includes('<b>weak</b>'));
  assert.equal(result.page.console.errors, 0, JSON.stringify(result.page.console.entries));
  assert.ok(result.page.network.total_requests <= 1);
});

test('the board follows the graph of a larger workflow: every Road and Plan is in the page text', { skip: found.ok ? false : `no browser found (${found.reason})` }, async (t) => {
  const repo = await closableWorld(t);
  await runView(repo);
  const graph = await graphOf(repo);
  const result = await loadOffline(repo.path(VIEW_PATH));
  assert.equal(result.ok, true, JSON.stringify(result));
  for (const node of graph.nodes.filter(({ type }) => type === 'road' || type === 'plan')) assert.ok(result.page.text.text.includes(node.id), node.id);
  assert.ok(result.page.text.text.includes('passed'), 'the Tester state of the closable Plan');
  assert.equal(result.page.console.errors, 0);
});
