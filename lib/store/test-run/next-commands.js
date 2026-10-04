// The legal next-command builder of `test run`. Pure: every command is a manifest command ID with arguments that run as they
// are. `test result` is not a manifest command until P2-W07, so it is never offered.
const withRoots = (args, rootArgs) => [...args, ...(rootArgs ?? [])];

// phase `ran`: { plan, rootArgs }; `retry`: { plan, rootArgs, executor? }; `inspect`: { plan, rootArgs }; `choices`: { plan, choices, rootArgs }; `none`: {}
function testRunBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'none') return [];
  if (phase === 'ran' || phase === 'inspect') return [{ command: 'test-details', args: withRoots([context.plan], rootArgs) }];
  if (phase === 'retry') return [{ command: 'test-run', args: withRoots([context.plan, ...(context.executor === undefined || context.executor === null ? [] : ['--executor', context.executor])], rootArgs) }];
  if (phase === 'choices') return context.choices.map((id) => ({ command: 'test-run', args: withRoots([context.plan, '--executor', id], rootArgs) }));
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

export const TEST_RUN_NEXT_COMMAND_BUILDERS = Object.freeze({ 'test-run': testRunBuilder });
