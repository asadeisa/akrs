import { validatePacket } from '../schemas/packet.js';
import { ContractValidationError } from '../schemas/validation.js';
import { commandText } from './command-text.js';
import { renderRoadDetailsHuman, renderRoadDetailsPrompt } from './road-details.js';
import { renderTestDetailsHuman, renderTestDetailsPrompt } from './test-details.js';

function assertPacket(packet, knownCommands) {
  const result = validatePacket(packet, { knownCommands });
  if (!result.ok) throw new ContractValidationError('packet', result.issues);
}

const isTestDetails = (packet) => packet.command === 'test-details' && typeof packet.data.kind === 'string' && packet.data.kind.startsWith('test_details');
const isRoadDetails = (packet) => packet.command === 'road-details' && typeof packet.data.kind === 'string' && packet.data.kind.startsWith('road_details');

function findingText(finding) {
  const location = finding.file === null
    ? ''
    : ` \`${finding.file}${finding.line === null ? '' : `:${finding.line}`}\``;
  return `- **${finding.severity.toUpperCase()} ${finding.code}**${location} — ${finding.message}`;
}

export function renderPrompt(packet, { knownCommands, commandTokens } = {}) {
  assertPacket(packet, knownCommands);
  if (isRoadDetails(packet)) return renderRoadDetailsPrompt(packet, { knownCommands, commandTokens });
  if (isTestDetails(packet)) return renderTestDetailsPrompt(packet, { knownCommands, commandTokens });
  const lines = [
    `# AKRS packet: ${packet.command}`,
    '',
    `- Status: \`${packet.status}\``,
    `- Root: \`${packet.root}\``,
    `- Run ID: \`${packet.run_id}\``,
    '',
    '## Data',
    '',
    '```json',
    JSON.stringify(packet.data, null, 2),
    '```',
  ];
  if (packet.findings.length > 0) {
    lines.push('', '## Findings', '', ...packet.findings.map(findingText));
  }
  if (packet.next_commands.length > 0) {
    lines.push(
      '',
      '## Next commands',
      '',
      ...packet.next_commands.map((command) => `- \`${commandText(command, commandTokens)}\``),
    );
  }
  return `${lines.join('\n')}\n`;
}
