// The legal next-command builders of the lifecycle commands. Pure: every command is a manifest command ID with arguments
// that run as they are. `rootArgs` carry the root overrides of the invocation; a lifecycle mutation names the current
// snapshot because it needs --if-snapshot.
const withRoots = (args, rootArgs) => [...args, ...(rootArgs ?? [])];
const checkOf = (id, rootArgs) => ({ command: 'road-check', args: withRoots([id], rootArgs) });

// phase `ready`: { id, status, snapshot, rootArgs } (the transitions that are legal now); `blocked`: { id, rootArgs }
function checkBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'ready') {
    const guarded = (command) => ({ command, args: withRoots([context.id, '--if-snapshot', context.snapshot], rootArgs) });
    if (context.status === 'QUEUED') return [guarded('road-activate')];
    if (context.status === 'ACTIVE') return [{ command: 'verify', args: withRoots(['--road', context.id], rootArgs) }, guarded('road-finish')];
    return [guarded('road-reopen')];
  }
  if (phase === 'blocked') return [{ command: 'road-details', args: withRoots([context.id, '--role', 'leader'], rootArgs) }];
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

// phase `done`: { id, rootArgs }; `rejected`: { id, rootArgs }
const transitionBuilder = (done) => ({ phase, ...context }) => {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'done') return done(context.id, rootArgs);
  if (phase === 'rejected') return [checkOf(context.id, rootArgs)];
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
};

export const LIFECYCLE_NEXT_COMMAND_BUILDERS = Object.freeze({
  'road-check': checkBuilder,
  'road-activate': transitionBuilder((id, rootArgs) => [{ command: 'road-details', args: withRoots([id, '--role', 'worker'], rootArgs) }]),
  'road-finish': transitionBuilder((_id, rootArgs) => [{ command: 'state-render', args: withRoots([], rootArgs) }]),
  'road-reopen': transitionBuilder((id, rootArgs) => [checkOf(id, rootArgs)]),
  'lease-release': transitionBuilder((id, rootArgs) => [checkOf(id, rootArgs)]),
});
