// Handler of `memory add` (P1-W08). It parses flags, resolves roots, picks the input channel and returns the packet the
// store flow built; no domain rule lives here. Same channels and usage errors as the Road and Task writers.
import { CliUsageError } from '../core/errors.js';
import { SNAPSHOT_PATTERN } from '../schemas/common.js';
import { MEMORY_NEXT_COMMAND_BUILDERS } from '../store/memory/next-commands.js';
import { addMemory } from '../store/memory/writer.js';
import { knownCommandsOf, resolveRoots, rootArgsOf, usagePacket } from './authoring.js';

const COMMAND = 'memory-add';

export async function createMemoryAddPacket(parameters) {
  const { input, manifest, providers, readStdin } = parameters;
  const roots = resolveRoots(parameters);
  const { flags } = input;
  const noInput = () => MEMORY_NEXT_COMMAND_BUILDERS[COMMAND]({ phase: 'rejected', file: null, rootArgs: [] });

  if (flags['--input'] !== undefined && input.stdin) {
    return usagePacket({
      command: COMMAND, parameters, roots, reason: 'two_input_channels', next: noInput(),
      message: 'memory add takes its document from --input <path> or from stdin (--json -), not both',
    });
  }
  if (flags['--input'] === undefined && !input.stdin) {
    return usagePacket({
      command: COMMAND, parameters, roots, reason: 'missing_input', next: noInput(),
      message: 'memory add needs a document: pass --input <path> (for example a draft) or --json - with the document on stdin',
    });
  }
  const expectedSnapshot = flags['--if-snapshot'];
  if (expectedSnapshot !== undefined && !SNAPSHOT_PATTERN.test(expectedSnapshot)) {
    throw new CliUsageError('--if-snapshot must be sha256:<64 lowercase hex>');
  }
  const channel = input.stdin ? { stdin: await readStdin() } : { inputPath: flags['--input'] };
  const result = await addMemory({
    repositoryRoot: roots.repository_root,
    workflowRoot: roots.workflow_root,
    channel,
    requestId: flags['--request-id'],
    dryRun: flags['--dry-run'] === true,
    again: flags['--again'] === true,
    expectedSnapshot,
    providers,
    knownCommands: knownCommandsOf(manifest),
    rootArgs: rootArgsOf(flags),
  });
  return result.packet;
}
