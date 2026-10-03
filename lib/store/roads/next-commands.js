// The legal next-command builders of road-new, task-new and template (the manifest's `next_command_builder`). Pure
// functions: every command they return is a manifest command ID with arguments that run as they are, never with a
// placeholder. `rootArgs` are the root overrides of the invocation, carried so the next command runs against the same
// workflow. A non-ok packet always gets at least the command that shows the form (AX4).
const withRoots = (args, rootArgs) => [...args, ...rootArgs];

// phase `created`: { task: string|null, rootArgs }; phase `rejected`: { command, template, file: string|null, rootArgs }
function writerBuilder(command) {
  return ({ phase, ...context }) => {
    const rootArgs = context.rootArgs ?? [];
    if (phase === 'created') {
      if (command === 'road-new' && typeof context.task === 'string') {
        return [{ command: 'template', args: withRoots(['task', '--to-draft', context.task], rootArgs) }];
      }
      return [{ command: 'validate', args: withRoots([], rootArgs) }];
    }
    if (phase === 'rejected') {
      return [
        ...(context.file === null ? [] : [{ command, args: withRoots(['--input', context.file], rootArgs) }]),
        { command: 'template', args: [context.template] },
      ];
    }
    throw new TypeError(`unknown next-command phase: ${String(phase)}`);
  };
}

// phase `unknown_kind`: the choices; phase `drafted`: { kind, file, rootArgs }
function templateBuilder({ phase, ...context }) {
  if (phase === 'unknown_kind') return [{ command: 'template', args: ['road'] }];
  if (phase === 'drafted') {
    const writer = { road: 'road-new', task: 'task-new', memory: 'memory-add' }[context.kind];
    return writer === undefined ? [] : [{ command: writer, args: withRoots(['--input', context.file], context.rootArgs ?? []) }];
  }
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

export const AUTHORING_NEXT_COMMAND_BUILDERS = Object.freeze({
  'road-new': writerBuilder('road-new'),
  'task-new': writerBuilder('task-new'),
  template: templateBuilder,
});
