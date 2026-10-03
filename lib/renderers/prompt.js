import { validatePacket } from '../schemas/packet.js';
import { ContractValidationError } from '../schemas/validation.js';

function assertPacket(packet, knownCommands) {
  const result = validatePacket(packet, { knownCommands });
  if (!result.ok) throw new ContractValidationError('packet', result.issues);
}

// `commandTokens` (command ID -> manifest tokens) makes the text pasteable: `road-new` is `akrs road new`.
function commandText({ command, args }, commandTokens) {
  const known = commandTokens?.get(command);
  if (known !== undefined) return ['akrs', ...known, ...args].join(' ');
  const token = command === 'help'
    ? '--help'
    : command === 'version' ? '--version' : command;
  return ['akrs', token, ...args].join(' ');
}

function findingText(finding) {
  const location = finding.file === null
    ? ''
    : ` \`${finding.file}${finding.line === null ? '' : `:${finding.line}`}\``;
  return `- **${finding.severity.toUpperCase()} ${finding.code}**${location} — ${finding.message}`;
}

export function renderPrompt(packet, { knownCommands, commandTokens } = {}) {
  assertPacket(packet, knownCommands);
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
