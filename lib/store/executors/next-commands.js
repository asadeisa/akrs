// The legal next-command builders of executor-set and executor-remove. Pure functions: every command is a manifest
// command ID with arguments that run as they are, never a placeholder.
const list = (rootArgs) => [{ command: 'executor-list', args: [...(rootArgs ?? [])] }];

// phase `written` | `rejected`: { rootArgs }
function executorBuilder({ phase, ...context }) {
  if (phase === 'written' || phase === 'rejected') return list(context.rootArgs);
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

export const EXECUTOR_NEXT_COMMAND_BUILDERS = Object.freeze({ 'executor-set': executorBuilder, 'executor-remove': executorBuilder });
