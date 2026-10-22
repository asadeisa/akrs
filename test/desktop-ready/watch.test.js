// P2-W17: `watch --jsonl [--since <op>]`. The engine is driven by the operation journal plus workflow file changes, debounced, resumable
// from an op ID, deaf to drafts and cache noise, and it terminates cleanly. Timers, the file watcher and the abort signal are injected, so no
// test waits on wall-clock time to decide a result and none can hang: every run is bounded by --max-events, a duration or an abort.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CliUsageError } from '../../lib/core/errors.js';
import { createEventStream } from '../../lib/core/event-stream.js';
import { commandHandlers, commandManifest } from '../../lib/core/index.js';
import { validateWatchData, validateWatchEventData } from '../../lib/schemas/desktop.js';
import { changedPaths, isNoise, runWatch } from '../../lib/watch/engine.js';
import { WATCH_DEFAULTS, WATCH_ENDINGS, WATCH_EVENT_KINDS, WATCH_LIMITS, WATCH_NOISE_PREFIXES, WATCH_POLICY, WATCH_SCHEMA } from '../../lib/watch/policy.js';
import { navWorld, runCommand } from '../navigation/support.js';
import { fakeProviders } from './support.js';

const CLI = fileURLToPath(new URL('../../bin/akrs.js', import.meta.url));

// ---- injected time and file events ---------------------------------------------------------------------------------------
function manualTimers() {
  let current = 0;
  let next = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = next++;
      pending.set(id, { at: current + ms, fn });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    now: () => current,
    pending: () => pending.size,
    // runs every timer that falls due, in time order
    advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (due === undefined) break;
        pending.delete(due[0]);
        current = Math.max(current, due[1].at);
        due[1].fn();
      }
      current = target;
    },
  };
}

function fakeWatcher() {
  const state = { handler: null, closed: 0, path: null };
  return {
    state,
    factory(path, onEvent) {
      state.handler = onEvent;
      state.path = path;
      return { close() { state.closed += 1; } };
    },
    fire(name) { state.handler(name); },
  };
}

// scan counter: wait until the engine has finished its n-th scan
function scanClock() {
  const waiters = [];
  const clock = { scans: 0 };
  clock.onScan = ({ scans }) => {
    clock.scans = scans;
    for (const waiter of waiters.filter((entry) => entry.at <= scans)) waiter.resolve();
  };
  clock.until = (count) => (clock.scans >= count ? Promise.resolve() : new Promise((resolve) => { waiters.push({ at: count, resolve }); }));
  return clock;
}

function collector() {
  const events = [];
  const waiters = [];
  const collected = {
    events,
    emit(type, data) {
      const event = { type, data };
      assert.equal(validateWatchEventData(event).ok, true, JSON.stringify([type, data, validateWatchEventData(event).issues]));
      events.push(event);
      for (const waiter of waiters.filter((entry) => entry.count <= events.length)) waiter.resolve();
    },
    until: (count) => (events.length >= count ? Promise.resolve() : new Promise((resolve) => { waiters.push({ count, resolve }); })),
    kinds: () => events.map(({ data }) => data.kind),
  };
  return collected;
}

const opIds = [];
// every test operation is committed after the fixture's own (a clock that starts later), so committed order is creation order
async function commit(repo, id) {
  repo.watchClock ??= fakeProviders({ start: Date.parse('2026-12-01T00:00:00.000Z'), firstId: 7100 });
  const out = await runCommand(repo, ['executor', 'set', id, '--role', 'worker', '--class', 'weak', '--label', `Worker ${id}`, '--answer', 'weak', '--json'], { providers: repo.watchClock });
  assert.equal(out.exitCode, 0, out.stdout + out.stderr);
  const { request_id: requestId } = JSON.parse(out.stdout);
  opIds.push(requestId);
  return requestId;
}

async function engineWorld(t, options = {}) {
  const repo = await navWorld(t);
  const timers = manualTimers();
  const watcher = fakeWatcher();
  const clock = scanClock();
  const events = collector();
  const controller = new AbortController();
  const run = (extra = {}) => runWatch({
    repositoryRoot: repo.root,
    workflowRoot: repo.path('akrs'),
    debounceMs: 100,
    pollMs: 1_000_000,
    signal: controller.signal,
    emit: events.emit,
    deps: { timers, watchFactory: watcher.factory, onScan: clock.onScan },
    ...options,
    ...extra,
  });
  return { repo, timers, watcher, clock, events, controller, run };
}

