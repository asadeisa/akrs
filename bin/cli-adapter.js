import { CliUsageError, WorkflowNotFoundError } from '../lib/core/errors.js';
import { createCompleteEvent, createPacket } from '../lib/core/packet.js';
import { createDefaultProviders } from '../lib/core/providers.js';
import { normalizeAbsolutePath } from '../lib/core/roots.js';
import { renderHuman } from '../lib/renderers/human.js';
import { renderJson } from '../lib/renderers/json.js';
import { renderJsonl } from '../lib/renderers/jsonl.js';
import { renderPrompt } from '../lib/renderers/prompt.js';
import { validateCommandManifest } from '../lib/schemas/command-manifest.js';
import { validatePacket } from '../lib/schemas/packet.js';
import { ContractValidationError } from '../lib/schemas/validation.js';

const EMPTY_SNAPSHOT = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const FORMAT_FLAGS = Object.freeze({
  '--json': 'json',
  '--jsonl': 'jsonl',
  '--prompt': 'prompt',
});

export { CliUsageError, WorkflowNotFoundError };

function knownCommands(manifest) {
  return manifest.commands.map(({ id }) => id);
}

function selectCommand(argv, manifest) {
  if (argv.length === 0) return manifest.commands.find(({ id }) => id === 'help') ?? null;
  return manifest.commands
    .filter(({ tokens }) => tokens.every((token, index) => argv[index] === token))
    .sort((left, right) => right.tokens.length - left.tokens.length)[0] ?? null;
}

function inferFormat(argv) {
  const formats = Object.entries(FORMAT_FLAGS)
    .filter(([flag]) => argv.includes(flag))
    .map(([, format]) => format);
  return formats.length === 1 ? formats[0] : 'human';
}

