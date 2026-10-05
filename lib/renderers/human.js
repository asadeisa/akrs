import { validatePacket } from '../schemas/packet.js';
import { ContractValidationError } from '../schemas/validation.js';
import { commandText } from './command-text.js';
import { renderRoadDetailsHuman, renderRoadDetailsPrompt } from './road-details.js';
import { renderPageHuman, renderPagePrompt } from './page.js';
import { isNavigationPacket, renderNavigationHuman, renderNavigationPrompt } from './navigation.js';
import { renderTestRunHuman, renderTestRunPrompt } from './test-run.js';
import { renderTestDetailsHuman, renderTestDetailsPrompt } from './test-details.js';

function assertPacket(packet, knownCommands) {
  const result = validatePacket(packet, { knownCommands });
  if (!result.ok) throw new ContractValidationError('packet', result.issues);
}

const isTestDetails = (packet) => packet.command === 'test-details' && typeof packet.data.kind === 'string' && packet.data.kind.startsWith('test_details');
const isTestRun = (packet) => packet.command === 'test-run' && typeof packet.data.kind === 'string' && packet.data.kind.startsWith('test_run');
const isPage = (packet) => packet.command === 'page' && typeof packet.data.kind === 'string' && packet.data.kind.startsWith('page');
const isRoadDetails = (packet) => packet.command === 'road-details' && typeof packet.data.kind === 'string' && packet.data.kind.startsWith('road_details');

function findingText(finding) {
  const location = finding.file === null
    ? ''
    : ` ${finding.file}${finding.line === null ? '' : `:${finding.line}`}`;
  return `  ${finding.severity.toUpperCase()} ${finding.code}${location} — ${finding.message}`;
}

function renderHelp(data) {
  const lines = [data.title, '', 'Usage'];
  for (const command of data.commands) {
    const options = (command.options ?? []).map((option) => {
      const value = option.value_type === 'boolean' ? '' : ` <${option.value_type}>`;
      const text = command.stdin === true && option.name === '--input'
        ? `--input${value} | --json -`
        : `${option.name}${value}`;
      return option.required ? ` ${text}` : ` [${text}]`;
    }).join('');
    const formats = command.formats.length === 0 ? '' : ` [${command.formats.join('|')}]`;
    lines.push(`  ${command.invocation}${options}${formats}`);
  }
  lines.push('', 'Commands');
  const width = Math.max(...data.commands.map(({ invocation }) => invocation.length));
  for (const command of data.commands) {
    lines.push(`  ${command.invocation.padEnd(width)}  ${command.summary}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderVersion(data) {
  return [
    `AKRS CLI ${data.cli_version}`,
    `Doctrine ${data.doctrine_version}`,
    `Packet schema ${data.packet_schema}`,
    `Event schema ${data.event_schema}`,
    `Manifest schema ${data.manifest_schema}`,
    '',
  ].join('\n');
}

function renderValidation(packet) {
  const { coverage, checks } = packet.data;
  const lines = [
    `AKRS validate [${packet.status}]`,
    `Root: ${packet.root}`,
    `Coverage: ${coverage.total_checks} checks — ${coverage.passed} passed, `
      + `${coverage.failed} failed, ${coverage.skipped} skipped, `
      + `${coverage.not_applicable} not applicable`,
    `Examined: ${coverage.examined_count}; findings: ${coverage.finding_count}`,
    '',
    'Checks:',
  ];
  for (const check of checks) {
    const reason = check.reason === null ? '' : ` — ${check.reason}`;
    lines.push(`  ${check.status.toUpperCase()} ${check.check} `
      + `(examined ${check.examined_count}, findings ${check.finding_count})${reason}`);
  }
  if (packet.findings.length > 0) {
    lines.push('', 'Findings:', ...packet.findings.map(findingText));
  }
  return `${lines.join('\n')}\n`;
}

export function renderHuman(packet, { knownCommands, commandTokens } = {}) {
  assertPacket(packet, knownCommands);
  if (isRoadDetails(packet)) return renderRoadDetailsHuman(packet, { knownCommands, commandTokens });
  if (isTestDetails(packet)) return renderTestDetailsHuman(packet, { knownCommands, commandTokens });
  if (isPage(packet)) return renderPageHuman(packet, { knownCommands, commandTokens });
  if (isTestRun(packet)) return renderTestRunHuman(packet, { knownCommands, commandTokens });
  if (isNavigationPacket(packet)) return renderNavigationHuman(packet, { knownCommands, commandTokens });
  if (packet.data.kind === 'help') return renderHelp(packet.data);
  if (packet.data.kind === 'version') return renderVersion(packet.data);
  if (packet.data.kind === 'validation') return renderValidation(packet);

  const lines = [
    `AKRS ${packet.command} [${packet.status}]`,
    `Root: ${packet.root}`,
    `Run: ${packet.run_id}`,
    '',
    'Data:',
    JSON.stringify(packet.data, null, 2),
  ];
  if (packet.findings.length > 0) {
    lines.push('', 'Findings:', ...packet.findings.map(findingText));
  }
  if (packet.next_commands.length > 0) {
    lines.push('', 'Next commands:', ...packet.next_commands.map((command) => `  ${commandText(command, commandTokens)}`));
  }
  return `${lines.join('\n')}\n`;
}
