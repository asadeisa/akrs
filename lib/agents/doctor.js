// `agents doctor` (F20): a query that classifies every file setup manages and says, per agent, what it can and cannot do.
import { planAgents } from './plan.js';
import {
  agentFindings, countsOf, filesOf, integrationOf, notesOf, publicFile, skillsSummary, snapshotOf, summaryOf, surfacesOf,
} from './report.js';

export const agentReport = (agent, files, { piMcp }) => {
  const own = filesOf(agent.id, files);
  const integration = integrationOf(agent, files);
  return {
    id: agent.id,
    label: agent.label,
    state: own.every(({ state }) => state === 'current') ? 'ok' : 'attention',
    integration,
    summary: summaryOf(integration),
    surfaces: surfacesOf(agent, files, { piMcp }),
    notes: notesOf(agent),
    files: own.map(({ path }) => path),
  };
};

// -> { status, data, findings, snapshot, repairAgents } ; repairAgents are the agents `setup` can repair
export async function doctorAgents({
  repositoryRoot, workflowRoot, packageRoot, sourceRoot, agents, piMcp = false, rootArgs = [],
}) {
  const plan = await planAgents({ repositoryRoot, workflowRoot, packageRoot, sourceRoot, agents, piMcp });
  const findings = agentFindings({ files: plan.files, agents: plan.agents, rootArgs, repair: true, piMcp });
  const repairable = plan.files.filter(({ state }) => state === 'missing' || state === 'outdated');
  const ids = plan.agents.map(({ id }) => id).filter((id) => repairable.some((file) => file.agents.includes(id)));
  const snapshot = snapshotOf(plan.files, 'before_snapshot');
  return {
    status: findings.length === 0 ? 'ok' : 'warning',
    data: {
      kind: 'agents_doctor',
      agents: plan.agents.map((agent) => agentReport(agent, plan.files, { piMcp })),
      files: plan.files.map(publicFile),
      counts: countsOf(plan.files),
      skills: skillsSummary(plan.skills),
    },
    findings,
    snapshot: { before: snapshot, after: snapshot },
    repairAgents: ids,
  };
}
