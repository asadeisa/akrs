// The legal next-command builder of init-scaffold. A pure function: every command is a manifest command ID with
// arguments that run as they are, never a placeholder.
const withRoots = (args, rootArgs) => [...args, ...rootArgs];

// phase `created` | `rejected`: { rootArgs }
function initScaffoldBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'created') {
    return [
      { command: 'executor-list', args: withRoots([], rootArgs) },
      { command: 'validate', args: withRoots([], rootArgs) },
    ];
  }
  if (phase === 'rejected') return [{ command: 'validate', args: withRoots([], rootArgs) }];
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

export const SCAFFOLD_NEXT_COMMAND_BUILDERS = Object.freeze({ 'init-scaffold': initScaffoldBuilder });
