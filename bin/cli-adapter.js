import { CliUsageError, WorkflowNotFoundError } from '../lib/core/errors.js';
import { createCompleteEvent, createPacket } from '../lib/core/packet.js';
import { createDefaultProviders } from '../lib/core/providers.js';
import { normalizeAbsolutePath } from '../lib/core/roots.js';
import { createEventStream } from '../lib/core/event-stream.js';
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
  // `--json -`: a lone dash directly after --json selects stdin as the input channel, for commands that declare
  // an --input channel; --json keeps meaning JSON output.
  const acceptsStdin = definitions.has('--input');
  let stdin = false;

  for (let index = 0; index < remainder.length; index += 1) {
    const token = remainder[index];
    if (token === '-' && acceptsStdin && remainder[index - 1] === '--json' && !stdin) {
      stdin = true;
      continue;
    }
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

  return { flags, positionals, format, stdin };
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

function alwaysSucceeds(command) {
  return command?.exit_codes.length === 1 && command.exit_codes[0] === 0;
}

function packetExitCode(packet, command) {
  if (alwaysSucceeds(command)) return 0;
  // a usage or schema error found by the command itself (a rejected input document, a reused request ID)
  if (packet.data.kind === 'usage' && command.exit_codes.includes(2)) return 2;
  if (packet.findings.length > 0) return 1;
  if (packet.status === 'ok' || packet.status === 'noop') return 0;
  return 1;
}

function renderResult({ packet, events, stream = null, format, exitCode, providers, manifest }) {
  const options = { knownCommands: knownCommands(manifest) };
  const textOptions = { ...options, commandTokens: new Map(manifest.commands.map(({ id, tokens }) => [id, tokens])) };
  if (format === 'json') {
    return { stdout: renderJson(packet, options), stderr: '' };
  }
  if (format === 'jsonl' && stream?.active) {
    // the events were produced while the command ran; the packet closes the stream with the one complete event
    if (!stream.completed) stream.complete(packet);
    return { stdout: stream.flush(), stderr: '' };
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
    return { stdout: renderPrompt(packet, textOptions), stderr: '' };
  }
  const output = renderHuman(packet, textOptions);
  return exitCode === 0 && (packet.status === 'ok' || packet.status === 'noop')
    ? { stdout: output, stderr: '' }
    : { stdout: '', stderr: output };
}

const defaultResolveContext = async ({ cwd }) => ({
  repository_root: normalizeAbsolutePath(cwd),
});

// Stdin as bytes, read only when a handler asks for it (the adapter never reads it on its own).
async function defaultReadStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function runCliAdapter({
  argv,
  cwd,
  manifest,
  handlers,
  providers = createDefaultProviders(),
  resolveContext = defaultResolveContext,
  readStdin = defaultReadStdin,
  write = null,
}) {
  const manifestResult = validateCommandManifest(manifest);
  if (!manifestResult.ok) throw new ContractValidationError('command manifest', manifestResult.issues);
  const command = selectCommand(argv, manifest);
  let format = inferFormat(argv);
  let packet;
  let events;
  let exitCode;
  let stream = null;

  try {
    if (!command) throw new CliUsageError(`unknown command: ${argv[0] ?? ''}`);
    const input = parseCommandInput(argv, command);
    format = input.format;
    // a streaming command gets an event stream that writes through `write` the moment an event exists
    if (format === 'jsonl') stream = createEventStream({ providers, knownCommands: knownCommands(manifest), write });
    const context = {
      cwd: normalizeAbsolutePath(cwd),
      ...await resolveContext({ command, cwd, input }),
    };
    const handler = handlers[command.id];
    if (typeof handler !== 'function') {
      throw new TypeError(`no handler registered for command: ${command.id}`);
    }
    const result = await handler({ command, context, input, manifest, providers, readStdin, stream });
    packet = result?.packet ?? result;
    events = result?.packet ? result.events : undefined;
    const validation = validatePacket(packet, { knownCommands: knownCommands(manifest) });
    if (!validation.ok) throw new ContractValidationError('packet', validation.issues);
    exitCode = packetExitCode(packet, command);
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
    if (alwaysSucceeds(command)) exitCode = 0;
    packet = diagnosticPacket({
      argv,
      code,
      command,
      cwd,
      kind,
      message: error instanceof Error ? error.message : 'internal error',
      providers: stream?.active ? stream.finalProviders() : providers,
      manifest,
    });
    events = undefined;
  }

  try {
    const rendered = renderResult({ packet, events, stream, format, exitCode, providers, manifest });
    return { exitCode, packet, ...rendered };
  } catch (error) {
    packet = diagnosticPacket({
      argv,
      code: 'AKRS-C004',
      command,
      cwd,
      kind: 'internal',
      message: error instanceof Error ? error.message : 'internal error',
      providers: stream?.active ? stream.finalProviders() : providers,
      manifest,
    });
    exitCode = alwaysSucceeds(command) ? 0 : 4;
    const rendered = renderResult({
      packet,
      events: undefined,
      stream,
      format,
      exitCode,
      providers,
      manifest,
    });
    return { exitCode, packet, ...rendered };
  }
}
