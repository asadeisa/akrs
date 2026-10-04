// The legal next-command builders of state-set and state-render. Pure functions: every command is a manifest command ID
// with arguments that run as they are, never a placeholder.
const withRoots = (args, rootArgs) => [...args, ...rootArgs];

// phase `written`: { rootArgs }; phase `rejected`: { rootArgs }
function stateSetBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'written' || phase === 'rejected') return [{ command: 'validate', args: withRoots([], rootArgs) }];
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

// phase `rendered`: { rootArgs }; phase `rejected`: { reason, rootArgs } (a missing state is created with state set)
function stateRenderBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'rendered') return [{ command: 'validate', args: withRoots([], rootArgs) }];
  if (phase === 'rejected') {
    return context.reason === 'state_missing'
      ? [{ command: 'state-set', args: withRoots(['--mode', '0', '--role', 'leader'], rootArgs) }]
      : [{ command: 'validate', args: withRoots([], rootArgs) }];
  }
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

export const STATE_NEXT_COMMAND_BUILDERS = Object.freeze({ 'state-set': stateSetBuilder, 'state-render': stateRenderBuilder });
