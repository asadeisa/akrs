// The plan of `agents setup` and `agents doctor` (F20): which files each selected agent needs, what is in them now, and what setup would
// write. Pure of any user home: only the repository (through the path service), the package root and the skills source are read.
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { normalizeAbsolutePath } from '../core/roots.js';
import { applyManagedBlock } from '../store/managed-block.js';
import { PathSafetyError, createPathService } from '../store/path-service.js';
import { mergeHookEntry, mergeServerEntry } from './json-config.js';
import { GUARD_HOOK, MANAGED_BLOCKS, MCP_SERVER_KEY } from './policy.js';
import { AGENT_REGISTRY } from './registry.js';
import { discoverSkills, fixSkillFrontmatter, pointerContent, renderSkillFile } from './skills.js';
import { findTomlDefinition, renderTomlTable } from './toml.js';

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const MCP_SCRIPT = ['bin', 'akrs.js'].join('/');
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export const AGENT_POINTER_TEXT = [
  '## AKRS',
  '',
  'This project uses AKRS. Leaders start with `akrs boot`; Workers run `akrs work`, then `akrs done`.',
  'Procedures are the skills in `.agents/skills/` (or `.claude/skills/`); run `akrs --help` for every command.',
  '',
].join('\n');

export class AgentSelectionError extends Error {}

export function selectAgents(ids) {
  if (ids === undefined || ids === null || ids.length === 0) return [...AGENT_REGISTRY];
  const unknown = ids.filter((id) => !AGENT_REGISTRY.some((entry) => entry.id === id));
  if (unknown.length > 0) {
    throw new AgentSelectionError(`unknown agent: ${unknown.join(', ')} (agents list names them: ${AGENT_REGISTRY.map(({ id }) => id).join(', ')})`);
  }
  return AGENT_REGISTRY.filter((entry) => ids.includes(entry.id));
}

// The launch of the MCP server and the guard: node + the absolute script path of the running package (forward slashes, no shim).
export function launchOf(packageRoot) {
  const root = normalizeAbsolutePath(packageRoot);
  return { akrs: `${root}/${MCP_SCRIPT}`, guard: `${root}/${GUARD_HOOK.script}` };
}

export function serverEntry(agent, launch) {
  const { format, entry_extras: extras } = agent.mcp;
  if (format === 'opencode-json') return { type: 'local', command: ['node', launch.akrs, 'mcp'], enabled: true };
  if (format === 'freebuff-json') return { command: 'node', args: [launch.akrs, 'mcp'] };
  return { command: 'node', args: [launch.akrs, 'mcp'], ...(extras ?? {}) };
}

function mcpTransform(agent, launch) {
  const { format } = agent.mcp;
  const desired = serverEntry(agent, launch);
  if (format === 'codex-toml') return { type: 'toml_block', content: renderTomlTable(['mcp_servers', MCP_SERVER_KEY], desired) };
  if (format === 'opencode-json') return { type: 'json_server', container: ['mcp'], key: MCP_SERVER_KEY, desired, launchKeys: ['command'] };
  return { type: 'json_server', container: ['mcpServers'], key: MCP_SERVER_KEY, desired, launchKeys: ['command', 'args'] };
}

function hookTransform(launch) {
  return {
    type: 'json_hook',
    desired: { matcher: GUARD_HOOK.matcher, hooks: [{ type: 'command', command: `node "${launch.guard}"` }] },
  };
}

// The snippet a user pastes for a user-scope registration (never written).
export function userSnippet(agent, launch) {
  const transform = mcpTransform(agent, launch);
  if (transform.type === 'toml_block') return transform.content;
  return `${JSON.stringify({ [transform.container[0]]: { [MCP_SERVER_KEY]: transform.desired } }, null, 2)}\n`;
}

// What each agent contributes: [{ path, kind, format, transform }].
export function artifactsOf(agent, { skills, launch, piMcp }) {
  const out = [];
  const pointer = MANAGED_BLOCKS.agent_pointer;
  out.push({ path: pointer.file, kind: 'instructions', format: 'markdown', transform: { type: 'md_block', id: pointer.id, content: AGENT_POINTER_TEXT } });
  if (agent.instructions.mode === 'import_block') {
    out.push({
      path: agent.instructions.file,
      kind: 'instructions',
      format: 'markdown',
      transform: { type: 'md_block', id: agent.instructions.block_id, content: `${agent.instructions.import_line}\n` },
    });
  }
  for (const skill of skills) {
    out.push({
      path: `${agent.skills.project_dir}/${skill.name}/SKILL.md`,
      kind: 'skill',
      format: 'markdown',
      transform: { type: 'skill', name: skill.name, description: skill.description, bodyPath: skill.bodyPath },
    });
  }
  const mcpWanted = agent.mcp.support !== 'none' && (agent.mcp.opt_in === null || (agent.mcp.opt_in === 'pi-mcp' && piMcp));
  if (mcpWanted) {
    out.push({ path: agent.mcp.project_path, kind: 'mcp', format: agent.mcp.format === 'codex-toml' ? 'toml' : 'json', transform: mcpTransform(agent, launch) });
  }
  const { hooks } = agent;
  if (hooks.status === 'verified' && hooks.hook_mode === 'pre' && hooks.scope === 'project') {
    out.push({ path: hooks.config_path, kind: 'hook', format: 'json', transform: hookTransform(launch) });
  }
  return out;
}

const result = (state, reason = null, line = null, after = null) => ({ state, reason, line, after });

