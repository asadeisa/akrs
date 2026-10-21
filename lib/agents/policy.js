// F20 (P2-W16): the frozen decisions of the agent adapters. Every value here is pinned by test/agents/policy.test.js; the registry
// (registry.js) is data under these rules, and plan.js / setup.js / doctor.js implement them. A change to any of these is a change to
// what `akrs agents setup` may write into a repository.

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const AGENT_IDS = Object.freeze(['claude', 'codex', 'gemini', 'pi', 'opencode', 'kimi', 'qwen', 'cursor', 'freebuff']);
export const AGENT_FINDING_CODE = 'AKRS-C021';
export const MCP_SERVER_KEY = 'akrs';
export const AGENT_FILE_STATES = Object.freeze(['current', 'missing', 'outdated', 'hand_modified', 'conflict']);
export const AGENT_FILE_ACTIONS = Object.freeze(['create', 'update', 'unchanged', 'conflict']);
export const AGENT_FILE_KINDS = Object.freeze(['hook', 'instructions', 'mcp', 'skill']);
export const AGENT_FILE_FORMATS = Object.freeze(['json', 'markdown', 'toml']);

// The record shape of one registry entry (closed key sets at every level).
export const REGISTRY_RECORD_KEYS = Object.freeze(['id', 'label', 'verified_on', 'instructions', 'skills', 'mcp', 'hooks', 'unverified']);
export const INSTRUCTIONS_KEYS = Object.freeze(['mode', 'file', 'block_id', 'import_line', 'user_path']);
export const SKILLS_KEYS = Object.freeze(['project_dir', 'mode', 'user_dir']);
export const MCP_KEYS = Object.freeze(['support', 'format', 'project_path', 'user_path', 'opt_in', 'entry_extras', 'note']);
export const HOOKS_KEYS = Object.freeze(['hook_mode', 'status', 'config_path', 'scope', 'event', 'payload_format', 'deny_protocol', 'note']);
export const INSTRUCTION_MODES = Object.freeze(['import_block', 'native']);
export const SKILL_MODES = Object.freeze(['copy', 'pointer']);
export const MCP_SUPPORTS = Object.freeze(['adapter', 'native', 'none']);
export const MCP_FORMATS = Object.freeze(['codex-toml', 'freebuff-json', 'mcpservers-json', 'opencode-json']);
export const MCP_OPT_INS = Object.freeze(['pi-mcp']);
export const HOOK_MODES = Object.freeze(['none', 'post', 'pre']);
export const HOOK_STATUSES = Object.freeze(['unverified', 'verified']);
export const HOOK_PAYLOAD_FORMATS = Object.freeze(['none', 'tool_input_json', 'unverified']);
export const HOOK_DENY_PROTOCOLS = Object.freeze(['exit_code_2', 'none', 'unverified']);
export const SCOPES = Object.freeze(['project', 'user']);

// The managed-block markers (the P0-W06 primitive's grammar) every writer uses. JSON has no comments, so JSON targets are owned by
// entry, not by marker (see AGENT_POLICY.json_ownership).
export const MANAGED_BLOCKS = deepFreeze({
  agent_pointer: { id: 'agent-pointer', style: 'html', file: 'AGENTS.md' },
  claude_import: { id: 'claude-import', style: 'html', file: 'CLAUDE.md' },
  gemini_import: { id: 'gemini-import', style: 'html', file: 'GEMINI.md' },
  skill_pointer: { id: 'skill-pointer', style: 'html', file: 'SKILL.md' },
  codex_mcp: { id: 'mcp-akrs', style: 'hash', file: '.codex/config.toml' },
});

export const GUARD_HOOK = deepFreeze({
  script: 'bin/akrs-guard.js',
  matcher: 'Write|Edit|MultiEdit',
  invocation: 'node "<abs>/bin/akrs-guard.js"',
});

export const SKILL_LIMITS = deepFreeze({ name_pattern: '^[a-z0-9][a-z0-9-]{0,63}$', description_max: 1024, frontmatter_keys: ['name', 'description'] });

export const CONFLICT_REASONS = Object.freeze([
  'content_edited', 'duplicate_block', 'hand_modified_entry', 'invalid_encoding', 'invalid_marker', 'mismatched_markers', 'nested_markers',
  'unbalanced_markers', 'unexpected_shape', 'unmanaged_entry', 'unmanaged_file', 'unparsable_json',
]);

