// Shared helpers for the P1-W04 journal and lease tests: a realistic workflow (the P1-W02 fixture), a fake
// provider pair, a command stand-in that really changes the workflow, and a child-process worker harness.
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPacket } from '../../lib/core/packet.js';
import { normalizeAbsolutePath } from '../../lib/core/roots.js';
import { runJournaledMutation } from '../../lib/store/journal/index.js';
import {
  LEASE_CONTRACT_PROJECTION,
  WORKFLOW_PROJECTION,
  computeSnapshot,
} from '../../lib/store/snapshots/index.js';
import { createWorkflow } from '../snapshots/support.js';

export const WORKER = fileURLToPath(new URL('./fixtures/worker.js', import.meta.url));

// 26-character Crockford ULID with a numeric tail, so every n gives a distinct valid ID.
export const ulid = (n) => `01ARZ3NDEKTSV4RRFFQ6${String(n).padStart(6, '0')}`;
export const SENTINEL = 'IDEMPOTENCY-BODY-SENTINEL-4c91';
export const NO_TARGET = { road: null, plan: null };

// The snapshot fixture pre-creates a fake lock file and a fake journal file under .ops; the real ones need the
// directories, so those two entries are omitted.
export async function createIdempotencyWorkflow(testContext, extra = {}) {
  return createWorkflow(testContext, { omit: ['akrs/.ops/lock', 'akrs/.ops/journal/0001.jsonl'], extra });
}

// Deterministic providers: the clock advances one second per call, run IDs are a counter.
export function fakeProviders({ start = Date.parse('2026-10-03T10:00:00.000Z'), firstId = 1000 } = {}) {
  let tick = 0;
  let counter = firstId;
  const providers = {
    calls: { now: 0, runId: 0 },
    now() {
      providers.calls.now += 1;
      const value = new Date(start + tick * 1000).toISOString();
      tick += 1;
      return value;
    },
    runId() {
      providers.calls.runId += 1;
      counter += 1;
      return ulid(counter);
    },
    advance(seconds) { tick += seconds; },
  };
  return providers;
}

export const workflowSnapshot = async (workflow) => (await computeSnapshot({
  ...workflow.options, projections: WORKFLOW_PROJECTION,
})).snapshot;

export const leaseSnapshotResult = (workflow, road = 'R1') => computeSnapshot({
  ...workflow.options, projections: LEASE_CONTRACT_PROJECTION, target: { road },
});

// A stand-in for a mutating command: it writes akrs/memory/<name>.md and reports it truthfully.
export function createHarness(workflow, { providers = fakeProviders(), command = 'memory-add' } = {}) {
  const applied = [];
  const events = [];
  const root = normalizeAbsolutePath(workflow.root);
  const currentSnapshot = () => workflowSnapshot(workflow);

  async function apply(context) {
    events.push('apply');
    applied.push(context.request_id);
    const file = `memory/${context.input.name}.md`;
    await workflow.write(`akrs/${file}`, context.input.body);
    return createPacket({
      command: context.command,
      requestId: context.request_id,
      status: 'ok',
      root,
      snapshot: { before: context.current_snapshot, after: await currentSnapshot() },
      data: { kind: 'memory', name: context.input.name },
      findings: [{
        code: 'AKRS-C005', severity: 'warning', message: 'recorded warning', file: null, line: null,
        detail: { check: 'sample', error: 'kept in the replay' },
      }],
      changed: [file],
      nextCommands: [{ command: 'memory-add', args: ['--list'] }],
      providers,
    });
  }

  // A mutation that changes nothing, for snapshot-invariance checks.
  async function applyNothing(context) {
    events.push('apply');
    applied.push(context.request_id);
    return createPacket({
      command: context.command,
      requestId: context.request_id,
      status: 'ok',
      root,
      snapshot: { before: context.current_snapshot, after: context.current_snapshot },
      data: { kind: 'memory' },
      providers,
    });
  }

  const rejection = (context, status, code) => createPacket({
    command: context.command,
    requestId: context.request_id,
    status,
    root,
    snapshot: { before: context.current_snapshot ?? null, after: context.current_snapshot ?? null },
    data: { kind: 'rejected' },
    findings: [{ code, severity: 'error', message: `rejected by ${code}`, file: null, line: null, detail: {} }],
    providers,
  });

  const options = (overrides = {}) => ({
    ...workflow.options,
    root,
    providers,
    command,
    target: NO_TARGET,
    input: { name: 'note', body: 'hello' },
    currentSnapshot,
    apply,
    ...overrides,
  });

  return {
    providers,
    root,
    applied,
    events,
    apply,
    applyNothing,
    rejection,
    currentSnapshot,
    options,
    run: (overrides) => runJournaledMutation(options(overrides)),
  };
}

export const journalDirectory = (workflow) => workflow.path('akrs', '.ops', 'journal');
export const opFile = (workflow, requestId) => join(journalDirectory(workflow), 'ops', `${requestId}.jsonl`);
export const indexFile = (workflow, replayKey) => join(journalDirectory(workflow), 'by-key', `${replayKey.slice('sha256:'.length)}.json`);

export async function readRecords(workflow, requestId) {
  const text = await readFile(opFile(workflow, requestId), 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export async function listNames(path) {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

// Every file under a directory, as repository-relative strings.
export async function walk(root, relative = '') {
  const out = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await walk(root, child));
    else out.push(child);
  }
  return out.sort();
}

export function startWorker(config) {
  const child = spawn(process.execPath, [WORKER, JSON.stringify(config)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolveClosed, rejectClosed) => {
    child.on('error', rejectClosed);
    child.on('close', (exitCode, signal) => {
      const last = stdout.trim().split('\n').filter(Boolean).at(-1);
      resolveClosed({ exitCode, signal, stdout, stderr, result: last === undefined ? null : JSON.parse(last) });
    });
  });
}
