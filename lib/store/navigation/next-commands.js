// The legal next-command builders of the navigation queries. Pure: every command is a manifest command ID with arguments that run
// as they are.
const withRoots = (args, rootArgs) => [...args, ...(rootArgs ?? [])];

const defaultTo = (command) => ({ phase, ...context }) => {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'default') return [{ command, args: withRoots([], rootArgs) }];
  if (phase === 'none') return [];
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
};

// next: phase `actions` { actions: [{ command, args }] }; `none`
function nextBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'none') return [];
  if (phase === 'actions') return context.actions.map(({ command, args }) => ({ command, args: withRoots(args, rootArgs) }));
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

export const NAVIGATION_NEXT_COMMAND_BUILDERS = Object.freeze({
  status: defaultTo('next'),
  next: nextBuilder,
  where: defaultTo('status'),
  graph: defaultTo('status'),
  stale: defaultTo('status'),
  log: defaultTo('status'),
});
