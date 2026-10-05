// F19 manifest -> tool projection. One tool per distinct `mcp_tool`, one `action` value per `mcp_action`, both in manifest order; every
// positional and flag of an action becomes one flat argument under the MCP_PROJECTION rules. Nothing here is a hand-written tool list,
// and a manifest the flat lint would reject is refused, never trimmed.
import { MCP_PROJECTION, MCP_SCHEMA_RULES } from './policy.js';
import { lintToolList } from './schema.js';

export class McpProjectionError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'McpProjectionError';
    this.issues = issues;
  }
}

const snake = (name) => name.replace(/^--/, '').replaceAll('-', '_');

function flagBinding(flag) {
  if (MCP_PROJECTION.excluded_flags.includes(flag.name)) return null;
  const type = MCP_PROJECTION.value_types[flag.value_type];
  if (type === undefined) throw new McpProjectionError(`${flag.name}: value type ${flag.value_type} has no flat MCP form`);
  if (flag.repeatable && type !== 'string') throw new McpProjectionError(`${flag.name}: only string flags may repeat (string[])`);
  return {
    names: [MCP_PROJECTION.renamed_flags[flag.name] ?? snake(flag.name)],
    source: { kind: 'flag', name: flag.name },
    type: flag.repeatable ? 'array' : type,
    path: flag.value_type === 'path' || flag.name === '--input',
    required: flag.required,
  };
}

function positionalBinding(tool, positional) {
  return {
    names: [...(MCP_PROJECTION.positional_aliases[tool]?.[positional.name] ?? [positional.name])],
    source: { kind: 'positional', name: positional.name },
    type: positional.variadic ? 'array' : 'string',
    path: false,
    required: positional.required,
  };
}

function actionRoute(tool, command) {
  const bindings = [
    ...command.positionals.map((positional) => positionalBinding(tool, positional)),
    ...command.flags.map(flagBinding).filter((binding) => binding !== null),
  ];
  const seen = new Set([MCP_PROJECTION.action_argument]);
  for (const binding of bindings) {
    for (const name of binding.names) {
      if (seen.has(name)) throw new McpProjectionError(`${tool} ${command.mcp_action}: two arguments project to the name ${name}`);
      seen.add(name);
    }
  }
  return { command: command.id, tokens: [...command.tokens], bindings };
}

const sourceLabel = (source) => (source.kind === 'flag' ? source.name : `<${source.name}>`);

export function projectTools(manifest) {
  const order = [];
  const routes = {};
  for (const command of manifest.commands) {
    if (command.mcp_tool === null) continue;
    if (!Object.hasOwn(routes, command.mcp_tool)) {
      order.push(command.mcp_tool);
      routes[command.mcp_tool] = {};
    }
    routes[command.mcp_tool][command.mcp_action] = actionRoute(command.mcp_tool, command);
  }
  if (order.length > MCP_SCHEMA_RULES.max_tools) {
    throw new McpProjectionError(`the manifest names ${order.length} MCP tools; at most ${MCP_SCHEMA_RULES.max_tools} are allowed`);
  }

  const tools = order.map((tool) => {
    const actions = Object.keys(routes[tool]);
    const arguments_ = new Map();
    for (const [action, route] of Object.entries(routes[tool])) {
      for (const binding of route.bindings) {
        for (const name of binding.names) {
          const known = arguments_.get(name);
          if (known === undefined) {
            arguments_.set(name, { type: binding.type, sources: [sourceLabel(binding.source)], actions: [action], requiredBy: [] });
          } else if (known.type !== binding.type) {
            throw new McpProjectionError(`${tool}.${name}: the actions disagree on its type (${known.type}, ${binding.type})`);
          } else {
            if (!known.sources.includes(sourceLabel(binding.source))) known.sources.push(sourceLabel(binding.source));
            known.actions.push(action);
          }
          if (binding.required && binding.names.length === 1) arguments_.get(name).requiredBy.push(action);
        }
      }
    }
    const properties = {
      [MCP_PROJECTION.action_argument]: { type: 'string', enum: actions, description: 'The action to run.' },
    };
    const required = [MCP_PROJECTION.action_argument];
    for (const [name, argument] of arguments_) {
      properties[name] = {
        type: argument.type,
        ...(argument.type === 'array' ? { items: { type: 'string' } } : {}),
        description: `CLI ${argument.sources.join(' / ')} (${argument.actions.join(', ')})`,
      };
      if (argument.requiredBy.length === actions.length) required.push(name);
    }
    return {
      name: tool,
      description: MCP_PROJECTION.tool_purposes[tool] ?? `AKRS ${tool.replace(/^akrs_/, '')} tool.`,
      inputSchema: { type: 'object', properties, required, additionalProperties: false },
    };
  });

  const issues = lintToolList(tools);
  if (issues.length > 0) throw new McpProjectionError(`the projected tool list fails the flat lint: ${issues.map(({ path, code }) => `${path} ${code}`).join('; ')}`, issues);
  return { tools, routes };
}
