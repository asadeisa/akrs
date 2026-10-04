// Handler of `verify --road` (P2-W03/W04): an execution of declared checks. It parses flags, resolves roots, turns an
// interruption signal into an abort for the runner, maps the runner's facts to events when the adapter gave it a stream,
// and wraps the one final result. No domain rule lives here.
import { CliUsageError } from '../core/errors.js';
import { createPacket } from '../core/packet.js';
import { isId } from '../schemas/common.js';
import { VERIFY_EVENT_KINDS, validateVerifyEvent } from '../schemas/verify-events.js';
import { verifyRoad } from '../store/verify/index.js';
import { knownCommandsOf, resolveRoots, rootArgsOf } from './authoring.js';

const INTERRUPTIONS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// runner facts -> closed events (the facts carry everything an event says)
function eventSink(stream) {
  stream.validateWith(validateVerifyEvent);
  const progress = (phase, fact, extra = {}) => stream.emit('progress', {
    kind: VERIFY_EVENT_KINDS.progress, phase, index: fact.index, name: fact.name, status: null, reason: null, exit_code: null, signal: null, duration_ms: null, ...extra,
  });
  return (fact) => {
    if (fact.type === 'started') {
      stream.emit('started', {
        kind: VERIFY_EVENT_KINDS.started, road: fact.road, mode: 'mechanical', dry_run: fact.dryRun, checks: fact.checks, limits: fact.limits,
      });
    } else if (fact.type === 'check_started') {
      progress('check_started', fact);
    } else if (fact.type === 'terminating') {
      progress('check_terminating', fact, { reason: fact.reason });
    } else if (fact.type === 'check_finished') {
      const { record } = fact;
      for (const name of ['stdout', 'stderr']) {
        const captured = record[name];
        if (captured.total_bytes === 0) continue;
        stream.emit('evidence', {
          kind: VERIFY_EVENT_KINDS.evidence, index: fact.index, name: fact.name, stream: name, total_bytes: captured.total_bytes, truncated: captured.truncated, text: captured.text, tail: captured.tail,
        });
      }
      progress('check_finished', fact, { status: record.status, exit_code: record.exit_code, signal: record.signal, duration_ms: record.duration_ms });
    }
  };
}

export async function createVerifyPacket(parameters) {
  const { input, manifest, providers, stream = null } = parameters;
  const roots = resolveRoots(parameters);
  const { flags } = input;
  const id = flags['--road'];
  if (id === undefined) throw new CliUsageError('verify needs --road <id>: akrs verify --road <id> [--check <name>] [--dry-run]');
  if (!isId(id)) throw new CliUsageError('--road takes a Road ID');
  const check = flags['--check'] ?? null;
  if (check !== null && check === '') throw new CliUsageError('--check takes the name of a declared check');
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  for (const name of INTERRUPTIONS) process.on(name, interrupt);
  const sink = stream === null ? null : eventSink(stream);
  let result;
  try {
    result = await verifyRoad({
      repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root, id, check, dryRun: flags['--dry-run'] === true,
      ifSnapshot: flags['--if-snapshot'] ?? null, env: process.env, signal: controller.signal, rootArgs: rootArgsOf(flags),
      clock: providers.monotonic, onFact: sink,
    });
  } finally {
    for (const name of INTERRUPTIONS) process.removeListener(name, interrupt);
  }
  if (result.problem === 'road_missing') throw new CliUsageError(`verify: no Road ${id} exists`);
  const packet = createPacket({
    command: 'verify',
    status: result.status,
    root: roots.repository_root,
    snapshot: result.snapshot,
    data: result.data,
    findings: result.findings,
    nextCommands: result.nextCommands,
    providers: stream?.active ? stream.finalProviders() : providers,
    knownCommands: knownCommandsOf(manifest),
  });
  if (stream?.active) for (const finding of packet.findings) stream.emit('finding', { kind: VERIFY_EVENT_KINDS.finding, finding });
  return packet;
}
