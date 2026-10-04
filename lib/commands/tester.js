// Handlers of `test define` and `test handoff` (P1-W10). They parse flags, resolve roots, pick the input channel and
// return the packet the store flow built; no domain rule lives here. A handoff is four flat fields, so it can also be
// given as flags (--road, --result, --reach (repeatable), --expect) instead of a document.
import { CliUsageError } from '../core/errors.js';
import { SNAPSHOT_PATTERN, isId } from '../schemas/common.js';
import { HANDOFF_SCHEMA } from '../schemas/handoff-result.js';
import { VERIFICATION_NEXT_COMMAND_BUILDERS } from '../store/verification/next-commands.js';
import { appendHandoff, defineVerification } from '../store/verification/writer.js';
import { knownCommandsOf, resolveRoots, rootArgsOf, usagePacket } from './authoring.js';

const FLAT_FLAGS = ['--road', '--result', '--reach', '--expect'];

function common(parameters, verb) {
  const { input, manifest, providers } = parameters;
  const roots = resolveRoots(parameters);
  const { flags } = input;
  const key = input.positionals.plan;
  if (!isId(key)) throw new CliUsageError(`${verb} needs a Plan ID (or, without a Plan, a Road ID)`);
  const expectedSnapshot = flags['--if-snapshot'];
  if (expectedSnapshot !== undefined && !SNAPSHOT_PATTERN.test(expectedSnapshot)) throw new CliUsageError('--if-snapshot must be sha256:<64 lowercase hex>');
  return {
    roots,
    flags,
    key,
    options: {
      repositoryRoot: roots.repository_root,
      workflowRoot: roots.workflow_root,
      key,
      requestId: flags['--request-id'],
      dryRun: flags['--dry-run'] === true,
      expectedSnapshot,
      providers,
      knownCommands: knownCommandsOf(manifest),
      rootArgs: rootArgsOf(flags),
    },
  };
}

export async function createTestDefinePacket(parameters) {
  const { roots, flags, key, options } = common(parameters, 'test define');
  const { input, readStdin } = parameters;
  const next = VERIFICATION_NEXT_COMMAND_BUILDERS['test-define']({ phase: 'rejected', plan: key, file: null, rootArgs: options.rootArgs });
  if (flags['--input'] !== undefined && input.stdin) {
    return usagePacket({ command: 'test-define', parameters, roots, reason: 'two_input_channels', next, message: 'test define takes its document from --input <path> or from stdin (--json -), not both' });
  }
  if (flags['--input'] === undefined && !input.stdin) {
    return usagePacket({ command: 'test-define', parameters, roots, reason: 'missing_input', next, message: 'test define needs a document: pass --input <path> (for example a draft) or --json - with the document on stdin' });
  }
  const channel = input.stdin ? { stdin: await readStdin() } : { inputPath: flags['--input'] };
  return (await defineVerification({ ...options, channel })).packet;
}

export async function createTestHandoffPacket(parameters) {
  const { roots, flags, key, options } = common(parameters, 'test handoff');
  const { input, readStdin } = parameters;
  const next = VERIFICATION_NEXT_COMMAND_BUILDERS['test-handoff']({ phase: 'rejected', plan: key, file: null, rootArgs: options.rootArgs });
  const flat = FLAT_FLAGS.filter((name) => flags[name] !== undefined);
  const channels = [flags['--input'] !== undefined, input.stdin, flat.length > 0].filter(Boolean).length;
  if (channels > 1) {
    return usagePacket({ command: 'test-handoff', parameters, roots, reason: 'two_input_channels', next, message: 'test handoff takes ONE of: --input <path>, --json -, or the flat flags --road --result --reach --expect' });
  }
  if (channels === 0) {
    return usagePacket({
      command: 'test-handoff', parameters, roots, reason: 'missing_input', next,
      message: 'test handoff needs the baton: --road <id> --result "<what is ready>" --reach "<step>" (repeat) --expect "<what to see>", or --input <path>, or --json -',
    });
  }
  let channel;
  if (flat.length > 0) {
    const missing = FLAT_FLAGS.filter((name) => flags[name] === undefined);
    if (missing.length > 0) {
      return usagePacket({ command: 'test-handoff', parameters, roots, reason: 'missing_input', data: { missing_inputs: missing }, next, message: `test handoff is missing ${missing.join(', ')}` });
    }
    const reach = Array.isArray(flags['--reach']) ? flags['--reach'] : [flags['--reach']];
    channel = {
      stdin: Buffer.from(JSON.stringify({ schema: HANDOFF_SCHEMA, road: flags['--road'], result: flags['--result'], reach, expect: flags['--expect'] })),
    };
  } else {
    channel = input.stdin ? { stdin: await readStdin() } : { inputPath: flags['--input'] };
  }
  return (await appendHandoff({ ...options, channel, again: flags['--again'] === true })).packet;
}
