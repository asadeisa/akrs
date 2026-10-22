// The legal next-command builders of the desktop-readiness commands. Pure: every command is a manifest command ID with arguments that run
// as they are.
const rootsOf = (context) => context.rootArgs ?? [];

// projects-add: phase `added` | `not_akrs` { repository } | `none`
function addBuilder({ phase, ...context }) {
  if (phase === 'none') return [];
  if (phase === 'added') return [{ command: 'status', args: ['--all-projects'] }];
  if (phase === 'not_akrs') return [{ command: 'init-scaffold', args: ['--root', context.repository] }];
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

// projects-remove: phase `removed` | `none`
function removeBuilder({ phase }) {
  if (phase === 'none') return [];
  if (phase === 'removed') return [{ command: 'projects-list', args: [] }];
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

// projects-list: phase `listed` { count } | `none`
function listBuilder({ phase, ...context }) {
  if (phase === 'none') return [];
  if (phase === 'listed') return context.count > 0 ? [{ command: 'status', args: ['--all-projects'] }] : [];
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

// view: phase `written` { rootArgs } | `none`
function viewBuilder({ phase, ...context }) {
  if (phase === 'none') return [];
  if (phase === 'written') return [{ command: 'status', args: [...rootsOf(context)] }];
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

// watch: phase `ended` { cursor, rootArgs } | `none`
function watchBuilder({ phase, ...context }) {
  if (phase === 'none') return [];
  if (phase === 'ended') {
    return [{ command: 'watch', args: ['--jsonl', ...(context.cursor === null ? [] : ['--since', context.cursor]), ...rootsOf(context)] }];
  }
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

export const DESKTOP_NEXT_COMMAND_BUILDERS = Object.freeze({
  'projects-add': addBuilder,
  'projects-remove': removeBuilder,
  'projects-list': listBuilder,
  view: viewBuilder,
  watch: watchBuilder,
});
