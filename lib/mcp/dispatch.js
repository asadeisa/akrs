// One tool call = one command run through the SAME core handler the CLI uses, with the same input shape the CLI adapter builds for
// `akrs <twin argv>` (which ends in --json). The packet becomes structuredContent, its prompt rendering the text block, and the CLI exit
// code decides isError. No subprocess, no terminal parsing, no domain rule.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CliUsageError, WorkflowNotFoundError } from '../core/errors.js';
import { createPacket } from '../core/packet.js';
import { normalizeAbsolutePath } from '../core/roots.js';
import { renderPrompt } from '../renderers/prompt.js';
import { commandText } from '../renderers/command-text.js';
import { validatePacket } from '../schemas/packet.js';
import { ContractValidationError } from '../schemas/validation.js';
import { createPathService } from '../store/path-service.js';
import { discoverRoots } from '../store/roots.js';
import { resolveArguments } from './arguments.js';
import { MCP_RESULT_POLICY } from './policy.js';

const EMPTY_SNAPSHOT = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ROOT_FLAG_ORDER = ['--root', '--workflow-root'];

const knownCommandsOf = (manifest) => manifest.commands.map(({ id }) => id);

// The same diagnostic packet and exit-code rules as the CLI adapter, so a failure is the CLI's failure.
function diagnosticPacket({ argv, code, command, cwd, kind, message, providers, manifest }) {
  return createPacket({
    command: command?.id ?? manifest.commands.find(({ id }) => id === 'help')?.id ?? manifest.commands[0].id,
    status: 'error',
    root: normalizeAbsolutePath(cwd),
    snapshot: { before: EMPTY_SNAPSHOT, after: EMPTY_SNAPSHOT },
    data: { kind, argv: [...argv] },
    findings: [{ code, severity: 'error', message, file: null, line: null, detail: { reason: message } }],
    providers,
    knownCommands: knownCommandsOf(manifest),
  });
}

const alwaysSucceeds = (command) => command?.exit_codes.length === 1 && command.exit_codes[0] === 0;

function packetExitCode(packet, command) {
  if (alwaysSucceeds(command)) return 0;
  if (packet.data.kind === 'usage' && command.exit_codes.includes(2)) return 2;
  if (packet.findings.length > 0) return 1;
  if (packet.status === 'ok' || packet.status === 'noop') return 0;
  return 1;
}

function failure(error) {
  if (error instanceof CliUsageError) return { code: 'AKRS-C001', kind: 'usage', exitCode: 2 };
  if (error instanceof WorkflowNotFoundError) return { code: 'AKRS-C003', kind: 'workflow_missing', exitCode: 3 };
  return { code: 'AKRS-C004', kind: 'internal', exitCode: 4 };
}

