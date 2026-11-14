// The legal next-command builders of the Plan record writers. Pure functions: every command is a manifest command ID with arguments
// that run as they are, never a placeholder.
import { PLAN_WRITE_COMMANDS } from './policy.js';

// phase `written` | `rejected`: { plan?, rootArgs }
function planBuilder({ phase, plan = null, rootArgs = [] }) {
  if (phase !== 'written' && phase !== 'rejected') throw new TypeError(`unknown next-command phase: ${String(phase)}`);
  return [{ command: 'status', args: [...rootArgs] }, ...(plan === null ? [] : [{ command: 'plan-finish', args: [plan, '--dry-run', ...rootArgs] }])];
}

export const PLAN_NEXT_COMMAND_BUILDERS = Object.freeze(Object.fromEntries(PLAN_WRITE_COMMANDS.map((id) => [id, planBuilder])));
