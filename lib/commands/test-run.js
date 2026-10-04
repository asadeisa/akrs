// Handler of `test run <plan>` (P2-W14): an execution. It parses and checks the input, turns an interruption signal into an
// abort, maps the run facts to closed events when the adapter gave it a stream, and wraps the one final packet. No domain
// rule lives here.
import { CliUsageError } from '../core/errors.js';
import { isId } from '../schemas/common.js';
import { RUN_EVENT_KINDS, validateRunEventData } from '../schemas/run-events.js';
import { runTestScenario } from '../store/test-run/index.js';
import { resolveRoots, rootArgsOf, knownCommandsOf } from './authoring.js';

const INTERRUPTIONS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// run facts -> closed events (the facts carry everything an event says)
function eventSink(stream) {
  stream.validateWith(validateRunEventData);
  const progress = (phase, fact) => stream.emit('progress', {
    kind: RUN_EVENT_KINDS.progress, phase, index: fact.index ?? null, name: fact.name ?? null, status: fact.status ?? null, duration_ms: fact.duration_ms ?? null,
  });
  return (fact) => {
    switch (fact.type) {
      case 'started':
        stream.emit('started', { kind: RUN_EVENT_KINDS.started, plan: fact.plan, holder: fact.holder, policy: fact.policy, steps: fact.steps, timeout_ms: fact.timeout_ms });
        break;
      case 'progress':
        progress(fact.phase, fact);
        break;
      case 'step_started':
        progress('step_started', { index: fact.index, name: fact.step });
        break;
      case 'step_finished':
        progress('step_finished', { index: fact.index, name: fact.step, status: fact.status, duration_ms: fact.duration_ms });
        break;
      case 'step_skipped':
        progress('step_skipped', { index: fact.index, name: fact.step, status: 'skipped' });
        break;
      case 'artifact':
        stream.emit('evidence', { kind: RUN_EVENT_KINDS.evidence, type: fact.artifact.type, name: fact.artifact.name, bytes: fact.artifact.bytes });
        break;
      case 'finding':
        stream.emit('finding', { kind: RUN_EVENT_KINDS.finding, finding: fact.finding });
        break;
      default:
        break;
    }
  };
}

export async function createTestRunPacket(parameters) {
  const { input, manifest, providers, stream = null, engine = runTestScenario, deps = {}, env = process.env } = parameters;
  const roots = resolveRoots(parameters);
  const key = input.positionals.plan;
  if (key === undefined || !isId(key)) throw new CliUsageError('test run takes a Plan ID (or the ID of a Road without a Plan): akrs test run <plan>');
  const executorFlag = input.flags['--executor'];
  if (executorFlag !== undefined && !isId(executorFlag)) throw new CliUsageError('--executor takes an executor ID');
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  for (const name of INTERRUPTIONS) process.on(name, interrupt);
  const signal = deps.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, deps.signal]);
  let result;
  try {
    result = await engine({
      repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root, key, executorFlag, env, signal, providers,
      packetProviders: () => (stream === null ? providers : stream.finalProviders()),
      knownCommands: knownCommandsOf(manifest), rootArgs: rootArgsOf(input.flags), onFact: stream === null ? null : eventSink(stream), deps,
    });
  } finally {
    for (const name of INTERRUPTIONS) process.removeListener(name, interrupt);
  }
  if (result.problem === 'unknown_plan') throw new CliUsageError(`test run: no Plan or Road without a Plan is named ${key}`);
  return result.packet;
}
