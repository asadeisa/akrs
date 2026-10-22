// The legal next-command builder of `test-details`. Pure: every command is a manifest command ID with arguments that run
// as they are. `test run` is offered when the contract has a scenario to run and no run for the current state exists yet; `test result`
// is never offered as a command because the verdict and its reason are the Tester's to author (no placeholder is a next command): the
// rendering names the exact form to run once a current run exists.
const withRoots = (args, rootArgs) => [...args, ...(rootArgs ?? [])];

// phase `ready`: { plan, runnable, hasCurrentRun?, rootArgs }; `blocked`: { rootArgs }; `no_contract`: { rootArgs }
function testDetailsBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'ready') return context.runnable === true && context.hasCurrentRun !== true ? [{ command: 'test-run', args: withRoots([context.plan], rootArgs) }] : [];
  if (phase === 'blocked') return [{ command: 'validate', args: withRoots([], rootArgs) }];
  if (phase === 'no_contract') return [{ command: 'template', args: ['verification'] }];
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

export const TEST_DETAILS_NEXT_COMMAND_BUILDERS = Object.freeze({ 'test-details': testDetailsBuilder });
