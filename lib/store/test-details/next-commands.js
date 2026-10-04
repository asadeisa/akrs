// The legal next-command builder of `test-details`. Pure: every command is a manifest command ID with arguments that run
// as they are. `test run` and `test result` are not manifest commands yet (P2-W14 / P2-W07), so they are never offered.
const withRoots = (args, rootArgs) => [...args, ...(rootArgs ?? [])];

// phase `ready`: { rootArgs }; `blocked`: { rootArgs }; `no_contract`: { rootArgs }
function testDetailsBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'ready') return [];
  if (phase === 'blocked') return [{ command: 'validate', args: withRoots([], rootArgs) }];
  if (phase === 'no_contract') return [{ command: 'template', args: ['verification'] }];
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

export const TEST_DETAILS_NEXT_COMMAND_BUILDERS = Object.freeze({ 'test-details': testDetailsBuilder });
