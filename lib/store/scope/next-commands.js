// The legal next-command builders of road-update, road-move and the scope commands (the manifest's
// `next_command_builder`). Pure functions: every command they return is a manifest command ID with arguments that run
// as they are, never with a placeholder. `rootArgs` carry the root overrides of the invocation.
const withRoots = (args, rootArgs) => [...args, ...rootArgs];
const validate = (rootArgs) => [{ command: 'validate', args: withRoots([], rootArgs ?? []) }];

// phase `updated`: { rootArgs }; phase `rejected`: { id, file, patch, rootArgs }
// A full replacement needs the snapshot of the moment it was read, which no builder can know, so only a patch retry
// is offered as a runnable command; the form that fills a full replacement is the road template.
function roadUpdateBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'updated') return validate(rootArgs);
  if (phase === 'rejected') {
    if (context.patch === true && typeof context.file === 'string') {
      return [{ command: 'road-update', args: withRoots([context.id, '--input', context.file, '--patch'], rootArgs) }];
    }
    return [{ command: 'template', args: ['road'] }];
  }
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

// phase `planned`: { id, plan, rootArgs } offers the apply; phase `applied`: { rootArgs }; phase `rejected`: { rootArgs }
function roadMoveBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'planned') return [{ command: 'road-move', args: withRoots([context.id, '--plan', context.plan, '--apply'], rootArgs) }];
  if (phase === 'applied' || phase === 'rejected') return validate(rootArgs);
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

// phase `requested`: { road, rootArgs } (pending: wait for the Leader); `granted`: { rootArgs }; `rejected`: { file, rootArgs }
function scopeRequestBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'requested') return [{ command: 'scope-list', args: withRoots([context.road], rootArgs) }];
  if (phase === 'granted') return validate(rootArgs);
  if (phase === 'rejected') {
    return [
      ...(typeof context.file === 'string' ? [{ command: 'scope-request', args: withRoots(['--input', context.file], rootArgs) }] : []),
      { command: 'template', args: ['scope'] },
    ];
  }
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

// phase `resolved`: { rootArgs }; phase `rejected`: { rootArgs } (the list shows the pending requests)
function scopeResolutionBuilder({ phase, ...context }) {
  const rootArgs = context.rootArgs ?? [];
  if (phase === 'resolved') return validate(rootArgs);
  if (phase === 'rejected') return [{ command: 'scope-list', args: withRoots([], rootArgs) }];
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

export const SCOPE_NEXT_COMMAND_BUILDERS = Object.freeze({
  'road-update': roadUpdateBuilder,
  'road-move': roadMoveBuilder,
  'scope-request': scopeRequestBuilder,
  'scope-approve': scopeResolutionBuilder,
  'scope-reject': scopeResolutionBuilder,
  'scope-list': () => [],
});
