// stdio transport (F19 framing): UTF-8, one JSON-RPC message per line, a leading BOM and a trailing CR tolerated; stdout carries protocol
// frames only (console.log/info/debug are moved to stderr while serving); stdin end is the shutdown signal. Never calls process.exit():
// the caller sets process.exitCode and Node drains stdout before it ends.
import { format } from 'node:util';
import { MCP_ERRORS, MCP_FRAMING } from './policy.js';
import { createMcpServer } from './server.js';

const CONSOLE_METHODS = ['log', 'info', 'debug'];

export async function serveStdio({ stdin, stdout, stderr, ...options }) {
  const logLine = (text) => { stderr.write(`${text}\n`); };
  let lastWrite = Promise.resolve();
  let outputOpen = true;
  stdout.on?.('error', () => { outputOpen = false; });
  const send = (message) => {
    if (!outputOpen) return;
    const frame = `${JSON.stringify(message)}\n`;
    lastWrite = new Promise((resolve) => { stdout.write(frame, () => resolve()); });
  };

  const saved = Object.fromEntries(CONSOLE_METHODS.map((name) => [name, console[name]]));
  for (const name of CONSOLE_METHODS) console[name] = (...values) => { stderr.write(`${format(...values)}\n`); };

  const server = createMcpServer({ ...options, send, log: logLine });
  const handled = [];
  let chunks = [];
  let size = 0;
  let first = true;
  let skipping = false;

  const dispatch = (bytes) => {
    let line = bytes.toString('utf8');
    if (first && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    first = false;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    handled.push(server.receive(line));
  };

  try {
    await new Promise((resolve) => {
      stdin.on('data', (chunk) => {
        let rest = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let index = rest.indexOf(0x0a);
        while (index !== -1) {
          if (!skipping) dispatch(Buffer.concat([...chunks, rest.subarray(0, index)]));
          skipping = false;
          chunks = [];
          size = 0;
          rest = rest.subarray(index + 1);
          index = rest.indexOf(0x0a);
        }
        if (rest.length === 0 || skipping) return;
        chunks.push(rest);
        size += rest.length;
        if (size > MCP_FRAMING.max_line_bytes) {
          send({ jsonrpc: '2.0', id: null, error: { code: MCP_ERRORS.invalid_request, message: `Invalid Request: a message is longer than ${MCP_FRAMING.max_line_bytes} bytes` } });
          chunks = [];
          size = 0;
          skipping = true;
        }
      });
      stdin.on('end', resolve);
      stdin.on('close', resolve);
      stdin.on('error', resolve);
      stdin.resume?.();
    });
    // a last message without its newline still counts
    if (!skipping && size > 0) dispatch(Buffer.concat(chunks));
    await server.close();
    await Promise.allSettled(handled);
    await lastWrite;
  } finally {
    for (const name of CONSOLE_METHODS) console[name] = saved[name];
  }
}

// `akrs mcp [--root <path>] [--workflow-root <path>]`: the only arguments are the root overrides of the manifest entry, applied to every
// call. A bad argument goes to stderr with exit 2 and nothing on stdout. Returns the exit code.
export async function runMcpCommand({ argv, cwd, stdin, stdout, stderr, manifest, handlers, providers }) {
  const entry = manifest.commands.find(({ id }) => id === 'mcp');
  const allowed = new Set(entry.flags.filter(({ value_type: type }) => type === 'path').map(({ name }) => name));
  const rootFlags = {};
  const rest = argv.slice(entry.tokens.length);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    const value = rest[index + 1];
    if (!allowed.has(token)) {
      stderr.write(`akrs mcp: unknown argument ${token} (akrs mcp [--root <path>] [--workflow-root <path>]; --json describes the server)\n`);
      return 2;
    }
    if (Object.hasOwn(rootFlags, token) || value === undefined || value.startsWith('-')) {
      stderr.write(`akrs mcp: ${token} takes one path\n`);
      return 2;
    }
    rootFlags[token] = value;
    index += 1;
  }
  stderr.write(`akrs mcp: serving ${cwd} over stdio (MCP, dual-era); logs go to stderr\n`);
  await serveStdio({ stdin, stdout, stderr, manifest, handlers, providers, cwd, rootFlags });
  stderr.write('akrs mcp: stdin closed, stopping\n');
  return 0;
}
