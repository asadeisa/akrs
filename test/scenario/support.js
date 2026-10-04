// Shared helpers of the P2-W14 scenario tests: the fixture app, free ports, a Tester world with a live contract that
// launches the app, and in-process CLI runs with an injectable engine.
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { runCliAdapter } from '../../bin/cli-adapter.js';
import { commandManifest } from '../../lib/commands/manifest.js';
import { commandHandlers } from '../../lib/commands/meta.js';
import { createTestRunPacket } from '../../lib/commands/test-run.js';
import { fakeProviders } from '../idempotency/support.js';
import { seedRoad } from '../road/support.js';
import { setExec } from '../road-details/support.js';
import { contractInput, define, handoff, planWorld } from '../tester/support.js';

export const APP = fileURLToPath(new URL('../fixtures/tester-scenario/app.js', import.meta.url));
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export const HTTP_SCENARIO = (port) => [
  { step: 'http', method: 'GET', url: `http://127.0.0.1:${port}/api/reservations`, headers: [], body: null, expect_status: 200, expect_json: { pointer: '/total', equals: 1 }, soft: false },
  { step: 'http', method: 'GET', url: '/health', headers: [], body: null, expect_status: 200, expect_json: null, soft: false },
];

// A contract input with a live policy that launches the fixture app on `port`.
export async function liveContract(port, overrides = {}) {
  const base = await contractInput('valid/full', { plan: 'P6', roads: ['R-P6-1', 'R-P6-2'] });
  return {
    ...base,
    policy: 'live',
    measurements: [],
    launch: { argv: [process.execPath, APP, String(port)], url: `http://127.0.0.1:${port}`, ready: { url: `http://127.0.0.1:${port}/health`, status: 200, timeout_ms: 15000 } },
    setup: [],
    teardown: [],
    evidence_types: ['log', 'screenshot', 'console', 'network', 'a11y', 'timing'],
    timeout_ms: 20000,
    allowed_hosts: [],
    scenario: HTTP_SCENARIO(port),
    ...overrides,
  };
}

// Plan P6 with both Roads DONE, a handoff for each, one Tester executor and a stored live contract.
export async function runWorld(t, { port, contract = {}, executor = true } = {}) {
  const repo = await planWorld(t);
  repo.providers = fakeProviders({ firstId: 9000 });
  await repo.write('SOT/10-budgets.md', 'frame budget 16ms\n');
  await seedRoad(repo, { id: 'R-P6-1', plan: 'P6' }, { folder: 'roads/P6', status: 'DONE' });
  const assigned = port ?? await freePort();
  repo.port = assigned;
  const stored = await define(repo, 'P6', await liveContract(assigned, contract));
  if (stored.outcome !== 'committed') throw new Error(`contract not stored: ${JSON.stringify(stored.packet.findings)}`);
  for (const road of ['R-P6-1', 'R-P6-2']) {
    const result = await handoff(repo, 'P6', { road, result: `${road} is reachable.`, reach: [`Open /${road}`], expect: `${road} lists reservations.` });
    if (result.outcome !== 'committed') throw new Error(`handoff not stored: ${JSON.stringify(result.packet.findings)}`);
  }
  if (executor) await setExec(repo, { id: 'qa', role: 'tester', class: 'medium', label: 'QA', user_answer: 'medium' });
  return repo;
}

// One in-process `test run`; `engine` replaces the scenario engine (a test fake), `deps` the real engine's seams.
export async function testRun(repo, args = ['P6'], { engine, deps, format = '--json', providers = repo.providers, write = null, env } = {}) {
  const handlers = { ...commandHandlers, 'test-run': (parameters) => createTestRunPacket({ ...parameters, ...(engine === undefined ? {} : { engine }), ...(deps === undefined ? {} : { deps }), ...(env === undefined ? {} : { env }) }) };
  const result = await runCliAdapter({
    argv: ['test', 'run', ...args, ...(format === '' ? [] : [format]), '--root', repo.root], cwd: repo.root, manifest: commandManifest, handlers, providers,
    readStdin: async () => Buffer.alloc(0), write,
  });
  const text = result.stdout === '' ? result.stderr : result.stdout;
  return { ...result, text, packet: format === '--json' ? JSON.parse(text) : result.packet };
}

export const evidenceDir = (runId) => `akrs/verifications/P6/evidence/${runId}`;
