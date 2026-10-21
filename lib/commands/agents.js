// Handlers of `agents setup`, `agents doctor` and `agents list` (P2-W16). They resolve the roots and the injected package and source roots,
// call lib/agents and wrap the result in one packet; no agent rule lives here. Nothing here reads or writes a user home.
import { CliUsageError } from '../core/errors.js';
import { createPacket } from '../core/packet.js';
import { normalizeAbsolutePath } from '../core/roots.js';
import { AgentSelectionError, selectAgents } from '../agents/plan.js';
import { doctorAgents } from '../agents/doctor.js';
import { AGENT_NEXT_COMMAND_BUILDERS } from '../agents/next-commands.js';
import {
  agentFindings, integrationOf, manualStepsOf, publicFile, skillsSummary, snapshotOf, userScopeOf,
} from '../agents/report.js';
import { setupAgents } from '../agents/setup.js';
import { DEFAULT_SOURCE_ROOT } from '../store/doctrine-install.js';
import { discoverRoots } from '../store/roots.js';
import { knownCommandsOf, rootArgsOf } from './authoring.js';

function resolve({ context, input }) {
  let roots;
  try {
    roots = discoverRoots({ cwd: context.cwd, repositoryRoot: input.flags['--root'], workflowRoot: input.flags['--workflow-root'] });
  } catch (error) {
    if (error instanceof TypeError) throw new CliUsageError(error.message);
    throw error;
  }
  const packageRoot = context.package_root ?? DEFAULT_SOURCE_ROOT;
  return {
    roots,
    packageRoot,
    sourceRoot: context.source_root ?? packageRoot,
    rootArgs: rootArgsOf(input.flags),
    agents: input.flags['--agent'] ?? [],
    piMcp: input.flags['--pi-mcp'] === true,
  };
}

const guarded = async (work) => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AgentSelectionError) throw new CliUsageError(error.message);
    throw error;
  }
};

export async function createAgentsSetupPacket(parameters) {
  const { context, input, manifest, providers } = parameters;
  const { roots, packageRoot, sourceRoot, rootArgs, agents, piMcp } = resolve(parameters);
  const dryRun = input.flags['--dry-run'] === true;
  const result = await guarded(() => setupAgents({
    repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root, packageRoot, sourceRoot, agents, piMcp, dryRun,
  }));
  const conflicts = result.files.filter(({ action }) => action === 'conflict');
  const status = conflicts.length > 0 ? 'warning' : result.pending.length > 0 ? 'ok' : 'noop';
  const before = snapshotOf(result.files, 'before_snapshot');
  const ids = result.agents.map(({ id }) => id);
  return createPacket({
    command: 'agents-setup',
    requestId: context.request_id ?? providers.runId(),
    status,
    root: normalizeAbsolutePath(roots.repository_root),
    snapshot: { before, after: dryRun ? before : snapshotOf(result.files, 'after_snapshot') },
    data: {
      kind: 'agents_setup',
      dry_run: dryRun,
      applied: result.applied,
      agents: ids,
      files: result.files.map(publicFile),
      conflicts: conflicts.length,
      skills: skillsSummary(result.skills),
      integration: Object.fromEntries(result.agents.map((agent) => [agent.id, integrationOf(agent, result.files)])),
      user_scope: userScopeOf(result.agents, result.launch, { piMcp }),
      manual_steps: manualStepsOf(result.agents, { piMcp }),
    },
    findings: agentFindings({ files: result.files, agents: result.agents, rootArgs, repair: false, piMcp }),
    changed: result.written,
    nextCommands: AGENT_NEXT_COMMAND_BUILDERS['agents-setup']({ phase: 'verify', agents: agents.length === 0 ? [] : ids, piMcp, rootArgs }),
    providers,
    knownCommands: knownCommandsOf(manifest),
  });
}

export async function createAgentsDoctorPacket(parameters) {
  const { manifest, providers } = parameters;
  const { roots, packageRoot, sourceRoot, rootArgs, agents, piMcp } = resolve(parameters);
  const report = await guarded(() => doctorAgents({
    repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root, packageRoot, sourceRoot, agents, piMcp, rootArgs,
  }));
  const repair = report.repairAgents.length === 0
    ? AGENT_NEXT_COMMAND_BUILDERS['agents-doctor']({ phase: 'none' })
    : AGENT_NEXT_COMMAND_BUILDERS['agents-doctor']({ phase: 'repair', agents: report.repairAgents, piMcp, rootArgs });
  return createPacket({
    command: 'agents-doctor',
    status: report.status,
    root: normalizeAbsolutePath(roots.repository_root),
    snapshot: report.snapshot,
    data: report.data,
    findings: report.findings,
    nextCommands: repair,
    providers,
    knownCommands: knownCommandsOf(manifest),
  });
}

export async function createAgentsListPacket(parameters) {
  const { manifest, providers } = parameters;
  const { roots, rootArgs, agents } = resolve(parameters);
  const selected = await guarded(async () => selectAgents(agents));
  const empty = snapshotOf([], 'before_snapshot');
  return createPacket({
    command: 'agents-list',
    status: 'ok',
    root: normalizeAbsolutePath(roots.repository_root),
    snapshot: { before: empty, after: empty },
    data: { kind: 'agents_list', agents: JSON.parse(JSON.stringify(selected)) },
    nextCommands: AGENT_NEXT_COMMAND_BUILDERS['agents-list']({ phase: 'default', rootArgs }),
    providers,
    knownCommands: knownCommandsOf(manifest),
  });
}
