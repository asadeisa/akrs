// F19 server-side argument handling: validate the flat arguments of one tool call against the chosen action's manifest flags and
// positionals, coerce what weak tool callers commonly send (MCP_COERCION), and build the command input plus its CLI twin argv.
import { MCP_PROJECTION } from './policy.js';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (reason, command = null) => ({ ok: false, reason, command });

function coerce(name, value, binding) {
  switch (binding.type) {
    case 'boolean':
      if (typeof value === 'boolean') return { value };
      if (value === 'true' || value === 'false') return { value: value === 'true' };
      return { error: `${name} must be a boolean (true or false)` };
    case 'integer': {
      const number = typeof value === 'string' && /^-?[0-9]+$/.test(value) ? Number(value) : value;
      if (typeof number === 'number' && Number.isSafeInteger(number)) return { value: number };
      return { error: `${name} must be an integer` };
    }
    case 'array': {
      let list = value;
      if (typeof value === 'string') {
        if (value.trimStart().startsWith('[')) {
          try {
            list = JSON.parse(value);
          } catch {
            return { error: `${name} must be an array of strings (the string given is not a JSON array)` };
          }
        } else {
          list = [value];
        }
      }
      if (!Array.isArray(list) || !list.every((item) => typeof item === 'string')) return { error: `${name} must be an array of strings` };
      return { value: list };
    }
    default:
      if (typeof value !== 'string') return { error: `${name} must be a string` };
      return { value: binding.path && value.startsWith('@') ? value.slice(1) : value };
  }
}

// -> { ok: true, command, tokens, input: { flags, positionals }, argv } | { ok: false, reason, command (null until the action is known) }
export function resolveArguments(projection, tool, args) {
  const actions = projection.routes[tool];
  if (args === undefined) args = {};
  if (!isPlainObject(args)) return fail(`${tool}: arguments must be an object with an action (one of: ${Object.keys(actions).join(', ')})`);
  const given = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null && value !== undefined));
  const action = given[MCP_PROJECTION.action_argument];
  if (typeof action !== 'string' || !Object.hasOwn(actions, action)) {
    return fail(`${tool}: action must be one of: ${Object.keys(actions).join(', ')}${action === undefined ? '' : ` (got ${JSON.stringify(action)})`}`);
  }
  const route = actions[action];
  const refuse = (reason) => fail(reason, route.command);
  const toolNames = new Set(Object.values(actions).flatMap(({ bindings }) => bindings.flatMap(({ names }) => names)));
  const actionNames = new Set(route.bindings.flatMap(({ names }) => names));
  for (const name of Object.keys(given)) {
    if (name === MCP_PROJECTION.action_argument) continue;
    if (!toolNames.has(name)) return refuse(`${tool}: unknown argument ${name}`);
    if (!actionNames.has(name)) return refuse(`${tool}: argument ${name} is not used by action ${action}`);
  }

  const flags = {};
  const positionals = {};
  const positionalArgv = [];
  const flagArgv = [];
  for (const binding of route.bindings) {
    const name = binding.names.find((candidate) => Object.hasOwn(given, candidate));
    if (name === undefined) {
      if (binding.required) return refuse(`${tool} ${action}: missing required argument ${binding.names.join(' or ')}`);
      continue;
    }
    const coerced = coerce(name, given[name], binding);
    if (Object.hasOwn(coerced, 'error')) return refuse(`${tool} ${action}: ${coerced.error}`);
    const { value } = coerced;
    // an empty list is no value at all (the CLI cannot say it either)
    if (Array.isArray(value) && value.length === 0) {
      if (binding.required) return refuse(`${tool} ${action}: ${name} needs at least one value`);
      continue;
    }
    if (binding.source.kind === 'positional') {
      positionals[binding.source.name] = value;
      positionalArgv.push(...(Array.isArray(value) ? value : [value]));
    } else if (binding.type === 'boolean') {
      // a CLI switch: true is the flag, false is its absence
      if (value) {
        flags[binding.source.name] = true;
        flagArgv.push(binding.source.name);
      }
    } else {
      flags[binding.source.name] = value;
      for (const item of Array.isArray(value) ? value : [value]) flagArgv.push(binding.source.name, String(item));
    }
  }
  return { ok: true, command: route.command, tokens: route.tokens, input: { flags, positionals }, argv: [...route.tokens, ...positionalArgv, ...flagArgv] };
}
