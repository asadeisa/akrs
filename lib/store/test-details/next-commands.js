// The legal next-command builder of `test-details`. Pure: every command is a manifest command ID with arguments that run
// as they are. `test run` is offered when the contract has a scenario to run; `test result` is not a manifest command until
// P2-W07, so it is never offered.
const withRoots = (args, rootArgs) => [...args, ...(rootArgs ?? [])];

// phase `ready`: { plan, runnable, rootArgs }; `blocked`: { rootArgs }; `no_contract`: { rootArgs }
function testDetailsBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'ready') return context.runnable === true ? [{ command: 'test-run', args: withRoots([context.plan], rootArgs) }] : [];
  if (phase === 'blocked') return [{ command: 'validate', args: withRoots([], rootArgs) }];
  if (phase === 'no_contract') return [{ command: 'template', args: ['verification'] }];
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

export const TEST_DETAILS_NEXT_COMMAND_BUILDERS = Object.freeze({ 'test-details': testDetailsBuilder });
