// Handler of `log append` (P1-W09). It parses flags, resolves roots and returns the packet the store flow built; no
// domain rule lives here. A closure has four fields, so the document comes from flat flags (no input channel).
import { CliUsageError } from '../core/errors.js';
import { SNAPSHOT_PATTERN } from '../schemas/common.js';
import { LOG_NEXT_COMMAND_BUILDERS } from '../store/log/next-commands.js';
import { appendClosure } from '../store/log/writer.js';
import { knownCommandsOf, resolveRoots, rootArgsOf, usagePacket } from './authoring.js';

const COMMAND = 'log-append';

export async function createLogAppendPacket(parameters) {
  const { input, manifest, providers } = parameters;
  const roots = resolveRoots(parameters);
  const { flags } = input;
  const rootArgs = rootArgsOf(flags);
  const missing = ['--kind', '--subject', '--outcome'].filter((name) => flags[name] === undefined);
  if (missing.length > 0) {
    return usagePacket({
      command: COMMAND,
      parameters,
      roots,
      reason: 'missing_input',
      data: { missing_inputs: missing },
      next: LOG_NEXT_COMMAND_BUILDERS[COMMAND]({ phase: 'rejected', document: null, rootArgs }),
      message: `log append needs ${missing.join(', ')}: for example --kind road --subject R-P6-1 --outcome DONE`,
    });
  }
  const expectedSnapshot = flags['--if-snapshot'];
  if (expectedSnapshot !== undefined && !SNAPSHOT_PATTERN.test(expectedSnapshot)) {
    throw new CliUsageError('--if-snapshot must be sha256:<64 lowercase hex>');
  }
  const result = await appendClosure({
    repositoryRoot: roots.repository_root,
    workflowRoot: roots.workflow_root,
    document: {
      kind: flags['--kind'],
      subject: flags['--subject'],
      outcome: flags['--outcome'],
      deviations: flags['--deviations'] ?? null,
    },
    requestId: flags['--request-id'],
    dryRun: flags['--dry-run'] === true,
    expectedSnapshot,
    providers,
    knownCommands: knownCommandsOf(manifest),
    rootArgs,
  });
  return result.packet;
}
