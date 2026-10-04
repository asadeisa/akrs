// The legal next-command builder of `verify`. Pure: every command is a manifest command ID with arguments that run as they
// are, never a placeholder. `rootArgs` carry the root overrides of the invocation.
const withRoots = (args, rootArgs) => [...args, ...(rootArgs ?? [])];

// phase `passed`: { id, rootArgs } (the audit is the next step of the Worker loop); `failed`: { id, rootArgs } (read the
// packet again, then fix); `dry_run`: { id, rootArgs } (the same run for real); `blocked`: { rootArgs }; `stale`: { id, rootArgs }
function verifyBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'passed') return [{ command: 'audit', args: withRoots(['--git', '--road', context.id], rootArgs) }];
  if (phase === 'failed' || phase === 'stale') return [{ command: 'road-details', args: withRoots([context.id], rootArgs) }];
  if (phase === 'dry_run') return [{ command: 'verify', args: withRoots(['--road', context.id], rootArgs) }];
  if (phase === 'blocked') return [{ command: 'validate', args: withRoots([], rootArgs) }];
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

export const VERIFY_NEXT_COMMAND_BUILDERS = Object.freeze({ verify: verifyBuilder });