// ---- frozen decisions ----------------------------------------------------------------------------------------------------
test('the watch policy is frozen: events, order, debounce, noise, resume, ending', () => {
  assert.equal(WATCH_SCHEMA, 'akrs.watch/v1');
  assert.deepEqual({ ...WATCH_EVENT_KINDS }, { started: 'watch_started', op: 'watch_op', change: 'watch_change' });
  assert.deepEqual([...WATCH_ENDINGS], ['duration', 'max_events', 'signal']);
  assert.deepEqual({ ...WATCH_DEFAULTS }, { debounce_ms: 150, poll_ms: 1000 });
  assert.deepEqual([...WATCH_NOISE_PREFIXES], ['.cache/', 'drafts/']);
  assert.deepEqual(Object.keys(WATCH_LIMITS), ['debounce_ms', 'poll_ms', 'max_events', 'duration_ms']);
  assert.equal(Object.isFrozen(WATCH_POLICY), true);
  for (const key of ['source', 'events', 'order', 'debounce', 'noise', 'resume', 'baseline', 'ending', 'query']) assert.ok(WATCH_POLICY[key].length > 40, key);
  assert.match(WATCH_POLICY.source, /operation journal/);
});

test('noise: drafts, the cache, evidence and CLI scratch other than the journal never wake the engine', () => {
  for (const noise of ['drafts/a.json', 'drafts', '.cache/view/index.html', '.cache', '.ops/lock/owner.json', '.ops/leases/R1.json', '.ops/tx/abc/manifest.json', '.ops/journal/pending/x.json', '.ops/journal/by-key/k.json',
    'verifications/P6/evidence/run1/shot.png', 'drafts\\win.json', '.\\.cache\\x']) assert.equal(isNoise(noise), true, noise);
  for (const real of ['roads/P6/R1.json', 'plans/P6.json', 'tasks/T1.md', 'state.json', 'verifications/P6/contract.json', '.ops/journal/ops/01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl', 'executors.json', '', 'drafts-notes.md']) {
    assert.equal(isNoise(real), false, real);
  }
});

test('changedPaths names every path that appeared, changed or disappeared, sorted by code point', () => {
  const entry = (key, value, projection = 'roads') => ({ projection, key, kind: 'file', value });
  const before = [entry('akrs/roads/b.json', 'h1'), entry('akrs/roads/a.json', 'h1'), entry('akrs/roads/gone.json', 'h1')];
  const after = [entry('akrs/roads/a.json', 'h2'), entry('akrs/roads/b.json', 'h1'), entry('akrs/roads/new.json', 'h1')];
  assert.deepEqual(changedPaths(before, after), ['akrs/roads/a.json', 'akrs/roads/gone.json', 'akrs/roads/new.json']);
  assert.deepEqual(changedPaths(after, after), []);
});

// ---- the engine, with injected time --------------------------------------------------------------------------------------
test('the stream opens with started: the baseline snapshot, the resume cursor and the settings; no backlog without --since', async (t) => {
  const world = await engineWorld(t);
  const first = await commit(world.repo, 'x1');
  await commit(world.repo, 'x2');
  const run = world.run({ maxEvents: 1 });
  await world.events.until(1);
  const [started] = world.events.events;
  assert.equal(started.type, 'started');
  assert.equal(started.data.kind, 'watch_started');
  assert.equal(started.data.since, null);
  assert.equal(started.data.cursor, opIds.at(-1), 'the cursor is the newest operation that already exists');
  assert.notEqual(started.data.cursor, first);
  assert.deepEqual([started.data.debounce_ms, started.data.poll_ms], [100, 1_000_000]);
  assert.match(started.data.snapshot, /^sha256:[0-9a-f]{64}$/);
  assert.equal(world.events.events.length, 1, 'nothing before now is replayed');
  assert.equal(world.watcher.state.path, world.repo.path('akrs'), 'the workflow folder is watched');
  await commit(world.repo, 'x3');
  world.watcher.fire('.ops/journal/ops/whatever.jsonl');
  world.timers.advance(100);
  const result = await run;
  assert.equal(result.ended, 'max_events');
  assert.equal(result.ops, 1);
  assert.equal(world.events.events[1].data.kind, 'watch_op');
});

