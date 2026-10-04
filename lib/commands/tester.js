// Handlers of `test define`, `test handoff` (P1-W10) and `test result` (P2-W07). They parse flags, resolve roots, pick the input channel and
// return the packet the store flow built; no domain rule lives here. A handoff is four flat fields, so it can also be
// given as flags (--road, --result, --reach (repeatable), --expect) instead of a document.
import { CliUsageError } from '../core/errors.js';
import { SNAPSHOT_PATTERN, isId } from '../schemas/common.js';
import { HANDOFF_SCHEMA, VERDICTS } from '../schemas/handoff-result.js';
import { TEST_RESULT_NEXT_COMMAND_BUILDERS } from '../store/test-result/next-commands.js';
import { appendResult } from '../store/test-result/index.js';
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

// `test result <plan>`: the short form (--verdict, --because) or the full document (--input, --json -). The CLI fills identity, run
// and evidence metadata under the lock; no hash or snapshot is ever a flag.
export async function createTestResultPacket(parameters) {
  const { roots, flags, key, options } = common(parameters, 'test result');
  const { input, readStdin } = parameters;
  const next = TEST_RESULT_NEXT_COMMAND_BUILDERS['test-result']({ phase: 'template', plan: key, rootArgs: options.rootArgs });
  const usage = (reason, message, data = {}) => usagePacket({ command: 'test-result', parameters, roots, reason, next, message, data });
  const short = ['--verdict', '--because'].filter((name) => flags[name] !== undefined);
  const channels = [flags['--input'] !== undefined, input.stdin, short.length > 0].filter(Boolean).length;
  if (channels > 1) return usage('two_input_channels', 'test result takes ONE of: --input <path>, --json -, or the short form --verdict <pass|fail|blocked> --because "<why>"');
  if (channels === 0) {
    return usage('missing_input', 'test result needs --verdict <pass|fail|blocked> --because "<why>", or a full result with --input <path> or --json -');
  }
  const common2 = { ...options, env: process.env, again: flags['--again'] === true };
  if (short.length > 0) {
    const missing = ['--verdict', '--because'].filter((name) => flags[name] === undefined);
    if (missing.length > 0) return usage('missing_input', `test result is missing ${missing.join(', ')}`, { missing_inputs: missing });
    if (!VERDICTS.includes(flags['--verdict'])) return usage('invalid_verdict', `--verdict must be one of: ${VERDICTS.join(', ')}`);
    return (await appendResult({ ...common2, flat: { verdict: flags['--verdict'], because: flags['--because'] } })).packet;
  }
  const channel = input.stdin ? { stdin: await readStdin() } : { inputPath: flags['--input'] };
  return (await appendResult({ ...common2, channel })).packet;
}