function blockResult(text, options) {
  const outcome = applyManagedBlock(text ?? '', options);
  if (outcome.outcome === 'conflict') {
    return result(outcome.reason === 'content_edited' ? 'hand_modified' : 'conflict', outcome.reason, outcome.line);
  }
  if (outcome.outcome === 'unchanged') return result('current');
  return result(outcome.outcome === 'created' ? 'missing' : 'outdated', null, null, outcome.text);
}

const stripBlock = (text, { id, style }) => {
  const begin = style === 'hash' ? `# akrs:begin ${id} ` : `<!-- akrs:begin ${id} `;
  const end = style === 'hash' ? `# akrs:end ${id}` : `<!-- akrs:end ${id} -->`;
  const lines = text.split('\n');
  const from = lines.findIndex((line) => line.startsWith(begin));
  const to = lines.findIndex((line) => line.replace(/\r$/, '') === end);
  return from === -1 || to === -1 ? text : [...lines.slice(0, from), ...lines.slice(to + 1)].join('\n');
};

export function evaluateTransform(transform, text) {
  switch (transform.type) {
    case 'md_block': {
      return blockResult(text, { id: transform.id, style: 'html', content: transform.content });
    }
    case 'skill': {
      const block = MANAGED_BLOCKS.skill_pointer;
      if (text === null) return result('missing', null, null, renderSkillFile(transform));
      const outcome = blockResult(text, { id: block.id, style: block.style, content: pointerContent(transform.bodyPath) });
      // a file with no managed block is somebody else's skill: never appended to
      if (outcome.state === 'missing') return result('conflict', 'unmanaged_file');
      if (outcome.state === 'hand_modified' || outcome.state === 'conflict') return outcome;
      // the name and description live in the frontmatter above the block: they follow the canonical body too
      const fixed = fixSkillFrontmatter(outcome.after ?? text, transform);
      return fixed === (outcome.after ?? text) ? outcome : result('outdated', null, null, fixed);
    }
    case 'toml_block': {
      const block = MANAGED_BLOCKS.codex_mcp;
      const outcome = blockResult(text, { id: block.id, style: block.style, content: transform.content });
      if (outcome.state === 'hand_modified' || outcome.state === 'conflict') return outcome;
      const foreign = findTomlDefinition(stripBlock(text ?? '', block), ['mcp_servers', MCP_SERVER_KEY]);
      return foreign === null ? outcome : result('conflict', 'unmanaged_entry', foreign.line);
    }
    case 'json_server': return mergeServerEntry(text, transform);
    case 'json_hook': return mergeHookEntry(text, transform);
    default: throw new TypeError(`unknown transform: ${transform.type}`);
  }
}

const sameTransform = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// Reads one file inside the repository; { bytes, text, target, mode } with text null when absent. The path service refuses an escaping symlink.
async function readTarget(pathService, path) {
  const target = await pathService.resolveRepositoryPath(path);
  if (target.findings.length > 0) throw new PathSafetyError(target.findings[0].message);
  if (!target.exists) return { target, bytes: null, text: null, invalid: false };
  const metadata = await lstat(target.filesystem_path);
  if (!metadata.isFile()) throw new PathSafetyError(`agent config target is not a regular file: ${target.relative_path}`);
  const bytes = await readFile(target.filesystem_path);
  try {
    return { target, bytes, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), invalid: false };
  } catch {
    return { target, bytes, text: null, invalid: true };
  }
}

const ACTION_OF = { missing: null, outdated: 'update', current: 'unchanged', hand_modified: 'conflict', conflict: 'conflict' };

export async function planAgents({
  repositoryRoot, workflowRoot, packageRoot, sourceRoot, agents, piMcp = false,
}) {
  const selected = selectAgents(agents);
  const pathService = await createPathService({ repositoryRoot, workflowRoot: repositoryRoot });
  const workflowPath = relative(repositoryRoot, workflowRoot).replaceAll('\\', '/');
  const outside = isAbsolute(workflowPath) || workflowPath.startsWith('..') || /^[A-Za-z]:/.test(workflowPath);
  const workflowRelative = outside ? 'akrs' : workflowPath;
  const skills = await discoverSkills({ repositoryRoot, workflowRelative, sourceRoot });
  const launch = launchOf(packageRoot);

  const targets = new Map();
  for (const agent of selected) {
    for (const artifact of artifactsOf(agent, { skills: skills.skills, launch, piMcp })) {
      const known = targets.get(artifact.path);
      if (known === undefined) targets.set(artifact.path, { ...artifact, agents: [agent.id] });
      else if (sameTransform(known.transform, artifact.transform)) known.agents.push(agent.id);
      else throw new TypeError(`two agents plan different content for ${artifact.path}`);
    }
  }

  const files = [];
  for (const path of [...targets.keys()].sort(compare)) {
    const entry = targets.get(path);
    const current = await readTarget(pathService, path);
    const evaluated = current.invalid ? result('conflict', 'invalid_encoding') : evaluateTransform(entry.transform, current.text);
    const exists = current.bytes !== null;
    const action = evaluated.state === 'missing' ? (exists ? 'update' : 'create') : ACTION_OF[evaluated.state];
    const after = evaluated.after === null ? null : Buffer.from(evaluated.after);
    files.push({
      path: current.target.relative_path,
      kind: entry.kind,
      format: entry.format,
      agents: entry.agents,
      state: evaluated.state,
      reason: evaluated.reason,
      line: evaluated.line ?? null,
      action,
      before_snapshot: exists ? sha256(current.bytes) : null,
      after_snapshot: after === null ? (exists ? sha256(current.bytes) : null) : sha256(after),
      before: current.bytes,
      after,
    });
  }
  return { agents: selected, files, skills, launch, workflowRelative, pathService };
}

// The public projection of a planned file (no bytes).
export const publicFile = ({ before, after, ...file }) => file;
