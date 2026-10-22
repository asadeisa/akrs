// P2-W17: the human and prompt renderings of the desktop-readiness packets (projects add|remove|list, status --all-projects, view, watch). A
// rendering is a pure projection of the exact `--json` packet it is given: it reads no file, applies no rule and invents nothing. Project names
// are user text, so they are always shown as quoted data.
import { validatePacket } from '../schemas/packet.js';
import {
  validateProjectsAdd, validateProjectsList, validateProjectsRemove, validateStatusAllProjects, validateViewData, validateWatchData,
} from '../schemas/desktop.js';
import { ContractValidationError } from '../schemas/validation.js';
import { commandText } from './command-text.js';

const KINDS = {
  projects_add: ['projects-add', validateProjectsAdd],
  projects_remove: ['projects-remove', validateProjectsRemove],
  projects_list: ['projects-list', validateProjectsList],
  status_all_projects: ['status', validateStatusAllProjects],
  view: ['view', validateViewData],
  watch: ['watch', validateWatchData],
};

export const isDesktopPacket = (packet) => {
  const entry = KINDS[packet.data?.kind];
  return entry !== undefined && entry[0] === packet.command;
};

const quoted = (text) => JSON.stringify(text);
const projectLine = (project) => `${project.root} (workflow ${project.workflow}, name ${quoted(project.name)}, added ${project.added_at})`;

function bodyOf(data) {
  switch (data.kind) {
    case 'projects_add':
      return [
        `- registry: ${data.config_root}${data.dry_run ? ' (dry run: nothing written)' : ''}`,
        `- outcome: ${data.outcome}${data.reason === null ? '' : ` (${data.reason})`}`,
        ...(data.project === null ? [`- requested: ${data.requested}`] : [`- project: ${projectLine(data.project)}`]),
        `- ${data.count} project${data.count === 1 ? '' : 's'} registered`,
      ];
    case 'projects_remove':
      return [
        `- registry: ${data.config_root}${data.dry_run ? ' (dry run: nothing written)' : ''}`,
        `- outcome: ${data.outcome}`,
        ...(data.project === null ? [`- query: ${quoted(data.query)}`] : [`- removed: ${projectLine(data.project)} (the project itself is untouched)`]),
        `- ${data.count} project${data.count === 1 ? '' : 's'} remain`,
      ];
    case 'projects_list':
      return [
        `- registry: ${data.config_root} (${data.registry})`,
        ...(data.projects.length === 0 ? ['- no project is registered'] : data.projects.map((project) => `- ${projectLine(project)}`)),
      ];
    case 'status_all_projects': {
      const lines = [`- registry: ${data.config_root} (${data.registry})`];
      if (data.projects.length === 0) lines.push('- no project is registered');
      for (const project of data.projects) {
        lines.push(`- ${project.root} ${quoted(project.name)}: ${project.state}${project.message === null ? '' : ` (${project.message})`}`);
        if (project.status !== null) {
          const { roads } = project.status;
          lines.push(`    Roads ${roads.total}: ACTIVE ${roads.by_status.ACTIVE}, QUEUED ${roads.by_status.QUEUED}, DONE ${roads.by_status.DONE}; ready ${roads.ready.length}, blocked ${roads.blocked.length}, needs split ${roads.needs_split.length}`);
          for (const plan of project.status.plans) lines.push(`    Plan ${plan.id}: ${plan.roads.done}/${plan.roads.total} Roads DONE, Tester ${plan.tester.state}, closure ${plan.closure}`);
          lines.push(`    leases ${project.status.leases.length}, pending scope requests ${project.status.scope.pending.length}`);
        }
      }
      return lines;
    }
    case 'view':
      return [
        `- ${data.outcome === 'written' ? 'wrote' : 'kept'} ${data.path} (${data.bytes} bytes, ${data.sha256})`,
        `- ${data.nodes} nodes, ${data.edges} edges; open the file in a browser (it is self-contained: no network, no server)`,
      ];
    case 'watch':
      return [
        `- ended: ${data.ended}; ${data.ops} operation${data.ops === 1 ? '' : 's'} and ${data.changes} change${data.changes === 1 ? '' : 's'} reported`,
        `- resume cursor: ${data.cursor ?? 'none'}; workflow snapshot ${data.snapshot}`,
      ];
    default:
      throw new TypeError(`not a desktop packet: ${String(data.kind)}`);
  }
}

function render(packet, { knownCommands, commandTokens } = {}, format) {
  const envelope = validatePacket(packet, { knownCommands });
  if (!envelope.ok) throw new ContractValidationError('packet', envelope.issues);
  const body = KINDS[packet.data.kind][1](packet.data);
  if (!body.ok) throw new ContractValidationError(packet.command, body.issues);
  const fenced = format === 'prompt';
  const lines = [
    fenced ? `# AKRS ${packet.command}` : `AKRS ${packet.command} [${packet.status}]`,
    ...(fenced ? [] : [`Root: ${packet.root}`]),
    '',
    ...bodyOf(packet.data),
  ];
  if (packet.findings.length > 0) {
    lines.push('', fenced ? '## Findings' : 'Findings:', ...packet.findings.map((finding) => (fenced
      ? `- **${finding.severity.toUpperCase()} ${finding.code}** — ${finding.message}`
      : `  ${finding.severity.toUpperCase()} ${finding.code} — ${finding.message}`)));
  }
  if (packet.next_commands.length > 0) lines.push('', fenced ? '## Next commands' : 'Next commands:', ...packet.next_commands.map((command) => (fenced ? `- \`${commandText(command, commandTokens)}\`` : `  ${commandText(command, commandTokens)}`)));
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

export const renderDesktopHuman = (packet, context) => render(packet, context, 'human');
export const renderDesktopPrompt = (packet, context) => render(packet, context, 'prompt');
