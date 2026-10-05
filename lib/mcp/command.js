// Handler of `akrs mcp --json|--prompt` (P2-W15): describes the server `akrs mcp` would run (protocol versions and the projected tools)
// without serving. Plain `akrs mcp` is routed by the CLI entry point to runMcpCommand, which serves over stdio.
import { resolve } from 'node:path';
import { createPacket } from '../core/packet.js';
import { normalizeAbsolutePath } from '../core/roots.js';
import { MCP_PROTOCOL, MCP_SERVER_NAME } from './policy.js';
import { projectTools } from './project.js';

const EMPTY_SNAPSHOT = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export function createMcpPacket({ context, input, manifest, providers }) {
  const { tools } = projectTools(manifest);
  const root = input.flags['--root'] === undefined ? context.repository_root : resolve(context.cwd, input.flags['--root']);
  return createPacket({
    command: 'mcp',
    status: 'ok',
    root: normalizeAbsolutePath(root),
    snapshot: { before: EMPTY_SNAPSHOT, after: EMPTY_SNAPSHOT },
    data: {
      kind: 'mcp_server',
      server: MCP_SERVER_NAME,
      transport: 'stdio',
      modern_versions: [...MCP_PROTOCOL.modern_versions],
      legacy_versions: [...MCP_PROTOCOL.legacy_versions],
      tools: tools.map(({ name, description, inputSchema }) => ({ name, description, actions: [...inputSchema.properties.action.enum] })),
    },
    providers,
    knownCommands: manifest.commands.map(({ id }) => id),
  });
}
