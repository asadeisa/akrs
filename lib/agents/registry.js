// The agent registry (F20): data only, one record per agent, encoded from the A1 agent matrix (research record of 2026-10-03; each fact there is
// marked V = verified or U = unverified). A fact that is U, or that the matrix does not state, is NOT encoded as a capability: it is listed in
// `unverified` and the surface it belongs to is excluded (no write, doctor says so). The record shape and the rules live in policy.js.
// Agents change fast: re-verify a row before relying on it and move its date here. No code runs from this module.

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const VERIFIED_ON = '2026-10-03';

const record = (value) => value;

const NO_HOOK = { hook_mode: 'none', status: 'unverified', config_path: null, scope: 'project', event: null, payload_format: 'none', deny_protocol: 'none', note: null };
const unverifiedPre = (event, note, configPath = null, scope = 'project') => ({
  hook_mode: 'pre', status: 'unverified', config_path: configPath, scope, event, payload_format: 'unverified', deny_protocol: 'unverified', note,
});
const MCP_SERVERS = { support: 'native', format: 'mcpservers-json', opt_in: null, entry_extras: null, note: null };

export const AGENT_REGISTRY = deepFreeze([
  record({
    id: 'claude',
    label: 'Claude Code',
    verified_on: VERIFIED_ON,
    instructions: { mode: 'import_block', file: 'CLAUDE.md', block_id: 'claude-import', import_line: '@AGENTS.md', user_path: '~/.claude/CLAUDE.md' },
    skills: { project_dir: '.claude/skills', mode: 'copy', user_dir: '~/.claude/skills' },
    mcp: { ...MCP_SERVERS, project_path: '.mcp.json', user_path: '~/.claude.json', note: 'Claude Code asks the user to approve a project MCP server on first use.' },
    hooks: {
      hook_mode: 'pre', status: 'verified', config_path: '.claude/settings.local.json', scope: 'project', event: 'PreToolUse', payload_format: 'tool_input_json', deny_protocol: 'exit_code_2',
      note: 'matcher Write|Edit|MultiEdit; the payload carries tool_input.file_path on stdin; exit 2 denies and the reason is on stderr.',
    },
    unverified: [],
  }),
  record({
    id: 'codex',
    label: 'Codex CLI',
    verified_on: VERIFIED_ON,
    instructions: { mode: 'native', file: 'AGENTS.md', block_id: null, import_line: null, user_path: '~/.codex/AGENTS.md' },
    skills: { project_dir: '.agents/skills', mode: 'pointer', user_dir: '~/.agents/skills' },
    mcp: { support: 'native', format: 'codex-toml', project_path: '.codex/config.toml', user_path: '~/.codex/config.toml', opt_in: null, entry_extras: null, note: 'Codex reads .codex/config.toml only for trusted projects.' },
    hooks: unverifiedPre('PreToolUse', 'the matrix names hooks.json and a [hooks] table without saying which file a project may use or the payload format.'),
    unverified: ['codex.hooks.config_path', 'codex.hooks.payload_format'],
  }),
  record({
    id: 'gemini',
    label: 'Gemini CLI',
    verified_on: VERIFIED_ON,
    instructions: { mode: 'import_block', file: 'GEMINI.md', block_id: 'gemini-import', import_line: '@./AGENTS.md', user_path: '~/.gemini/GEMINI.md' },
    skills: { project_dir: '.agents/skills', mode: 'pointer', user_dir: '~/.agents/skills' },
    mcp: { ...MCP_SERVERS, project_path: '.gemini/settings.json', user_path: '~/.gemini/settings.json' },
    hooks: unverifiedPre('BeforeTool', 'the matrix names settings hooks and BeforeTool without the payload format or the deny protocol.', '.gemini/settings.json'),
    unverified: ['gemini.hooks.payload_format', 'gemini.hooks.deny_protocol'],
  }),
  record({
    id: 'pi',
    label: 'Pi',
    verified_on: VERIFIED_ON,
    instructions: { mode: 'native', file: 'AGENTS.md', block_id: null, import_line: null, user_path: '~/.pi/agent/AGENTS.md' },
    skills: { project_dir: '.agents/skills', mode: 'pointer', user_dir: '~/.pi/agent/skills' },
    mcp: {
      support: 'adapter', format: 'mcpservers-json', project_path: '.pi/mcp.json', user_path: '~/.pi/agent/mcp.json', opt_in: 'pi-mcp', entry_extras: { directTools: true },
      note: 'Pi has no native MCP; only the pi-mcp-adapter extension reads these files, with directTools: true so the tools are not behind one proxy tool.',
    },
    hooks: unverifiedPre('tool_call', 'Pi hooks are TypeScript extensions (pi.on("tool_call")); setup does not generate code.'),
    unverified: ['pi.hooks.extension_install'],
  }),
  record({
    id: 'opencode',
    label: 'opencode',
    verified_on: VERIFIED_ON,
    instructions: { mode: 'native', file: 'AGENTS.md', block_id: null, import_line: null, user_path: null },
    skills: { project_dir: '.agents/skills', mode: 'pointer', user_dir: null },
    mcp: { support: 'native', format: 'opencode-json', project_path: 'opencode.json', user_path: null, opt_in: null, entry_extras: null, note: null },
    hooks: unverifiedPre('tool.execute.before', 'opencode hooks are JS/TS plugins; setup does not generate code.'),
    unverified: ['opencode.hooks.plugin_install'],
  }),
  record({
    id: 'kimi',
    label: 'Kimi Code CLI',
    verified_on: VERIFIED_ON,
    instructions: { mode: 'native', file: 'AGENTS.md', block_id: null, import_line: null, user_path: '~/.kimi-code/AGENTS.md' },
    skills: { project_dir: '.agents/skills', mode: 'pointer', user_dir: null },
    mcp: { ...MCP_SERVERS, project_path: '.kimi-code/mcp.json', user_path: '~/.kimi-code/mcp.json' },
    hooks: unverifiedPre('[[hooks]]', 'the matrix places [[hooks]] in the user-level ~/.kimi-code/config.toml only; setup never writes user scope.', '~/.kimi-code/config.toml', 'user'),
    unverified: ['kimi.hooks.payload_format', 'kimi.hooks.project_scope'],
  }),
  record({
    id: 'qwen',
    label: 'Qwen Code',
    verified_on: VERIFIED_ON,
    instructions: { mode: 'native', file: 'AGENTS.md', block_id: null, import_line: null, user_path: null },
    skills: { project_dir: '.qwen/skills', mode: 'copy', user_dir: '~/.qwen/skills' },
    mcp: { ...MCP_SERVERS, project_path: '.qwen/settings.json', user_path: '~/.qwen/settings.json' },
    hooks: { ...NO_HOOK, status: 'unverified', note: 'the matrix lists hooks as partial (U).' },
    unverified: ['qwen.skills.agents_dir', 'qwen.hooks'],
  }),
  record({
    id: 'cursor',
    label: 'Cursor',
    verified_on: VERIFIED_ON,
    instructions: { mode: 'native', file: 'AGENTS.md', block_id: null, import_line: null, user_path: null },
    skills: { project_dir: '.agents/skills', mode: 'pointer', user_dir: null },
    mcp: { ...MCP_SERVERS, project_path: '.cursor/mcp.json', user_path: '~/.cursor/mcp.json', note: 'Cursor allows about 40 MCP tools across all servers (unverified) and drops tools whose server plus tool name exceeds 60 characters; akrs names stay under that.' },
    hooks: {
      hook_mode: 'post', status: 'unverified', config_path: '.cursor/hooks.json', scope: 'project', event: 'afterFileEdit', payload_format: 'unverified', deny_protocol: 'none',
      note: 'only a post-edit hook exists: it can report but never deny.',
    },
    unverified: ['cursor.hooks.payload_format', 'cursor.skills.cli_support', 'cursor.mcp.tool_cap'],
  }),
  record({
    id: 'freebuff',
    label: 'Freebuff',
    verified_on: VERIFIED_ON,
    instructions: { mode: 'native', file: 'AGENTS.md', block_id: null, import_line: null, user_path: null },
    skills: { project_dir: '.agents/skills', mode: 'pointer', user_dir: null },
    mcp: {
      support: 'native', format: 'freebuff-json', project_path: '.agents/mcp.json', user_path: '~/.agents/mcp.json', opt_in: null, entry_extras: null,
      note: 'Strict schema: an entry may hold only type, command, args and env; any other key invalidates the whole file.',
    },
    hooks: { ...NO_HOOK, status: 'unverified', note: 'no hook mechanism was found (U).' },
    unverified: ['freebuff.hooks', 'freebuff.mcp.container_key'],
  }),
]);

export const agentById = (id) => AGENT_REGISTRY.find((entry) => entry.id === id) ?? null;
