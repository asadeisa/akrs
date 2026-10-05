// Handlers of the Worker intents `work`, `done` and `yield` (P2-W12). They parse flags, resolve roots, turn an interruption into an abort for
// the check runner of `done` and wrap the result the store built; no domain rule lives here.
import { CliUsageError } from '../../core/errors.js';
import { SNAPSHOT_PATTERN, isId } from '../../schemas/common.js';
import { doneIntent, workIntent, yieldIntent } from '../../store/intents/index.js';
import { DONE_FLAGS } from '../../store/intents/policy.js';
import { readAuthoringInput } from '../../store/roads/input.js';
import { knownCommandsOf, resolveRoots, rootArgsOf, usagePacket } from '../authoring.js';

const INTERRUPTIONS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const listOf = (value) => (value === undefined ? [] : [].concat(value));

function roadOf(parameters, verb, required) {
  const id = parameters.input.positionals.road;
  if (id === undefined) {
    if (required) throw new CliUsageError(`${verb} takes a Road ID: akrs ${verb} <road>`);
    return null;
  }
  if (!isId(id)) throw new CliUsageError(`${verb} takes a Road ID: akrs ${verb} <road>`);
  return id;
}

function common(parameters) {
  const { manifest, providers } = parameters;
  const roots = resolveRoots(parameters);
  const { flags } = parameters.input;
  return {
    roots,
    flags,
    options: {
      repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root, executorFlag: flags['--executor'], env: process.env,
      rootArgs: rootArgsOf(flags), providers, knownCommands: knownCommandsOf(manifest),
    },
  };
}

export async function createWorkPacket(parameters) {
  const { flags, options } = common(parameters);
  const road = roadOf(parameters, 'work', false);
  const result = await workIntent({ ...options, road, takeover: flags['--takeover'] === true });
  if (result.problem === 'road_missing') throw new CliUsageError(`work: no Road ${road} exists`);
  return result.packet;
}

// The baton: the flat flags, or a file (--handoff <path>) with { result, reach, expect }; the two do not mix.
async function batonOf(parameters, roots, id) {
  const { flags } = parameters.input;
  const flat = DONE_FLAGS.filter((name) => flags[name] !== undefined);
  if (flags['--handoff'] !== undefined && flat.length > 0) {
    return { usage: usagePacket({ command: 'done', parameters, roots, reason: 'two_input_channels', message: 'done takes the baton from --handoff <file> or from --result --reach --expect, not both', next: [] }) };
  }
  if (flags['--handoff'] !== undefined) {
    const input = await readAuthoringInput({ repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root, channel: { inputPath: flags['--handoff'] } });
    if (!input.ok) {
      return { usage: usagePacket({ command: 'done', parameters, roots, reason: 'invalid_input', message: `--handoff ${flags['--handoff']}: ${input.issues[0].message}`, next: [] }) };
    }
    const { document } = input;
    if (document.road !== undefined && document.road !== id) {
      return { usage: usagePacket({ command: 'done', parameters, roots, reason: 'invalid_input', message: `--handoff names Road ${String(document.road)} but done finishes ${id}`, next: [] }) };
    }
    return { baton: { result: document.result, reach: document.reach, expect: document.expect } };
  }
  const missing = DONE_FLAGS.filter((name) => flags[name] === undefined);
  if (missing.length > 0) {
    return {
      usage: usagePacket({
        command: 'done', parameters, roots, reason: 'missing_input', data: { missing_inputs: missing }, next: [],
        message: `done needs the baton for the Tester: --result "<what is ready>" --reach "<step>" (repeat) --expect "<what to see>" (missing ${missing.join(', ')}), or --handoff <file>`,
      }),
    };
  }
  return { baton: { result: flags['--result'], reach: listOf(flags['--reach']), expect: flags['--expect'] } };
}

export async function createDonePacket(parameters) {
  const { roots, flags, options } = common(parameters);
  const id = roadOf(parameters, 'done', true);
  const expectedSnapshot = flags['--if-snapshot'];
  if (expectedSnapshot !== undefined && !SNAPSHOT_PATTERN.test(expectedSnapshot)) throw new CliUsageError('--if-snapshot must be sha256:<64 lowercase hex>');
  const { baton, usage } = await batonOf(parameters, roots, id);
  if (usage !== undefined) return usage;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  for (const name of INTERRUPTIONS) process.on(name, interrupt);
  try {
    const result = await doneIntent({
      ...options,
      road: id,
      baton,
      deviations: flags['--deviations'] ?? null,
      preExisting: listOf(flags['--pre-existing']),
      requestId: flags['--request-id'],
      dryRun: flags['--dry-run'] === true,
      expectedSnapshot,
      signal: controller.signal,
      clock: options.providers.monotonic,
    });
    if (result.problem === 'road_missing') throw new CliUsageError(`done: no Road ${id} exists`);
    return result.packet;
  } finally {
    for (const name of INTERRUPTIONS) process.removeListener(name, interrupt);
  }
}

export async function createYieldPacket(parameters) {
  const { flags, options } = common(parameters);
  const id = roadOf(parameters, 'yield', true);
  const result = await yieldIntent({ ...options, road: id, reason: flags['--reason'], requestId: flags['--request-id'], dryRun: flags['--dry-run'] === true });
  if (result.problem === 'road_missing') throw new CliUsageError(`yield: no Road ${id} exists`);
  return result.packet;
}
