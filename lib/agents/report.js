// Projections shared by setup, doctor and list: findings, snapshots, what each agent gets, the user-scope instructions, notes and surfaces.
import { createHash } from 'node:crypto';
import { AGENT_FINDING_CODE } from './policy.js';
import { publicFile, userSnippet } from './plan.js';

export { publicFile };

const hashOf = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

// One snapshot over the planned files: the sha256 of every `path<TAB>snapshot|absent` line. `which` is before_snapshot or after_snapshot.
export function snapshotOf(files, which) {
  return hashOf(files.map((file) => `${file.path}\t${file[which] ?? 'absent'}\n`).join(''));
}

export const KIND_LABELS = Object.freeze({ hook: 'guard hook', instructions: 'instruction pointer', mcp: 'MCP server entry', skill: 'skill pointer' });

export function setupCommandOf(file, rootArgs, { piMcp = false } = {}) {
  const args = ['agents', 'setup', ...file.agents.flatMap((id) => ['--agent', id]), ...(piMcp || file.path === '.pi/mcp.json' ? ['--pi-mcp'] : []), ...rootArgs];
  return `akrs ${args.join(' ')}`;
}

const labelOf = (agents, id) => agents.find((agent) => agent.id === id)?.label ?? id;

// One AKRS-C021 warning per file that is not current. `repair` adds the exact setup command for what setup can fix (missing, outdated).
export function agentFindings({ files, agents, rootArgs, repair, piMcp }) {
  const findings = [];
  for (const file of files) {
    if (file.state === 'current') continue;
    if (!repair && (file.state === 'missing' || file.state === 'outdated')) continue;
    const agent = file.agents[0];
    const label = labelOf(agents, agent);
    const kind = KIND_LABELS[file.kind];
    let reason = file.reason;
    let message;
    if (file.state === 'missing') {
      reason = 'missing';
      message = `${label}: ${file.path} has no AKRS ${kind} yet.`;
    } else if (file.state === 'outdated') {
      reason = 'outdated';
      message = `${label}: the AKRS ${kind} in ${file.path} is outdated: it no longer matches what setup would write.`;
    } else if (file.state === 'hand_modified') {
      message = `${label}: the AKRS ${kind} in ${file.path} was edited by hand inside the managed part; setup leaves it untouched. To hand it back, remove the block (or the entry) and run setup again.`;
    } else {
      message = `${label}: ${file.path} cannot be managed (${reason}); setup leaves it untouched.`;
    }
    const detail = { agent, agents: [...file.agents], path: file.path, reason, state: file.state };
    if (file.line !== null) detail.line = file.line;
    if (repair && (file.state === 'missing' || file.state === 'outdated')) detail.setup = setupCommandOf(file, rootArgs, { piMcp });
    findings.push({ code: AGENT_FINDING_CODE, severity: 'warning', message, file: file.path, line: file.line, detail });
  }
  return findings;
}

export function countsOf(files) {
  const counts = { current: 0, missing: 0, outdated: 0, hand_modified: 0, conflict: 0 };
  for (const file of files) counts[file.state] += 1;
  return counts;
}

export const filesOf = (agentId, files) => files.filter((file) => file.agents.includes(agentId));

// What setup configures for an agent: cli_skills | cli_skills_mcp | cli_skills_mcp_guard.
export function integrationOf(agent, files) {
  const own = filesOf(agent.id, files);
  const mcp = own.some(({ kind }) => kind === 'mcp');
  const hook = own.some(({ kind }) => kind === 'hook');
  if (mcp && hook) return 'cli_skills_mcp_guard';
  return mcp ? 'cli_skills_mcp' : 'cli_skills';
}

const BACKSTOP = 'audit inside done is the backstop';

export function summaryOf(integration) {
  if (integration === 'cli_skills') return `CLI + skills only: no MCP, no pre-write guard (${BACKSTOP}).`;
  if (integration === 'cli_skills_mcp') return `CLI + skills + MCP; no pre-write guard (${BACKSTOP}).`;
  return `CLI + skills + MCP + pre-write guard (${BACKSTOP}).`;
}

function overall(own) {
  if (own.length === 0) return 'not_configured';
  return own.every(({ state }) => state === 'current') ? 'ok' : 'attention';
}

