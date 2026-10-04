// The legal next-command builder of `page`. Pure: a command is a manifest command ID with arguments that run as they are.
// Only a timeout has a command to offer (the same read with twice the time); every other non-ok packet names what is missing
// in its data (a browser to install or configure, a URL that must answer).
import { BROWSER_POLICY } from './policy.js';

// phase `timeout`: { args, timeoutMs, rootArgs }; `none`: {}
function pageBuilder({ phase, ...context }) {
  if (phase === 'none') return [];
  if (phase === 'timeout') {
    const doubled = Math.min(context.timeoutMs * 2, BROWSER_POLICY.timeouts.max_ms);
    if (doubled <= context.timeoutMs) return [];
    return [{ command: 'page', args: [...context.args, '--timeout-ms', String(doubled), ...(context.rootArgs ?? [])] }];
  }
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

export const PAGE_NEXT_COMMAND_BUILDERS = Object.freeze({ page: pageBuilder });