test('an operation is reported with its command, targets, committed time, changed files and snapshots; the change that follows names the paths', async (t) => {
  const world = await engineWorld(t);
  const run = world.run({ maxEvents: 2 });
  await world.events.until(1);
  const op = await commit(world.repo, 'x1');
  world.watcher.fire('.ops/journal/ops/x.jsonl');
  world.watcher.fire('executors.json');
  world.timers.advance(100);
  const result = await run;
  const [, reported, change] = world.events.events;
  assert.equal(reported.data.kind, 'watch_op');
  assert.deepEqual([reported.data.op, reported.data.command, reported.data.road, reported.data.plan], [op, 'executor-set', null, null]);
  assert.match(reported.data.ts, /^20\d\d-\d\d-\d\dT.*Z$/);
  assert.ok(reported.data.changed.includes('executors.json'), JSON.stringify(reported.data.changed));
  assert.equal(change.data.kind, 'watch_change');
  assert.deepEqual(change.data.paths, ['akrs/executors.json']);
  assert.notEqual(change.data.before, change.data.after);
  assert.deepEqual([result.ended, result.ops, result.changes, result.cursor], ['max_events', 1, 1, op]);
  assert.equal(result.snapshot, change.data.after);
  assert.equal(world.events.events.length, 3, 'started, one operation, one change');
});

test('--since replays exactly the later operations in committed order, then follows live; the cursor resumes the stream', async (t) => {
  const world = await engineWorld(t);
  const a = await commit(world.repo, 'a1');
  const b = await commit(world.repo, 'b1');
  const c = await commit(world.repo, 'c1');
  const run = world.run({ since: a, maxEvents: 3 });
  await world.events.until(3);
  assert.deepEqual(world.events.events.map(({ data }) => data.op ?? data.kind), ['watch_started', b, c]);
  assert.equal(world.events.events[0].data.since, a);
  assert.equal(world.events.events[0].data.cursor, a);
  const d = await commit(world.repo, 'd1');
  world.watcher.fire('.ops/journal/ops/d.jsonl');
  world.timers.advance(100);
  const result = await run;
  assert.equal(world.events.events[3].data.op, d);
  assert.deepEqual([result.ended, result.cursor, result.ops], ['max_events', d, 3]);
});

test('an unknown or pruned operation is a usage error that names the fix and emits nothing', async (t) => {
  const world = await engineWorld(t);
  await assert.rejects(() => world.run({ since: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }), (error) => error instanceof CliUsageError && /without --since/.test(error.message));
  assert.deepEqual(world.events.events, []);
  assert.equal(world.timers.pending(), 0);
  assert.equal(world.watcher.state.handler, null, 'no watcher was opened');
});

test('a burst of file events is debounced into one scan and one change event', async (t) => {
  const world = await engineWorld(t);
  const run = world.run();
  await world.events.until(1);
  const scansAtStart = world.clock.scans;
  await world.repo.write('akrs/tasks/T-burst.md', 'x');
  for (let index = 0; index < 3; index += 1) {
    world.watcher.fire('tasks/T-burst.md');
    world.timers.advance(40);
  }
  assert.equal(world.clock.scans, scansAtStart, 'no scan while events keep arriving inside the quiet window');
  world.timers.advance(100);
  await world.clock.until(scansAtStart + 1);
  assert.equal(world.clock.scans, scansAtStart + 1, 'one scan for the whole burst');
  assert.deepEqual(world.events.kinds().slice(1), ['watch_change']);
  assert.deepEqual(world.events.events[1].data.paths, ['akrs/tasks/T-burst.md']);
  world.controller.abort();
  const result = await run;
  assert.equal(result.ended, 'signal');
});

test('a steady writer cannot starve the stream: the scan runs no later than five windows after the first event of the burst', async (t) => {
  const world = await engineWorld(t);
  const run = world.run();
  await world.events.until(1);
  await world.repo.write('akrs/tasks/T-steady.md', 'x');
  const before = world.clock.scans;
  for (let tick = 0; tick < 8; tick += 1) {
    world.watcher.fire('tasks/T-steady.md');
    world.timers.advance(80);
  }
  await world.clock.until(before + 1);
  assert.equal(world.events.kinds().includes('watch_change'), true, 'the burst was reported although events never paused for a full window');
  world.controller.abort();
  await run;
});