function hookDetail(agent) {
  const { hooks } = agent;
  const note = hooks.note === null ? '' : ` ${hooks.note}`;
  if (hooks.hook_mode === 'none') return `no hook is configured: ${hooks.note ?? 'the agent has no hook mechanism'}; ${BACKSTOP}.`;
  if (hooks.hook_mode === 'post') {
    return `report-only: the agent has only a post-edit hook (${hooks.event}) that can report but never deny, and its payload is unverified, so no hook is written; ${BACKSTOP}.`;
  }
  if (hooks.scope === 'user') {
    return `no project hook is written: the hook lives in the user scope (${hooks.config_path}) and setup writes project scope only; its payload is unverified.${note} ${BACKSTOP}.`;
  }
  return `no hook is written: the ${hooks.event} hook is unverified.${note} ${BACKSTOP}.`;
}

export function surfacesOf(agent, files, { piMcp }) {
  const own = filesOf(agent.id, files);
  const of = (kind) => own.filter((file) => file.kind === kind);
  const mcpOptIn = agent.mcp.opt_in !== null && !piMcp;
  let mcp;
  if (agent.mcp.support === 'none') mcp = { status: 'not_supported', detail: 'the agent has no MCP support' };
  else if (mcpOptIn) {
    mcp = { status: 'not_configured', detail: `${agent.label} has no native MCP; only the pi-mcp-adapter extension reads ${agent.mcp.project_path}. Install it, then run: akrs agents setup --agent ${agent.id} --pi-mcp` };
  } else {
    const status = overall(of('mcp'));
    mcp = { status, detail: status === 'ok' ? `${agent.mcp.project_path} registers the akrs server` : `${agent.mcp.project_path} needs attention` };
  }
  const hookFiles = of('hook');
  const hooks = hookFiles.length === 0
    ? { status: 'not_configured', detail: hookDetail(agent) }
    : { status: overall(hookFiles), detail: `${agent.hooks.config_path} runs the ${agent.hooks.event} guard hook` };
  const skillFiles = of('skill');
  const skills = skillFiles.length === 0
    ? { status: 'not_configured', detail: 'no skills were found to point at' }
    : { status: overall(skillFiles), detail: `${agent.skills.project_dir}: ${skillFiles.length} pointer${skillFiles.length === 1 ? '' : 's'}` };
  const instructionFiles = of('instructions');
  return {
    instructions: { status: overall(instructionFiles), detail: instructionFiles.map(({ path }) => path).join(', ') },
    skills,
    mcp,
    hooks,
  };
}

export function notesOf(agent) {
  const notes = [];
  if (agent.id === 'claude') {
    notes.push({ code: 'mcp_approval', level: 'info', text: 'Claude Code asks you to approve the project MCP server akrs (.mcp.json) the first time it starts: approve it.' });
  }
  if (agent.id === 'codex') {
    notes.push({ code: 'trusted_project', level: 'info', text: 'Codex reads .codex/config.toml only for trusted projects: mark this project as trusted in Codex before using the akrs MCP server.' });
  }
  if (agent.id === 'pi') {
    notes.push({
      code: 'untrusted_project_skills',
      level: 'warning',
      text: 'Pi in non-interactive modes ignores the project skills of an untrusted project: trust this project in an interactive Pi session first, or the skills in .agents/skills are not loaded.',
    });
  }
  return notes;
}

export function userScopeOf(agents, launch, { piMcp }) {
  const out = [];
  for (const agent of agents) {
    if (agent.mcp.support === 'none' || agent.mcp.user_path === null) continue;
    if (agent.mcp.opt_in !== null && !piMcp) continue;
    out.push({ agent: agent.id, purpose: 'mcp', path: agent.mcp.user_path, snippet: userSnippet(agent, launch) });
  }
  return out;
}

export function manualStepsOf(agents, { piMcp }) {
  const steps = [];
  for (const agent of agents) {
    for (const note of notesOf(agent)) if (note.code !== 'untrusted_project_skills') steps.push({ agent: agent.id, text: note.text });
    if (agent.id === 'pi') {
      steps.push({
        agent: 'pi',
        text: piMcp
          ? 'Pi has no native MCP: install the pi-mcp-adapter extension; it reads .pi/mcp.json.'
          : 'Pi has no native MCP, so Pi gets CLI + skills only. To use the MCP tools install the pi-mcp-adapter extension, then run: akrs agents setup --agent pi --pi-mcp',
      });
    }
  }
  return steps;
}

export function skillsSummary(skills) {
  return { source: skills.source, count: skills.skills.length, names: skills.skills.map(({ name }) => name), skipped: skills.skipped };
}
