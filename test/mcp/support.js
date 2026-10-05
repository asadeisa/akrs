// Shared helpers of the P2-W15 MCP tests: an in-process server driven message by message, the CLI twin of a tool call (the same argv
// through the real adapter, the same deterministic providers), and a separate-process client for bin/akrs.js mcp.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCliAdapter } from '../../bin/cli-adapter.js';
import { commandManifest } from '../../lib/commands/manifest.js';
import { commandHandlers } from '../../lib/commands/meta.js';
import { createMcpServer } from '../../lib/mcp/server.js';
import { fakeProviders } from '../idempotency/support.js';
import { injectedEnvironment } from '../helpers/process.js';

export const CLI = fileURLToPath(new URL('../../bin/akrs.js', import.meta.url));
export const MODERN = '2026-07-28';
export const modernMeta = (version = MODERN) => ({ 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {} });

// An in-process server whose every outgoing message is kept in `sent`.
export function inProcess({ root, cwd = root, providers = fakeProviders(), handlers = commandHandlers, manifest = commandManifest } = {}) {
  const sent = [];
  const logs = [];
  const server = createMcpServer({
    manifest, handlers, providers, cwd, rootFlags: root === undefined ? {} : { '--root': root }, send: (message) => sent.push(message), log: (line) => logs.push(line),
  });
  let nextId = 1;
  const responseTo = (id) => sent.find((message) => message.id === id && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')));
  const client = {
    server, sent, logs, providers,
    // sends one request and resolves with its response (or undefined when none was sent)
    async request(method, params, { id = nextId++ } = {}) {
      await server.receive(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
      return responseTo(id);
    },
    // starts a request without waiting; resolves when the server has finished with it
    start(method, params, { id = nextId++ } = {}) {
      const done = server.receive(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
      return { id, done: done.then(() => responseTo(id)) };
    },
    notify: (method, params) => server.receive(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })),
    raw: (line) => server.receive(line),
    async legacy(version = '2025-06-18') {
      const response = await client.request('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      await client.notify('notifications/initialized');
      return response;
    },
    // one tools/call; legacy unless `meta` is given
    async call(name, args, { meta } = {}) {
      const response = await client.request('tools/call', { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) });
      assert.ok(response?.result, JSON.stringify(response));
      return response.result;
    },
  };
  return client;
}

// The CLI twin of a tool call: the argv the dispatcher reports, through the real adapter with the same providers.
export async function cliTwin(argv, { cwd, providers }) {
  const result = await runCliAdapter({
    argv, cwd, manifest: commandManifest, handlers: commandHandlers, providers, readStdin: async () => Buffer.alloc(0),
  });
  return { exitCode: result.exitCode, packet: JSON.parse(result.stdout === '' ? result.stderr : result.stdout) };
}

// A JSON-RPC client over a real `node bin/akrs.js mcp` child process.
export function spawnServer({ cwd, args = [], env = {} }) {
  const child = spawn(process.execPath, [CLI, 'mcp', ...args], { cwd, env: injectedEnvironment(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const stdoutChunks = [];
  let stderr = '';
  let buffered = '';
  const lines = [];
  const waiters = [];
  child.stdout.on('data', (chunk) => {
    stdoutChunks.push(chunk);
    buffered += chunk.toString('utf8');
    let index = buffered.indexOf('\n');
    while (index !== -1) {
      lines.push(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
      index = buffered.indexOf('\n');
    }
    for (const waiter of [...waiters]) waiter();
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  const timer = setTimeout(() => child.kill(), 20_000);
  exited.then(() => clearTimeout(timer));
  return {
    child,
    write: (text) => child.stdin.write(text),
    send: (message, { eol = '\n' } = {}) => child.stdin.write(`${JSON.stringify(message)}${eol}`),
    end: () => child.stdin.end(),
    // resolves with the parsed message whose id matches
    response(id) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = lines.map((line) => JSON.parse(line)).find((message) => message.id === id);
          if (found) {
            waiters.splice(waiters.indexOf(check), 1);
            resolve(found);
          }
        };
        waiters.push(check);
        exited.then(() => reject(new Error(`server exited before answering ${id}; stderr: ${stderr}`)));
        check();
      });
    },
    async finish() {
      const status = await exited;
      return { ...status, stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr, lines };
    },
  };
}