test('drafts, cache and evidence events never schedule a scan, and the files they touch never become events', async (t) => {
  const world = await engineWorld(t);
  const run = world.run();
  await world.events.until(1);
  await mkdir(world.repo.path('akrs/drafts'), { recursive: true });
  await mkdir(world.repo.path('akrs/.cache/view'), { recursive: true });
  await mkdir(world.repo.path('akrs/verifications/P6/evidence/r1'), { recursive: true });
  await writeFile(world.repo.path('akrs/drafts/a.json'), '{}');
  await writeFile(world.repo.path('akrs/.cache/view/index.html'), '<html>');
  await writeFile(world.repo.path('akrs/verifications/P6/evidence/r1/shot.png'), 'png');
  for (const name of ['drafts/a.json', '.cache/view/index.html', '.ops/lock/owner.json', 'verifications/P6/evidence/r1/shot.png']) world.watcher.fire(name);
  assert.equal(world.timers.pending(), 1, 'only the poll timer is armed: nothing was scheduled');
  // a scan forced by the poll finds the same snapshot: still no event
  const scans = world.clock.scans;
  world.timers.advance(1_000_000);
  await world.clock.until(scans + 1);
  assert.deepEqual(world.events.kinds(), ['watch_started']);
  world.controller.abort();
  await run;
});

test('the poll is a safety net: a change whose file event was lost is still found', async (t) => {
  const world = await engineWorld(t, { pollMs: 500 });
  const run = world.run({ maxEvents: 1 });
  await world.events.until(1);
  await world.repo.write('akrs/tasks/T-lost.md', 'x');
  world.timers.advance(500);
  const result = await run;
  assert.equal(world.events.events[1].data.kind, 'watch_change');
  assert.deepEqual(world.events.events[1].data.paths, ['akrs/tasks/T-lost.md']);
  assert.equal(result.ended, 'max_events');
});

test('max-events stops at exactly that many events and never emits more, even from one big scan', async (t) => {
  const world = await engineWorld(t);
  const run = world.run({ since: undefined, maxEvents: 2 });
  await world.events.until(1);
  const first = await commit(world.repo, 'm1');
  const second = await commit(world.repo, 'm2');
  await commit(world.repo, 'm3');
  world.watcher.fire('.ops/journal/ops/x.jsonl');
  world.timers.advance(100);
  const result = await run;
  assert.deepEqual(world.events.events.map(({ data }) => data.op ?? data.kind), ['watch_started', first, second]);
  assert.deepEqual([result.ended, result.ops, result.changes, result.cursor], ['max_events', 2, 0, second], 'the cursor resumes at the first operation not reported');
  assert.equal(world.timers.pending(), 0, 'every timer was cleared');
  assert.equal(world.watcher.state.closed, 1);
});

test('the duration bound ends the stream by itself', async (t) => {
  const world = await engineWorld(t);
  const run = world.run({ durationMs: 5000 });
  await world.events.until(1);
  world.timers.advance(4999);
  assert.equal(world.watcher.state.closed, 0);
  world.timers.advance(1);
  const result = await run;
  assert.deepEqual([result.ended, result.ops, result.changes], ['duration', 0, 0]);
  assert.deepEqual([world.timers.pending(), world.watcher.state.closed], [0, 1]);
});

test('an abort ends the stream cleanly after one last look, so an operation committed just before the signal is not lost', async (t) => {
  const world = await engineWorld(t);
  const run = world.run();
  await world.events.until(1);
  const op = await commit(world.repo, 'late');
  world.controller.abort();
  const result = await run;
  assert.equal(result.ended, 'signal');
  assert.equal(world.events.events.some(({ data }) => data.op === op), true, 'the last scan reported it');
  assert.equal(result.cursor, op);
  assert.deepEqual([world.timers.pending(), world.watcher.state.closed], [0, 1]);
});

test('an already aborted signal still opens the stream and ends at once', async (t) => {
  const world = await engineWorld(t);
  world.controller.abort();
  const result = await world.run();
  assert.equal(result.ended, 'signal');
  assert.equal(world.events.events[0].type, 'started');
  assert.deepEqual([world.timers.pending(), world.watcher.state.closed], [0, 1]);
});