function parseValue(value, definition) {
  if (definition.value_type === 'integer') {
    if (!/^-?[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new CliUsageError(`${definition.name} requires an integer value`);
    }
    return Number(value);
  }
  if (definition.value_type === 'json') {
    try {
      return JSON.parse(value);
    } catch {
      throw new CliUsageError(`${definition.name} requires a JSON value`);
    }
  }
  return value;
}

function parseCommandInput(argv, command) {
  const remainder = argv.slice(command.tokens.length);
  const definitions = new Map(command.flags.map((flag) => [flag.name, flag]));
  const flags = {};
  const positionalValues = [];

  for (let index = 0; index < remainder.length; index += 1) {
    const token = remainder[index];
    if (!token.startsWith('-')) {
      positionalValues.push(token);
      continue;
    }

    const definition = definitions.get(token);
    if (!definition) throw new CliUsageError(`unknown flag: ${token}`);
    if (Object.hasOwn(flags, token) && !definition.repeatable) {
      throw new CliUsageError(`flag cannot be repeated: ${token}`);
    }

    let value = true;
    if (definition.value_type !== 'boolean') {
      const candidate = remainder[index + 1];
      if (candidate === undefined || candidate.startsWith('-')) {
        throw new CliUsageError(`missing value for ${token}`);
      }
      value = parseValue(candidate, definition);
      index += 1;
    }

    if (definition.repeatable) {
      if (!Object.hasOwn(flags, token)) flags[token] = [];
      flags[token].push(value);
    } else {
      flags[token] = value;
    }
  }

  for (const definition of command.flags) {
    if (definition.required && !Object.hasOwn(flags, definition.name)) {
      throw new CliUsageError(`missing required flag: ${definition.name}`);
    }
  }

  const positionals = {};
  let offset = 0;
  for (const definition of command.positionals) {
    if (definition.variadic) {
      const values = positionalValues.slice(offset);
      if (definition.required && values.length === 0) {
        throw new CliUsageError(`missing positional argument: ${definition.name}`);
      }
      positionals[definition.name] = values;
      offset = positionalValues.length;
    } else {
      const value = positionalValues[offset];
      if (value === undefined && definition.required) {
        throw new CliUsageError(`missing positional argument: ${definition.name}`);
      }
      if (value !== undefined) {
        positionals[definition.name] = value;
        offset += 1;
      }
    }
  }
  if (offset < positionalValues.length) {
    throw new CliUsageError(`unexpected positional argument: ${positionalValues[offset]}`);
  }

  const selectedFormats = Object.keys(FORMAT_FLAGS).filter((flag) => flags[flag] === true);
  if (selectedFormats.length > 1) {
    throw new CliUsageError('output format flags are mutually exclusive');
  }
  const format = selectedFormats.length === 0 ? 'human' : FORMAT_FLAGS[selectedFormats[0]];
  if (format === 'jsonl' && command.streaming !== 'jsonl') {
    throw new CliUsageError(`${command.tokens.join(' ')} does not support --jsonl`);
  }

  return { flags, positionals, format };
}

function diagnosticPacket({
  argv,
  code,
  command,
  cwd,
  kind,
  message,
  providers,
  manifest,
}) {
  return createPacket({
    command: command?.id
      ?? manifest.commands.find(({ id }) => id === 'help')?.id
      ?? manifest.commands[0].id,
    status: 'error',
    root: normalizeAbsolutePath(cwd),
    snapshot: { before: EMPTY_SNAPSHOT, after: EMPTY_SNAPSHOT },
    data: { kind, argv: [...argv] },
    findings: [{
      code,
      severity: 'error',
      message,
      file: null,
      line: null,
      detail: { reason: message },
    }],
    providers,
    knownCommands: knownCommands(manifest),
  });
}

function packetExitCode(packet) {
  if (packet.findings.length > 0) return 1;
  if (packet.status === 'ok' || packet.status === 'noop') return 0;
  return 1;
}

function renderResult({ packet, events, format, exitCode, providers, manifest }) {
  const options = { knownCommands: knownCommands(manifest) };
  if (format === 'json') {
    return { stdout: renderJson(packet, options), stderr: '' };
  }
  if (format === 'jsonl') {
    const outputEvents = events ?? [createCompleteEvent({
      packet,
      sequence: 1,
      providers,
      knownCommands: options.knownCommands,
    })];
    return { stdout: renderJsonl(outputEvents, options), stderr: '' };
  }
  if (format === 'prompt') {
    return { stdout: renderPrompt(packet, options), stderr: '' };
  }
  const output = renderHuman(packet, options);
  return exitCode === 0
    ? { stdout: output, stderr: '' }
    : { stdout: '', stderr: output };
}

const defaultResolveContext = async ({ cwd }) => ({
  repository_root: normalizeAbsolutePath(cwd),
});

export async function runCliAdapter({
  argv,
  cwd,
  manifest,
  handlers,
  providers = createDefaultProviders(),
  resolveContext = defaultResolveContext,
}) {
  const manifestResult = validateCommandManifest(manifest);
  if (!manifestResult.ok) throw new ContractValidationError('command manifest', manifestResult.issues);
  const command = selectCommand(argv, manifest);
  let format = inferFormat(argv);
  let packet;
  let events;
  let exitCode;

  try {
    if (!command) throw new CliUsageError(`unknown command: ${argv[0] ?? ''}`);
    const input = parseCommandInput(argv, command);
    format = input.format;
    const context = {
      cwd: normalizeAbsolutePath(cwd),
      ...await resolveContext({ command, cwd, input }),
    };
    const handler = handlers[command.id];
    if (typeof handler !== 'function') {
      throw new TypeError(`no handler registered for command: ${command.id}`);
    }
    const result = await handler({ command, context, input, manifest, providers });
    packet = result?.packet ?? result;
    events = result?.packet ? result.events : undefined;
    const validation = validatePacket(packet, { knownCommands: knownCommands(manifest) });
    if (!validation.ok) throw new ContractValidationError('packet', validation.issues);
    exitCode = packetExitCode(packet);
  } catch (error) {
    let code = 'AKRS-C004';
    let kind = 'internal';
    exitCode = 4;
    if (error instanceof CliUsageError) {
      code = 'AKRS-C001';
      kind = 'usage';
      exitCode = 2;
    } else if (error instanceof WorkflowNotFoundError) {
      code = 'AKRS-C003';
      kind = 'workflow_missing';
      exitCode = 3;
    }
    packet = diagnosticPacket({
      argv,
      code,
      command,
      cwd,
      kind,
      message: error instanceof Error ? error.message : 'internal error',
      providers,
      manifest,
    });
    events = undefined;
  }

  try {
    const rendered = renderResult({ packet, events, format, exitCode, providers, manifest });
    return { exitCode, packet, ...rendered };
  } catch (error) {
    packet = diagnosticPacket({
      argv,
      code: 'AKRS-C004',
      command,
      cwd,
      kind: 'internal',
      message: error instanceof Error ? error.message : 'internal error',
      providers,
      manifest,
    });
    exitCode = 4;
    const rendered = renderResult({
      packet,
      events: undefined,
      format,
      exitCode,
      providers,
      manifest,
    });
    return { exitCode, packet, ...rendered };
  }
}
