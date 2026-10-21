// The legal next-command builders of agents setup, doctor and list. Pure: every command is a manifest command ID with arguments that run as
// they are. `agents` is the list of agent IDs to name (empty = no --agent flag, meaning all).
const agentArgs = (agents) => agents.flatMap((id) => ['--agent', id]);

// agents-setup: phase `verify` { agents, piMcp, rootArgs } | `none`
function setupBuilder({ phase, ...context }) {
  if (phase === 'none') return [];
  if (phase === 'verify') {
    return [{ command: 'agents-doctor', args: [...agentArgs(context.agents ?? []), ...(context.piMcp ? ['--pi-mcp'] : []), ...(context.rootArgs ?? [])] }];
  }
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

// agents-doctor: phase `repair` { agents, piMcp, rootArgs } | `none`
function doctorBuilder({ phase, ...context }) {
  if (phase === 'none') return [];
  if (phase === 'repair') {
    return [{ command: 'agents-setup', args: [...agentArgs(context.agents ?? []), ...(context.piMcp ? ['--pi-mcp'] : []), ...(context.rootArgs ?? [])] }];
  }
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

// agents-list: phase `default` { rootArgs }
function listBuilder({ phase, ...context }) {
  if (phase === 'default') return [{ command: 'agents-doctor', args: [...(context.rootArgs ?? [])] }];
  throw new TypeError(`unknown next-command phase: ${String(phase)}`);
}

export const AGENT_NEXT_COMMAND_BUILDERS = Object.freeze({ 'agents-setup': setupBuilder, 'agents-doctor': doctorBuilder, 'agents-list': listBuilder });