test('a torn last line in the journal is ignored, not an error', async (t) => {
  const world = await engineWorld(t);
  await mkdir(world.repo.path('akrs/.ops/journal/ops'), { recursive: true });
  await writeFile(world.repo.path('akrs/.ops/journal/ops/01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), '{"torn":');
  const run = world.run({ durationMs: 10 });
  await world.events.until(1);
  world.timers.advance(10);
  assert.equal((await run).ended, 'duration');
  assert.deepEqual(world.events.kinds(), ['watch_started']);
});

test('the engine writes nothing: the workflow is byte-identical after a run', async (t) => {
  const world = await engineWorld(t);
  const { treeDigest } = await import('./support.js');
  const before = await treeDigest(world.repo);
  const run = world.run({ durationMs: 10 });
  await world.events.until(1);
  world.timers.advance(10);
  await run;
  assert.equal(await treeDigest(world.repo), before);
});

// ---- the real file watcher -----------------------------------------------------------------------------------------------
test('with the real fs.watch a hand edit is reported by path, and the watcher leaves no handle behind', async (t) => {
  const repo = await navWorld(t);
  const events = collector();
  const clock = scanClock();
  const before = process.getActiveResourcesInfo().filter((name) => name === 'FSEvent').length;
  const controller = new AbortController();
  const run = runWatch({
    repositoryRoot: repo.root, workflowRoot: repo.path('akrs'), debounceMs: 20, pollMs: 50, maxEvents: 1, durationMs: 20_000, signal: controller.signal, emit: events.emit, deps: { onScan: clock.onScan },
  });
  await events.until(1);
  // noise first: two full scans after the writes prove the noise was seen and ignored
  await mkdir(repo.path('akrs/drafts'), { recursive: true });
  await writeFile(repo.path('akrs/drafts/note.json'), '{}');
  await mkdir(repo.path('akrs/.cache/x'), { recursive: true });
  await writeFile(repo.path('akrs/.cache/x/y.txt'), 'y');
  const seen = clock.scans;
  await clock.until(seen + 2);
  assert.deepEqual(events.kinds(), ['watch_started'], 'drafts and cache produced nothing');
  await repo.write('akrs/tasks/T-real.md', 'x');
  const result = await run;
  assert.equal(result.ended, 'max_events');
  assert.deepEqual(events.events[1].data.paths, ['akrs/tasks/T-real.md']);
  assert.equal(process.getActiveResourcesInfo().filter((name) => name === 'FSEvent').length, before, 'the file watcher was closed');
});

// ---- the command ---------------------------------------------------------------------------------------------------------
const parse = (text) => text.trim().split('\n').map((line) => JSON.parse(line));

test('watch --jsonl ends with exactly one complete event carrying the final packet; --since resumes from the op ID', async (t) => {
  const repo = await navWorld(t);
  const first = await commit(repo, 'j1');
  const second = await commit(repo, 'j2');
  const out = await runCommand(repo, ['watch', '--jsonl', '--since', first, '--max-events', '1', '--poll-ms', '50']);
  assert.equal(out.exitCode, 0, out.stderr);
  const events = parse(out.stdout);
  assert.deepEqual(events.map(({ type }) => type), ['started', 'progress', 'complete']);
  assert.deepEqual(events.map(({ sequence }) => sequence), [1, 2, 3]);
  assert.equal(new Set(events.map(({ run_id: id }) => id)).size, 1);
  assert.equal(events[1].data.op, second);
  const packet = events[2].data.packet;
  assert.deepEqual([packet.command, packet.status, packet.data.kind, packet.data.ended, packet.data.since, packet.data.cursor, packet.data.ops], ['watch', 'ok', 'watch', 'max_events', first, second, 1]);
  assert.equal(validateWatchData(packet.data).ok, true, JSON.stringify(validateWatchData(packet.data).issues));
  assert.deepEqual(packet.next_commands, [{ command: 'watch', args: ['--jsonl', '--since', second, '--root', repo.root] }]);
  assert.equal(packet.run_id, events[0].run_id);
});

test('watch without --jsonl needs a bound and then prints only the final packet', async (t) => {
  const repo = await navWorld(t);
  const unbounded = await runCommand(repo, ['watch', '--json']);
  assert.equal(unbounded.exitCode, 2, unbounded.stderr);
  assert.match(JSON.parse(unbounded.stderr === '' ? unbounded.stdout : unbounded.stderr).findings[0].message, /needs a bound/);
  const bounded = await runCommand(repo, ['watch', '--json', '--duration-ms', '120', '--poll-ms', '40']);
  assert.equal(bounded.exitCode, 0, bounded.stderr);
  const packet = JSON.parse(bounded.stdout);
  assert.deepEqual([packet.data.ended, packet.data.ops, packet.data.changes], ['duration', 0, 0]);
});

test('bad flags are usage errors before anything starts', async (t) => {
  const repo = await navWorld(t);
  for (const args of [['--since', 'nope'], ['--max-events', '0'], ['--duration-ms', '0'], ['--debounce-ms', '0'], ['--poll-ms', '9999999'], ['--max-events', 'x']]) {
    const out = await runCommand(repo, ['watch', '--jsonl', ...args]);
    assert.equal(out.exitCode, 2, `${args.join(' ')}: ${out.stdout}${out.stderr}`);
  }
  const unknown = await runCommand(repo, ['watch', '--jsonl', '--since', '01ARZ3NDEKTSV4RRFFQ69G5FAV', '--max-events', '1']);
  assert.equal(unknown.exitCode, 2);
  assert.match(parse(unknown.stdout).at(-1).data.packet.findings[0].message, /without --since/);
});

test('the handler turns an abort signal into a clean end and removes its process signal listeners', async (t) => {
  const repo = await navWorld(t);
  const providers = fakeProviders({ firstId: 7700 });
  const stream = createEventStream({ providers, knownCommands: commandManifest.commands.map(({ id }) => id), write: null });
  const listeners = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((name) => process.listenerCount(name));
  const controller = new AbortController();
  const events = [];
  const original = stream.emit;
  stream.emit = (type, data) => {
    const event = original.call(stream, type, data);
    events.push(type);
    if (type === 'started') setImmediate(() => controller.abort());
    return event;
  };
  const packet = await commandHandlers.watch({
    command: commandManifest.commands.find(({ id }) => id === 'watch'),
    context: { cwd: repo.root },
    input: { flags: { '--root': repo.root, '--debounce-ms': 20, '--poll-ms': 30 }, positionals: {}, format: 'jsonl', stdin: false },
    manifest: commandManifest,
    providers,
    stream,
    deps: { signal: controller.signal },
  });
  assert.deepEqual([packet.status, packet.data.ended], ['ok', 'signal']);
  assert.deepEqual(events, ['started']);
  assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP'].map((name) => process.listenerCount(name)), listeners);
});

// ---- the real process ----------------------------------------------------------------------------------------------------
test('a real watch process streams a hand edit as it happens and ends cleanly on its bound with exit 0', async (t) => {
  const repo = await navWorld(t);
  const child = spawn(process.execPath, [CLI, 'watch', '--jsonl', '--root', repo.root, '--debounce-ms', '20', '--poll-ms', '100', '--max-events', '1', '--duration-ms', '25000'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => child.kill());
  let output = '';
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const lines = [];
  const waiters = [];
  child.stdout.on('data', (chunk) => {
    output += chunk;
    const parts = output.split('\n');
    output = parts.pop();
    for (const line of parts) lines.push(JSON.parse(line));
    for (const waiter of waiters.filter((entry) => entry.count <= lines.length)) waiter.resolve();
  });
  const until = (count) => (lines.length >= count ? Promise.resolve() : new Promise((resolve) => { waiters.push({ count, resolve }); }));
  const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  await until(1);
  assert.equal(lines[0].type, 'started');
  await repo.write('akrs/tasks/T-live.md', 'x');
  const exit = await closed;
  assert.deepEqual(exit, { code: 0, signal: null }, errors);
  assert.deepEqual(lines.map(({ type }) => type), ['started', 'progress', 'complete']);
  assert.deepEqual(lines[1].data.paths, ['akrs/tasks/T-live.md']);
  assert.equal(lines[2].data.packet.data.ended, 'max_events');
  assert.equal(errors, '');
});
