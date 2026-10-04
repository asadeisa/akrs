// The legal next-command builders of test-define and test-handoff (the manifest's `next_command_builder`). Pure
// functions: every command is a manifest command ID with arguments that run as they are, never a placeholder.
const withRoots = (args, rootArgs) => [...args, ...rootArgs];
const validate = (rootArgs) => [{ command: 'validate', args: withRoots([], rootArgs ?? []) }];

// phase `defined`: { rootArgs }; phase `rejected`: { plan, file, rootArgs } (a replacement needs a snapshot, so only the
// form that fills it is offered)
function testDefineBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'defined') return validate(rootArgs);
  if (phase === 'rejected') return [{ command: 'template', args: ['verification'] }];
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

// phase `handed_off`: { rootArgs }; phase `rejected`: { plan, file, rootArgs }; phase `duplicate`: { plan, file|document, rootArgs }
function testHandoffBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  const file = typeof context.file === 'string' ? context.file : null;
  if (phase === 'handed_off') return validate(rootArgs);
  if (phase === 'rejected') {
    return [
      ...(file === null || typeof context.plan !== 'string' ? [] : [{ command: 'test-handoff', args: withRoots([context.plan, '--input', file], rootArgs) }]),
      { command: 'template', args: ['handoff'] },
    ];
  }
  if (phase === 'duplicate') {
    if (typeof context.plan !== 'string') return validate(rootArgs);
    if (file !== null) return [{ command: 'test-handoff', args: withRoots([context.plan, '--input', file, '--again'], rootArgs) }];
    const document = context.document;
    if (document === undefined || document === null) return validate(rootArgs);
    const flat = [context.plan, '--road', document.road, '--result', document.result, ...document.reach.flatMap((step) => ['--reach', step]), '--expect', document.expect, '--again'];
    return [{ command: 'test-handoff', args: withRoots(flat, rootArgs) }];
  }
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

export const VERIFICATION_NEXT_COMMAND_BUILDERS = Object.freeze({ 'test-define': testDefineBuilder, 'test-handoff': testHandoffBuilder });
