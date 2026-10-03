// The legal next-command builder of memory-add (the manifest's `next_command_builder`). A pure function: every command
// it returns is a manifest command ID with arguments that run as they are, never with a placeholder. `rootArgs` are the
// root overrides of the invocation, carried so the next command runs against the same workflow.
const withRoots = (args, rootArgs) => [...args, ...rootArgs];

// phase `created`: { rootArgs }
// phase `rejected`: { file: string|null, rootArgs }  the retry of the same document, then the form that fills it
// phase `duplicate`: { file: string|null, rootArgs } the exact duplicate was a noop; --again appends it deliberately
function memoryAddBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  const file = context.file ?? null;
  if (phase === 'created') return [{ command: 'validate', args: withRoots([], rootArgs) }];
  if (phase === 'rejected') {
    return [
      ...(file === null ? [] : [{ command: 'memory-add', args: withRoots(['--input', file], rootArgs) }]),
      { command: 'template', args: ['memory'] },
    ];
  }
  if (phase === 'duplicate') {
    return [{ command: 'memory-add', args: withRoots([...(file === null ? ['--json', '-'] : ['--input', file]), '--again'], rootArgs) }];
  }
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

export const MEMORY_NEXT_COMMAND_BUILDERS = Object.freeze({ 'memory-add': memoryAddBuilder });
