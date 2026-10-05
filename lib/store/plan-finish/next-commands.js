// The legal next-command builder of `plan finish`. Pure: every command is a manifest command ID with arguments that run as they
// are. A close needs --if-snapshot, so the ready phase names the snapshot it was previewed at.
const withRoots = (args, rootArgs) => [...args, ...(rootArgs ?? [])];

// phases: `ready` { plan, snapshot, rootArgs }; `done` { rootArgs }; `blocked` { plan, rootArgs }; `rejected` { plan, rootArgs }
function planFinishBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'ready') return [{ command: 'plan-finish', args: withRoots([context.plan, '--if-snapshot', context.snapshot], rootArgs) }];
  if (phase === 'done') return [{ command: 'state-render', args: withRoots([], rootArgs) }];
  if (phase === 'blocked') return [{ command: 'test-details', args: withRoots([context.plan], rootArgs) }];
  if (phase === 'rejected') return [{ command: 'plan-finish', args: withRoots([context.plan, '--dry-run'], rootArgs) }];
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

export const PLAN_FINISH_NEXT_COMMAND_BUILDERS = Object.freeze({ 'plan-finish': planFinishBuilder });
