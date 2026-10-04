// The legal next-command builder of `test result`. Pure: every command is a manifest command ID with arguments that run as
// they are. Nothing here closes a Plan.
const withRoots = (args, rootArgs) => [...args, ...(rootArgs ?? [])];

// phases: `recorded` | `rejected` { plan, rootArgs }; `needs_run` { plan, rootArgs }; `template` { plan, rootArgs };
// `duplicate` { plan, verdict?, because?, rootArgs }
function testResultBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  const plan = context.plan;
  const details = typeof plan === 'string' ? [{ command: 'test-details', args: withRoots([plan], rootArgs) }] : [{ command: 'validate', args: withRoots([], rootArgs) }];
  if (phase === 'recorded' || phase === 'rejected') return details;
  if (phase === 'needs_run') return typeof plan === 'string' ? [{ command: 'test-run', args: withRoots([plan], rootArgs) }] : details;
  if (phase === 'template') return [{ command: 'template', args: ['result'] }, ...details];
  if (phase === 'duplicate') {
    if (typeof plan === 'string' && typeof context.verdict === 'string' && typeof context.because === 'string') {
      return [{ command: 'test-result', args: withRoots([plan, '--verdict', context.verdict, '--because', context.because, '--again'], rootArgs) }];
    }
    return details;
  }
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

export const TEST_RESULT_NEXT_COMMAND_BUILDERS = Object.freeze({ 'test-result': testResultBuilder });
