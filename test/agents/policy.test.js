// F20 freeze (P2-W16): the registry record shape, the managed-block markers, the conflict policy, the unverified exclusions, the manifest
// entries of `agents setup|doctor|list`, the finding and the snapshot / transaction rows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { getFindingDefinition } from '../../lib/findings/catalog.js';
import {
  AGENT_FILE_ACTIONS, AGENT_FILE_FORMATS, AGENT_FILE_KINDS, AGENT_FILE_STATES, AGENT_FINDING_CODE, AGENT_IDS, AGENT_POLICY, CONFLICT_REASONS, GUARD_HOOK,
  HOOKS_KEYS, HOOK_DENY_PROTOCOLS, HOOK_MODES, HOOK_PAYLOAD_FORMATS, HOOK_STATUSES, INSTRUCTIONS_KEYS, INSTRUCTION_MODES, MANAGED_BLOCKS, MCP_FORMATS, MCP_KEYS,
  MCP_OPT_INS, MCP_SERVER_KEY, MCP_SUPPORTS, REGISTRY_RECORD_KEYS, SCOPES, SKILLS_KEYS, SKILL_LIMITS, SKILL_MODES,
} from '../../lib/agents/policy.js';
import { AGENT_REGISTRY, agentById } from '../../lib/agents/registry.js';
import { COMMAND_SNAPSHOT_TABLE } from '../../lib/store/snapshots/index.js';
import { TRANSACTION_EXCEPTIONS, TRANSACTION_NON_MUTATIONS } from '../../lib/store/transactions/index.js';
import { MANAGED_BLOCK_STYLES } from '../../lib/store/managed-block.js';

const entry = (id) => commandManifest.commands.find((command) => command.id === id);
const frozen = (value, path = 'value') => {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true, `${path} is frozen`);
  for (const [key, child] of Object.entries(value)) frozen(child, `${path}.${key}`);
};

test('F20 constants: the nine agents in packet order, the finding, the vocabularies', () => {
  assert.deepEqual(AGENT_IDS, ['claude', 'codex', 'gemini', 'pi', 'opencode', 'kimi', 'qwen', 'cursor', 'freebuff']);
  assert.deepEqual(AGENT_REGISTRY.map(({ id }) => id), [...AGENT_IDS]);
  assert.equal(AGENT_FINDING_CODE, 'AKRS-C021');
  assert.equal(MCP_SERVER_KEY, 'akrs');
  assert.deepEqual(AGENT_FILE_STATES, ['current', 'missing', 'outdated', 'hand_modified', 'conflict']);
  assert.deepEqual(AGENT_FILE_ACTIONS, ['create', 'update', 'unchanged', 'conflict']);
  assert.deepEqual(AGENT_FILE_KINDS, ['hook', 'instructions', 'mcp', 'skill']);
  assert.deepEqual(AGENT_FILE_FORMATS, ['json', 'markdown', 'toml']);
  assert.deepEqual(CONFLICT_REASONS, [
    'content_edited', 'duplicate_block', 'hand_modified_entry', 'invalid_encoding', 'invalid_marker', 'mismatched_markers', 'nested_markers', 'unbalanced_markers',
    'unexpected_shape', 'unmanaged_entry', 'unmanaged_file', 'unparsable_json',
  ]);
  for (const list of [AGENT_IDS, AGENT_FILE_STATES, CONFLICT_REASONS]) assert.equal(Object.isFrozen(list), true);
});

test('F20 managed-block markers: ids and styles of the P0-W06 primitive, one block per target', () => {
  frozen(MANAGED_BLOCKS);
  assert.deepEqual(MANAGED_BLOCKS, {
    agent_pointer: { id: 'agent-pointer', style: 'html', file: 'AGENTS.md' },
    claude_import: { id: 'claude-import', style: 'html', file: 'CLAUDE.md' },
    gemini_import: { id: 'gemini-import', style: 'html', file: 'GEMINI.md' },
    skill_pointer: { id: 'skill-pointer', style: 'html', file: 'SKILL.md' },
    codex_mcp: { id: 'mcp-akrs', style: 'hash', file: '.codex/config.toml' },
  });
  for (const block of Object.values(MANAGED_BLOCKS)) assert.ok(MANAGED_BLOCK_STYLES.includes(block.style));
  assert.deepEqual(GUARD_HOOK, { script: 'bin/akrs-guard.js', matcher: 'Write|Edit|MultiEdit', invocation: 'node "<abs>/bin/akrs-guard.js"' });
  assert.deepEqual(SKILL_LIMITS, { name_pattern: '^[a-z0-9][a-z0-9-]{0,63}$', description_max: 1024, frontmatter_keys: ['name', 'description'] });
});