// Above the cap the prompt rendering and the packet go to <workflow>/.cache/mcp/<run_id>.{md,json} (snapshot- and audit-excluded).
async function overflowText({ packet, text, cwd, rootFlags, commandTokens }) {
  const bytes = Buffer.byteLength(text);
  let written = null;
  try {
    const roots = discoverRoots({ cwd, repositoryRoot: rootFlags['--root'], workflowRoot: rootFlags['--workflow-root'] });
    const paths = await createPathService({ repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root });
    written = [];
    for (const [extension, content] of [['md', text], ['json', `${JSON.stringify(packet, null, 2)}\n`]]) {
      const target = await paths.resolveWorkflowPath(`${MCP_RESULT_POLICY.overflow_directory}/${packet.run_id}.${extension}`);
      await mkdir(dirname(target.filesystem_path), { recursive: true });
      await writeFile(target.filesystem_path, content);
      written.push(target.relative_path);
    }
  } catch {
    written = null;
  }
  const lines = [`# AKRS packet: ${packet.command}`, '', `- Status: \`${packet.status}\``, `- Findings: ${packet.findings.length}`];
  if (written === null) {
    lines.push(`- The result is ${bytes} bytes, above the ${MCP_RESULT_POLICY.text_cap_bytes}-byte text cap, and no workflow folder could hold it: the complete packet is in structuredContent.`);
  } else {
    lines.push(`- The result is ${bytes} bytes, above the ${MCP_RESULT_POLICY.text_cap_bytes}-byte text cap. Read \`${written[0]}\` (the full prompt rendering) or \`${written[1]}\` (the packet).`);
  }
  const short = `${lines.join('\n')}\n`;
  if (packet.next_commands.length === 0) return short;
  const withNext = `${short}\n## Next commands\n\n${packet.next_commands.map((command) => `- \`${commandText(command, commandTokens)}\``).join('\n')}\n`;
  return Buffer.byteLength(withNext) <= MCP_RESULT_POLICY.text_cap_bytes ? withNext : short;
}

// -> { result: { content, structuredContent, isError }, packet, exitCode, argv, command }
export async function callTool({ tool, args, projection, manifest, handlers, providers, cwd, rootFlags = {}, signal }) {
  const knownCommands = knownCommandsOf(manifest);
  const commandTokens = new Map(manifest.commands.map(({ id, tokens }) => [id, tokens]));
  const resolved = resolveArguments(projection, tool, args);
  let command = null;
  let argv;
  let packet;
  let exitCode;

  if (!resolved.ok) {
    // the packet names the action's command once the action is known (help before that), like a CLI usage error of that command
    argv = ['mcp', tool];
    const refused = manifest.commands.find(({ id }) => id === resolved.command) ?? null;
    packet = diagnosticPacket({ argv, code: MCP_RESULT_POLICY.usage_finding, command: refused, cwd, kind: 'usage', message: resolved.reason, providers, manifest });
    exitCode = 2;
  } else {
    command = manifest.commands.find(({ id }) => id === resolved.command);
    const declared = new Set(command.flags.map(({ name }) => name));
    const roots = Object.fromEntries(ROOT_FLAG_ORDER.filter((name) => rootFlags[name] !== undefined && declared.has(name)).map((name) => [name, rootFlags[name]]));
    argv = [...resolved.argv, ...Object.entries(roots).flat(), '--json'];
    const input = { flags: { ...resolved.input.flags, ...roots, '--json': true }, positionals: resolved.input.positionals, format: 'json', stdin: false };
    try {
      const context = { cwd: normalizeAbsolutePath(cwd), repository_root: normalizeAbsolutePath(cwd) };
      const handler = handlers[command.id];
      if (typeof handler !== 'function') throw new TypeError(`no handler registered for command: ${command.id}`);
      const outcome = await handler({
        command, context, input, manifest, providers, readStdin: async () => Buffer.alloc(0), stream: null, deps: { signal },
      });
      packet = outcome?.packet ?? outcome;
      const validation = validatePacket(packet, { knownCommands });
      if (!validation.ok) throw new ContractValidationError('packet', validation.issues);
      exitCode = packetExitCode(packet, command);
    } catch (error) {
      const mapped = failure(error);
      exitCode = alwaysSucceeds(command) ? 0 : mapped.exitCode;
      packet = diagnosticPacket({
        argv, code: mapped.code, command, cwd, kind: mapped.kind, message: error instanceof Error ? error.message : 'internal error', providers, manifest,
      });
    }
  }

  let text;
  try {
    text = renderPrompt(packet, { knownCommands, commandTokens });
  } catch (error) {
    exitCode = alwaysSucceeds(command) ? 0 : 4;
    packet = diagnosticPacket({ argv, code: 'AKRS-C004', command, cwd, kind: 'internal', message: error instanceof Error ? error.message : 'internal error', providers, manifest });
    text = renderPrompt(packet, { knownCommands, commandTokens });
  }
  if (Buffer.byteLength(text) > MCP_RESULT_POLICY.text_cap_bytes) text = await overflowText({ packet, text, cwd, rootFlags, commandTokens });
  return {
    result: { content: [{ type: 'text', text }], structuredContent: packet, isError: MCP_RESULT_POLICY.is_error_exit_codes.includes(exitCode) },
    packet,
    exitCode,
    argv,
    command: command?.id ?? null,
  };
}
