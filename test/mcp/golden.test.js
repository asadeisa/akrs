// P2-W15 golden transcripts, one per era: every request and the exact response on a fixed world with fixed providers, byte-compared to
// committed JSON (the tools/list response pins the F19 projection). The machine-dependent root is a placeholder. Regenerate with
// AKRS_REGENERATE_MCP_GOLDEN=1 only after reviewing why the protocol surface changed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fakeProviders } from '../idempotency/support.js';
import { createRepo } from '../road/support.js';
import { MODERN, inProcess, modernMeta } from './support.js';

const ROOT = /(?:[A-Za-z]:)?[\\/][^"\s`]*akrs-road-[A-Za-z0-9_-]+/g;
const normalize = (_key, value) => (typeof value === 'string' ? value.replace(ROOT, '<root>') : value);

async function transcript(t, steps) {
  const repo = await createRepo(t);
  const client = inProcess({ root: repo.root, providers: fakeProviders({ firstId: 7000 }) });
  const exchanges = [];
  for (const [index, step] of steps.entries()) {
    const message = { jsonrpc: '2.0', ...(step.notify ? {} : { id: index + 1 }), method: step.method, ...(step.params === undefined ? {} : { params: step.params }) };
    const before = client.sent.length;
    await client.raw(JSON.stringify(message));
    exchanges.push({ request: message, responses: client.sent.slice(before) });
  }
  return JSON.parse(JSON.stringify(exchanges, normalize));
}

async function compare(name, actual) {
  const golden = new URL(`./golden/${name}.json`, import.meta.url);
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env.AKRS_REGENERATE_MCP_GOLDEN === '1') await writeFile(golden, text);
  assert.equal(text, await readFile(golden, 'utf8'), `${name} transcript changed`);
}

const call = (name, args, extra = {}) => ({ method: 'tools/call', params: { name, arguments: args, ...extra } });

test('golden: the legacy era transcript (initialize -> tools/list -> tools/call results and errors)', async (t) => {
  await compare('legacy', await transcript(t, [
    { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'golden', version: '1' } } },
    { method: 'notifications/initialized', notify: true },
    { method: 'ping' },
    { method: 'tools/list' },
    call('akrs_status', { action: 'explain', id: 'AKRS-C001' }),
    call('akrs_status', { action: 'status' }),
    call('akrs_road', { action: 'details', id: 'R-NONE' }),
    call('akrs_work', { action: 'done' }),
    call('akrs_nope', {}),
    { method: 'resources/list' },
  ]));
});

test('golden: the modern era transcript (server/discover, stateless calls, -32022)', async (t) => {
  await compare('modern', await transcript(t, [
    { method: 'server/discover', params: { _meta: modernMeta() } },
    { method: 'tools/list', params: { _meta: modernMeta() } },
    call('akrs_status', { action: 'explain', id: 'AKRS-C001' }, { _meta: modernMeta() }),
    call('akrs_road', { action: 'template', kind: 'scope' }, { _meta: modernMeta() }),
    { method: 'tools/list', params: { _meta: modernMeta('2025-06-18') } },
    { method: 'tools/list' },
    { method: 'ping', params: { _meta: modernMeta(MODERN) } },
  ]));
});