export const AGENT_POLICY = deepFreeze({
  scope: '(decision) Project scope only: setup writes inside the repository root and nowhere else, and never reads or writes a user home. User-scope configuration (for example ~/.codex/config.toml, ~/.kimi-code/mcp.json) is described in data.user_scope with the exact snippet and path and is never written.',
  agent_selection: '(decision) --agent <id> (repeatable) selects agents; no --agent means all nine registered agents. An unknown agent is a usage error. setup, doctor and list share the selection.',
  instructions: '(decision) AGENTS.md is the canonical instruction pointer. Setup adds one managed block (agent-pointer) to AGENTS.md for every selected agent, creating the file when it is absent. Claude Code additionally gets a managed block in CLAUDE.md holding @AGENTS.md; Gemini CLI gets a managed block in GEMINI.md holding @./AGENTS.md (the import form; settings.json context.fileName is not touched). Agents that read AGENTS.md natively (Codex, Pi, opencode, Kimi, Qwen Code, Cursor, Freebuff) get nothing more; Qwen Code needs no QWEN.md because it reads AGENTS.md.',
  skills: '(decision) Skill names and descriptions come from the canonical bodies: <workflow>/skills/*.md of the project when that folder exists, otherwise the packaged templates (docs/framework/skills, excluding README.md). Each skill gets a thin pointer file <dir>/<name>/SKILL.md whose directory name equals the frontmatter name, with only name and description in the frontmatter (the description is written as a quoted string) and one managed block (skill-pointer) that says to read and execute the canonical body. Pointers are real files, never symlinks: .agents/skills for Codex, Gemini, Pi, opencode, Kimi, Cursor and Freebuff; copies at .claude/skills for Claude Code and .qwen/skills for Qwen Code. A skill whose name breaks the name pattern is skipped and reported; a description over 1024 characters is cut at 1024.',
  mcp: '(decision) The server entry is the key akrs launching `node <abs>/akrs.js mcp`, where <abs> is the bin folder of the running package (absolute, forward slashes, never a .cmd/.ps1 shim, no --root: clients start the server in the project directory). Four writers: mcpServers JSON (Claude Code .mcp.json, Cursor, Gemini CLI, Qwen Code, Kimi, pi-mcp-adapter), Codex TOML (.codex/config.toml), opencode (opencode.json, mcp.akrs = {type:local, command:[...], enabled:true}) and Freebuff strict JSON (.agents/mcp.json, entry keys command and args only). Every writer merges into an existing file and never replaces it. Pi has no native MCP: setup writes .pi/mcp.json (with directTools: true) only for the explicit --pi-mcp flag.',
  json_ownership: '(decision) JSON cannot carry a marker, so a JSON entry is owned by recognition: an entry under the key akrs whose launch is akrs.js mcp (or whose hook command runs akrs-guard.js). Equal to what setup would write = current; recognized and differing only in the launch fields (command, args, the hook command) = outdated, setup updates it; recognized with any other key changed or added = hand_modified, reported and never overwritten; an entry under the key akrs that is not recognized = conflict unmanaged_entry. A file that is not valid JSON, or whose containers have another shape, is a conflict and is left untouched. A changed file is re-serialized with its own indentation (2 spaces for a new file), BOM and line ending; every other key keeps its value and order.',
  toml: '(decision) The Codex entry is one managed hash block (mcp-akrs) holding the [mcp_servers.akrs] table, appended at the end of config.toml; nothing else in the file is reformatted. A [mcp_servers.akrs] table, a sub-table of it, or a dotted key defining it outside the block is a conflict unmanaged_entry, because adding the block would make the file invalid TOML.',
  hooks: '(decision) A hook is written only when its location, event, payload and deny protocol are verified (hooks.status verified). That is Claude Code only: a PreToolUse entry matching Write|Edit|MultiEdit running `node "<abs>/bin/akrs-guard.js"` in .claude/settings.local.json (machine specific because of the absolute path). Every other agent is recorded with hooks.status unverified (or hook_mode none) and gets no hook: doctor says so and names audit inside done as the backstop. An agent with only a post-edit hook reports and cannot deny (deny_protocol none).',
  conflicts: '(decision) A conflict is reported (finding AKRS-C021, warning) and the file is left byte for byte: a hand-edited managed block (content_edited), broken or duplicated markers, an unmanaged entry under the akrs key, a skill file that is not ours, an unreadable or unparsable file. Setup still completes every other file and ends warning (exit 1). There is no --force: to take a conflicting file back, remove the block or entry by hand and run setup again.',
  writes: '(decision) Setup is not a workflow transaction (agent_config exception): each changed file is written whole through a sibling temporary file, after re-reading the bytes it planned against (a file that changed meanwhile stops the run and nothing more is written); a new file is placed without replacing a concurrent creator. A run cut off halfway is finished by running setup again, which is a byte-identical no-op for everything already done. --dry-run computes the same plan and writes nothing.',
  doctor: '(decision) Doctor is a query. Per selected agent it classifies every file setup would manage as current, missing, outdated, hand_modified or conflict, states per surface what the agent supports (instructions, skills, mcp, hooks) and says explicitly when an agent is CLI + skills only or has no pre-write guard. Each non-current file is one AKRS-C021 warning carrying the exact setup command. Notes that are not defects (Pi ignores untrusted project skills in non-interactive modes; Claude Code asks to approve a project MCP server; Codex reads .codex/config.toml only for trusted projects) are listed as notes, not findings.',
  unverified: '(decision) A matrix fact that is not verified is listed in the record under unverified and excluded: Qwen Code .agents/skills, Cursor CLI skills, Freebuff hooks, every hook except Claude Code, and the Freebuff mcp.json top-level key (mcpServers is assumed, as in every other mcpServers file, until it is checked against a real Freebuff). The agent matrix is the 2026-10-03 research record; no web access was available to re-verify it at implementation time.',
});
