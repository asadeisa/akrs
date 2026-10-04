// The legal next-command builder of log-append (the manifest's `next_command_builder`). A pure function: every command
// it returns is a manifest command ID with arguments that run as they are, never with a placeholder.
const withRoots = (args, rootArgs) => [...args, ...rootArgs];

// phase `created`: { rootArgs }
// phase `rejected`: { document: { kind, subject, outcome, deviations }|null, rootArgs }  the retry of the same closure
function logAppendBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'created') return [{ command: 'validate', args: withRoots([], rootArgs) }];
  if (phase === 'rejected') {
    const { document = null } = context;
    if (document === null) return [{ command: 'validate', args: withRoots([], rootArgs) }];
    const args = ['--kind', document.kind, '--subject', document.subject, '--outcome', document.outcome];
    if (document.deviations !== null) args.push('--deviations', document.deviations);
    return [{ command: 'log-append', args: withRoots(args, rootArgs) }];
  }
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

export const LOG_NEXT_COMMAND_BUILDERS = Object.freeze({ 'log-append': logAppendBuilder });
