// Handler of `watch [--jsonl]` (P2-W17): parses and checks the input, turns an interruption signal into an abort, maps the engine's events to
// the stream the adapter gave it, and wraps the one final packet. No watch rule lives here; it reads and writes nothing.
import { CliUsageError } from '../core/errors.js';
import { createPacket } from '../core/packet.js';
import { isUlid } from '../schemas/common.js';
import { validateWatchEventData } from '../schemas/desktop.js';
import { EMPTY_SNAPSHOT } from '../store/snapshots/projections.js';
import { DESKTOP_NEXT_COMMAND_BUILDERS } from '../userconfig/next-commands.js';
import { WATCH_DEFAULTS, WATCH_LIMITS, WATCH_SCHEMA, runWatch } from '../watch/index.js';
import { knownCommandsOf, resolveRoots, rootArgsOf } from './authoring.js';

const INTERRUPTIONS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function limited(flags, name, key) {
  const value = flags[name];
  if (value === undefined) return null;
  const [min, max] = WATCH_LIMITS[key];
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new CliUsageError(`${name} is an integer from ${min} to ${max}`);
  return value;
}

export async function createWatchPacket(parameters) {
  const { input, manifest, providers, stream = null, deps = {} } = parameters;
  const roots = resolveRoots(parameters);
  const since = input.flags['--since'] ?? null;
  if (since !== null && !isUlid(since)) throw new CliUsageError('watch --since takes an operation ID: the 26-character request ID of a committed operation');
  const debounceMs = limited(input.flags, '--debounce-ms', 'debounce_ms') ?? WATCH_DEFAULTS.debounce_ms;
  const pollMs = limited(input.flags, '--poll-ms', 'poll_ms') ?? WATCH_DEFAULTS.poll_ms;
  const maxEvents = limited(input.flags, '--max-events', 'max_events');
  const durationMs = limited(input.flags, '--duration-ms', 'duration_ms');
  if (stream === null && maxEvents === null && durationMs === null) {
    throw new CliUsageError('watch without --jsonl prints only its final packet, so it needs a bound: --max-events <n> or --duration-ms <ms> (or use watch --jsonl)');
  }
  if (stream !== null) stream.validateWith(validateWatchEventData);

  const controller = new AbortController();
  const interrupt = () => controller.abort();
  for (const name of INTERRUPTIONS) process.on(name, interrupt);
  const signal = deps.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, deps.signal]);
  let result;
  try {
    result = await runWatch({
      repositoryRoot: roots.repository_root,
      workflowRoot: roots.workflow_root,
      since,
      debounceMs,
      pollMs,
      maxEvents,
      durationMs,
      signal,
      emit: (type, data) => { if (stream !== null) stream.emit(type, data); },
      deps: deps.watch ?? {},
    });
  } finally {
    for (const name of INTERRUPTIONS) process.removeListener(name, interrupt);
  }
  return createPacket({
    command: 'watch',
    status: 'ok',
    root: roots.repository_root,
    snapshot: { before: EMPTY_SNAPSHOT, after: EMPTY_SNAPSHOT },
    data: { kind: 'watch', packet_version: WATCH_SCHEMA, ended: result.ended, since: result.since, cursor: result.cursor, ops: result.ops, changes: result.changes, snapshot: result.snapshot },
    nextCommands: DESKTOP_NEXT_COMMAND_BUILDERS.watch({ phase: 'ended', cursor: result.cursor, rootArgs: rootArgsOf(input.flags) }),
    providers: stream === null ? providers : stream.finalProviders(),
    knownCommands: knownCommandsOf(manifest),
  });
}