test('F20 the decision record is frozen and every decision is a documented sentence', () => {
  frozen(AGENT_POLICY);
  assert.deepEqual(Object.keys(AGENT_POLICY), [
    'scope', 'agent_selection', 'instructions', 'skills', 'mcp', 'json_ownership', 'toml', 'hooks', 'conflicts', 'writes', 'doctor', 'unverified',
  ]);
  for (const text of Object.values(AGENT_POLICY)) assert.match(text, /^\(decision\) .{60,}/);
});

test('F20 registry record shape: closed key sets and vocabularies at every level', () => {
  frozen(AGENT_REGISTRY);
  for (const record of AGENT_REGISTRY) {
    assert.deepEqual(Object.keys(record).sort(), [...REGISTRY_RECORD_KEYS].sort(), record.id);
    assert.deepEqual(Object.keys(record.instructions).sort(), [...INSTRUCTIONS_KEYS].sort(), record.id);
    assert.deepEqual(Object.keys(record.skills).sort(), [...SKILLS_KEYS].sort(), record.id);
    assert.deepEqual(Object.keys(record.mcp).sort(), [...MCP_KEYS].sort(), record.id);
    assert.deepEqual(Object.keys(record.hooks).sort(), [...HOOKS_KEYS].sort(), record.id);
    assert.match(record.verified_on, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(INSTRUCTION_MODES.includes(record.instructions.mode), record.id);
    assert.ok(SKILL_MODES.includes(record.skills.mode), record.id);
    assert.ok(MCP_SUPPORTS.includes(record.mcp.support), record.id);
    assert.ok(record.mcp.format === null || MCP_FORMATS.includes(record.mcp.format), record.id);
    assert.ok(record.mcp.opt_in === null || MCP_OPT_INS.includes(record.mcp.opt_in), record.id);
    assert.ok(HOOK_MODES.includes(record.hooks.hook_mode), record.id);
    assert.ok(HOOK_STATUSES.includes(record.hooks.status), record.id);
    assert.ok(HOOK_PAYLOAD_FORMATS.includes(record.hooks.payload_format), record.id);
    assert.ok(HOOK_DENY_PROTOCOLS.includes(record.hooks.deny_protocol), record.id);
    assert.ok(SCOPES.includes(record.hooks.scope), record.id);
    assert.ok(Array.isArray(record.unverified), record.id);
    // paths are repository relative with `/`, or ~ for user scope
    for (const path of [record.mcp.project_path, record.skills.project_dir, record.instructions.file, record.hooks.config_path]) {
      if (path !== null && !path.startsWith('~')) assert.doesNotMatch(path, /^\/|\\|\.\./);
    }
  }
});

test('F20 hook fields are coherent: hook_mode, payload_format and deny_protocol; only verified hooks are written', () => {
  for (const { id, hooks } of AGENT_REGISTRY) {
    if (hooks.hook_mode === 'none') assert.deepEqual([hooks.payload_format, hooks.deny_protocol, hooks.event], ['none', 'none', null], id);
    if (hooks.hook_mode === 'post') assert.equal(hooks.deny_protocol, 'none', `${id}: a post-edit hook cannot deny`);
    if (hooks.status === 'verified') {
      assert.equal(hooks.hook_mode, 'pre', id);
      assert.equal(hooks.scope, 'project', id);
      assert.notEqual(hooks.config_path, null, id);
      assert.deepEqual([hooks.payload_format, hooks.deny_protocol], ['tool_input_json', 'exit_code_2'], id);
    } else if (hooks.hook_mode !== 'none') {
      assert.deepEqual([hooks.payload_format, hooks.deny_protocol].includes('unverified'), true, id);
    }
  }
  assert.deepEqual(AGENT_REGISTRY.filter(({ hooks }) => hooks.status === 'verified').map(({ id }) => id), ['claude']);
  assert.deepEqual(agentById('cursor').hooks, {
    hook_mode: 'post', status: 'unverified', config_path: '.cursor/hooks.json', scope: 'project', event: 'afterFileEdit', payload_format: 'unverified', deny_protocol: 'none',
    note: 'only a post-edit hook exists: it can report but never deny.',
  });
  assert.equal(agentById('kimi').hooks.scope, 'user');
});

test('F20 matrix facts: paths, formats, the unverified exclusions', () => {
  const mcp = Object.fromEntries(AGENT_REGISTRY.map(({ id, mcp: value }) => [id, [value.support, value.format, value.project_path]]));
  assert.deepEqual(mcp, {
    claude: ['native', 'mcpservers-json', '.mcp.json'],
    codex: ['native', 'codex-toml', '.codex/config.toml'],
    gemini: ['native', 'mcpservers-json', '.gemini/settings.json'],
    pi: ['adapter', 'mcpservers-json', '.pi/mcp.json'],
    opencode: ['native', 'opencode-json', 'opencode.json'],
    kimi: ['native', 'mcpservers-json', '.kimi-code/mcp.json'],
    qwen: ['native', 'mcpservers-json', '.qwen/settings.json'],
    cursor: ['native', 'mcpservers-json', '.cursor/mcp.json'],
    freebuff: ['native', 'freebuff-json', '.agents/mcp.json'],
  });
  const skills = Object.fromEntries(AGENT_REGISTRY.map(({ id, skills: value }) => [id, [value.project_dir, value.mode]]));
  assert.deepEqual(skills, {
    claude: ['.claude/skills', 'copy'], codex: ['.agents/skills', 'pointer'], gemini: ['.agents/skills', 'pointer'], pi: ['.agents/skills', 'pointer'],
    opencode: ['.agents/skills', 'pointer'], kimi: ['.agents/skills', 'pointer'], qwen: ['.qwen/skills', 'copy'], cursor: ['.agents/skills', 'pointer'],
    freebuff: ['.agents/skills', 'pointer'],
  });
  assert.deepEqual(agentById('claude').instructions, { mode: 'import_block', file: 'CLAUDE.md', block_id: 'claude-import', import_line: '@AGENTS.md', user_path: '~/.claude/CLAUDE.md' });
  assert.equal(agentById('gemini').instructions.import_line, '@./AGENTS.md');
  assert.deepEqual([agentById('pi').mcp.opt_in, agentById('pi').mcp.entry_extras], ['pi-mcp', { directTools: true }]);
  // an unverified fact is listed and excluded
  assert.ok(agentById('qwen').unverified.includes('qwen.skills.agents_dir'));
  assert.ok(agentById('cursor').unverified.includes('cursor.skills.cli_support'));
  assert.ok(agentById('freebuff').unverified.includes('freebuff.hooks'));
  assert.equal(agentById('qwen').skills.project_dir, '.qwen/skills');
  assert.equal(agentById('nobody'), null);
});

test('F20 manifest: agents setup (mutation), agents doctor and agents list (queries) on the existing snapshot rows', () => {
  const setup = entry('agents-setup');
  assert.deepEqual([setup.tokens, setup.mutability, setup.dry_run, setup.required_role, setup.mcp_tool, setup.mcp_action], [['agents', 'setup'], 'mutation', true, 'any', null, null]);
  assert.deepEqual(setup.flags.map(({ name }) => name), ['--agent', '--pi-mcp', '--dry-run', '--root', '--workflow-root', '--json', '--jsonl', '--prompt']);
  assert.deepEqual(setup.flags.find(({ name }) => name === '--agent'), { name: '--agent', value_type: 'string', required: false, repeatable: true });
  assert.deepEqual(setup.snapshot_inputs, COMMAND_SNAPSHOT_TABLE['agents-setup'].inputs);
  assert.deepEqual(setup.exit_codes, [0, 1, 2, 4]);
  for (const id of ['agents-doctor', 'agents-list']) {
    const query = entry(id);
    assert.deepEqual([query.mutability, query.dry_run, query.idempotency, query.expected_snapshot, query.mcp_tool], ['query', false, 'not_applicable', 'not_applicable', null], id);
    assert.deepEqual(query.snapshot_inputs, COMMAND_SNAPSHOT_TABLE[id].inputs, id);
  }
  assert.deepEqual(entry('agents-doctor').tokens, ['agents', 'doctor']);
  assert.deepEqual(entry('agents-list').tokens, ['agents', 'list']);
  assert.deepEqual(entry('agents-doctor').flags.map(({ name }) => name), ['--agent', '--pi-mcp', '--root', '--workflow-root', '--json', '--jsonl', '--prompt']);
  assert.deepEqual(entry('agents-list').flags.map(({ name }) => name), ['--agent', '--root', '--workflow-root', '--json', '--jsonl', '--prompt']);
});

test('F20 transaction policy: setup is the agent_config exception; doctor and list are non-mutations', () => {
  assert.equal(TRANSACTION_EXCEPTIONS['agents-setup'].reason, 'agent_config');
  assert.ok(TRANSACTION_NON_MUTATIONS.includes('agents-doctor'));
  assert.ok(TRANSACTION_NON_MUTATIONS.includes('agents-list'));
});

test('F20 finding AKRS-C021 is a command warning with the reason vocabulary and the exact setup command', () => {
  const definition = getFindingDefinition(AGENT_FINDING_CODE);
  assert.equal(definition.category, 'command');
  assert.equal(definition.severity, 'warning');
  assert.deepEqual(definition.data_schema.properties.reason.enum, ['missing', 'outdated', ...CONFLICT_REASONS].sort());
  assert.deepEqual(definition.data_schema.required, ['agent', 'path', 'reason']);
  assert.ok('setup' in definition.data_schema.properties);
});
