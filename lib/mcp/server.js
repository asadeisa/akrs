// The MCP JSON-RPC server, transport-free: `receive(line)` takes one framed message, `send(message)` emits one. Dual era (F19): an
// `initialize` request selects legacy semantics for the process; a request whose `_meta` names a protocol version is served statelessly
// by the 2026-07-28 rules. Tool calls run one at a time in arrival order; notifications/cancelled aborts or drops a call.
import packageJson from '../../package.json' with { type: 'json' };
import { callTool } from './dispatch.js';
import { MCP_ERRORS, MCP_INSTRUCTIONS, MCP_PROTOCOL, MCP_SERVER_NAME } from './policy.js';
import { projectTools } from './project.js';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
const keyOf = (id) => JSON.stringify(id);
const KEYS = MCP_PROTOCOL.meta_keys;

export function createMcpServer({
  manifest, handlers, providers, cwd, rootFlags = {}, send, log = () => {}, version = packageJson.version,
}) {
  const projection = projectTools(manifest);
  const serverInfo = { name: MCP_SERVER_NAME, version };
  const pending = new Map();
  let legacyVersion = null;
  let queue = Promise.resolve();
  let closing = false;

  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  const modern = (result, cacheable = false) => ({
    resultType: MCP_PROTOCOL.result_type,
    ...result,
    ...(cacheable ? { ttlMs: MCP_PROTOCOL.cache.ttl_ms, cacheScope: MCP_PROTOCOL.cache.scope } : {}),
    _meta: { [KEYS.server_info]: { ...serverInfo } },
  });
  const unsupported = (id, requested) => fail(id, MCP_ERRORS.unsupported_protocol_version, 'Unsupported protocol version', {
    supported: [...MCP_PROTOCOL.modern_versions], requested,
  });

  const server = { lastCall: null, ranCommands: [], receive, close, projection };

  function toolCall(id, params, era) {
    if (!isPlainObject(params) || typeof params.name !== 'string') {
      fail(id, MCP_ERRORS.invalid_params, 'tools/call needs params.name (a tool name) and params.arguments (an object)');
      return Promise.resolve();
    }
    if (!Object.hasOwn(projection.routes, params.name)) {
      fail(id, MCP_ERRORS.invalid_params, `Unknown tool: ${params.name}`);
      return Promise.resolve();
    }
    const entry = { controller: new AbortController(), cancelled: false };
    if (closing) entry.controller.abort();
    pending.set(keyOf(id), entry);
    const run = queue.then(async () => {
      if (entry.cancelled) return;
      const outcome = await callTool({
        tool: params.name, args: params.arguments, projection, manifest, handlers, providers, cwd, rootFlags, signal: entry.controller.signal,
      });
      server.lastCall = { tool: params.name, argv: outcome.argv, exitCode: outcome.exitCode, command: outcome.command };
      if (outcome.command !== null) server.ranCommands.push(outcome.command);
      // a cancelled request gets no response at all
      if (!entry.cancelled) reply(id, era === 'modern' ? modern(outcome.result) : outcome.result);
    }).catch((error) => {
      log(`akrs mcp: internal error in tools/call: ${error instanceof Error ? error.stack : String(error)}`);
      if (!entry.cancelled) fail(id, MCP_ERRORS.internal_error, 'Internal error');
    }).finally(() => pending.delete(keyOf(id)));
    queue = run;
    return run;
  }

  function serve(id, method, params, era) {
    if (method === 'tools/list') {
      const result = { tools: projection.tools.map((tool) => structuredClone(tool)) };
      reply(id, era === 'modern' ? modern(result, true) : result);
      return Promise.resolve();
    }
    if (method === 'tools/call') return toolCall(id, params, era);
    if (era === 'modern' && method === 'server/discover') {
      reply(id, modern({
        supportedVersions: [...MCP_PROTOCOL.modern_versions], capabilities: structuredClone(MCP_PROTOCOL.capabilities), instructions: MCP_INSTRUCTIONS,
      }, true));
      return Promise.resolve();
    }
    if (era === 'legacy' && method === 'ping') {
      reply(id, {});
      return Promise.resolve();
    }
    fail(id, MCP_ERRORS.method_not_found, `Method not found: ${method}`);
    return Promise.resolve();
  }

  function request(id, method, params) {
    if (params !== undefined && !isPlainObject(params)) {
      fail(id, MCP_ERRORS.invalid_params, 'params must be an object');
      return Promise.resolve();
    }
    const meta = params?._meta;
    if (isPlainObject(meta) && Object.hasOwn(meta, KEYS.protocol_version)) {
      const requested = meta[KEYS.protocol_version];
      if (!MCP_PROTOCOL.modern_versions.includes(requested)) {
        unsupported(id, requested);
        return Promise.resolve();
      }
      return serve(id, method, params, 'modern');
    }
    if (method === 'initialize') {
      if (legacyVersion !== null) {
        fail(id, MCP_ERRORS.invalid_request, 'The session is already initialized');
        return Promise.resolve();
      }
      const asked = params?.protocolVersion;
      legacyVersion = MCP_PROTOCOL.legacy_versions.includes(asked) ? asked : MCP_PROTOCOL.legacy_fallback;
      log(`akrs mcp: legacy session ${legacyVersion}${asked === legacyVersion ? '' : ` (client asked for ${JSON.stringify(asked ?? null)})`}`);
      reply(id, {
        protocolVersion: legacyVersion, capabilities: structuredClone(MCP_PROTOCOL.capabilities), serverInfo: { ...serverInfo }, instructions: MCP_INSTRUCTIONS,
      });
      return Promise.resolve();
    }
    // neither an initialized legacy session nor a modern version: the modern error tells a dual-era client what to send
    if (legacyVersion === null) {
      unsupported(id, null);
      return Promise.resolve();
    }
    return serve(id, method, params, 'legacy');
  }

  function notification(method, params) {
    if (method !== 'notifications/cancelled' || !isPlainObject(params) || !isId(params.requestId)) return;
    const entry = pending.get(keyOf(params.requestId));
    if (entry === undefined) return;
    entry.cancelled = true;
    entry.controller.abort();
  }

  // One framed message (a line without its newline). Resolves when the server is done with it.
  function receive(line) {
    const text = typeof line === 'string' ? line : String(line);
    if (text.trim() === '') return Promise.resolve();
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      fail(null, MCP_ERRORS.parse_error, 'Parse error');
      return Promise.resolve();
    }
    if (!isPlainObject(message)) {
      fail(null, MCP_ERRORS.invalid_request, 'Invalid Request: one JSON-RPC object per line (no batches)');
      return Promise.resolve();
    }
    const hasId = Object.hasOwn(message, 'id');
    if (hasId && !isId(message.id)) {
      fail(null, MCP_ERRORS.invalid_request, 'Invalid Request: id must be a string or a number');
      return Promise.resolve();
    }
    const id = hasId ? message.id : null;
    if (message.jsonrpc !== '2.0') {
      fail(id, MCP_ERRORS.invalid_request, 'Invalid Request: jsonrpc must be "2.0"');
      return Promise.resolve();
    }
    if (!Object.hasOwn(message, 'method')) {
      // a response from the client (this server never sends requests): nothing to do
      if (hasId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) return Promise.resolve();
      fail(id, MCP_ERRORS.invalid_request, 'Invalid Request: method is missing');
      return Promise.resolve();
    }
    if (typeof message.method !== 'string') {
      fail(id, MCP_ERRORS.invalid_request, 'Invalid Request: method must be a string');
      return Promise.resolve();
    }
    if (!hasId) {
      notification(message.method, message.params);
      return Promise.resolve();
    }
    return request(message.id, message.method, message.params);
  }

  // stdin ended: everything received is still answered, but every pending call sees its abort signal (executions stop early).
  async function close() {
    closing = true;
    for (const entry of pending.values()) entry.controller.abort();
    await queue.catch(() => {});
  }

  return server;
}
