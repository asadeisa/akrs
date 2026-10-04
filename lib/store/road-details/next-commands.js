// The legal next-command builder of `road-details`. Pure: every command is a manifest command ID with arguments that run
// as they are, never a placeholder. `rootArgs` carry the root overrides of the invocation.
const withRoots = (args, rootArgs) => [...args, ...(rootArgs ?? [])];

// phase `ready`: { id, role, pending, rootArgs }; `blocked`: { rootArgs }; `refused`: { id, role, rootArgs }
function roadDetailsBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'refused') return [{ command: 'road-details', args: withRoots([context.id, '--role', context.role], rootArgs) }];
  if (phase === 'blocked') return [{ command: 'validate', args: withRoots([], rootArgs) }];
  if (phase === 'ready') {
    const commands = [];
    if (context.pending === true) commands.push({ command: 'scope-list', args: withRoots([context.id], rootArgs) });
    if (context.role === 'worker') {
      commands.push({ command: 'verify', args: withRoots(['--road', context.id], rootArgs) });
      commands.push({ command: 'audit', args: withRoots(['--git', '--road', context.id], rootArgs) });
    }
    else commands.push({ command: 'road-fit', args: withRoots([context.id], rootArgs) });
    return commands;
  }
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

export const ROAD_DETAILS_NEXT_COMMAND_BUILDERS = Object.freeze({ 'road-details': roadDetailsBuilder });
