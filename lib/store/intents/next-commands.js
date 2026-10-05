// The legal next-command builders of the intent commands. Pure: every command is a manifest command ID with arguments that run as they are;
// where the agent must author text (done's baton) the packet names the missing flags in `data` instead of a placeholder here.
const withRoots = (args, rootArgs) => [...args, ...(rootArgs ?? [])];
const executorArgs = (executor) => (typeof executor === 'string' && executor !== '' ? ['--executor', executor] : []);
const workOf = ({ road = null, executor = null, takeover = false, rootArgs }) => ({
  command: 'work', args: withRoots([...(road === null ? [] : [road]), ...executorArgs(executor), ...(takeover ? ['--takeover'] : [])], rootArgs),
});

// phases: `claimed` { road, rootArgs }; `choices` { road?, choices, rootArgs }; `empty` { executor?, rootArgs }; `refused` { executor?, rootArgs }
function workBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'claimed') return [{ command: 'verify', args: withRoots(['--road', context.road], rootArgs) }];
  if (phase === 'choices') return (context.choices ?? []).map((executor) => workOf({ road: context.road ?? null, executor, rootArgs }));
  if (phase === 'empty' || phase === 'refused') return [{ command: 'next', args: withRoots(executorArgs(context.executor), rootArgs) }];
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

// phases: `done` { rootArgs }; `rejected` { road, executor?, rootArgs }; `stale` { road, executor?, rootArgs };
// `yield` { road, failures, executor?, rootArgs } (a rejection after the class's failure count: the exit is offered)
function doneBuilder({ phase, ...given }) {
  // road finish names the Road `id` (the transition builders' context); the intent's own callers say `road`
  const context = { ...given, road: given.road ?? given.id };
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'done') return [{ command: 'state-render', args: withRoots([], rootArgs) }];
  if (phase === 'rejected') return [{ command: 'verify', args: withRoots(['--road', context.road], rootArgs) }];
  if (phase === 'stale') return [workOf({ road: context.road, executor: context.executor, rootArgs })];
  if (phase === 'yield') {
    return [
      ...doneBuilder({ phase: 'rejected', road: context.road, rootArgs }),
      {
        command: 'yield',
        args: withRoots([context.road, ...executorArgs(context.executor), '--reason', `done was refused ${context.failures} times; Road ${context.road} is too big for its class`], rootArgs),
      },
    ];
  }
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

// phases: `done` { executor?, rootArgs }; `rejected` { road, executor?, rootArgs }
function yieldBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'done') return [workOf({ executor: context.executor, rootArgs })];
  if (phase === 'rejected') return [workOf({ road: context.road, executor: context.executor, rootArgs })];
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

// phase `ready` { next: [{ command, args }] }
function bootBuilder({ phase, ...context }) {
  if (phase === 'ready') return (context.next ?? []).map(({ command, args }) => ({ command, args: [...args] }));
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

export const INTENT_NEXT_COMMAND_BUILDERS = Object.freeze({
  work: workBuilder, done: doneBuilder, yield: yieldBuilder, boot: bootBuilder, guard: () => [],
});
