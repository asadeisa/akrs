import { validatePacket } from '../schemas/packet.js';
import { ContractValidationError } from '../schemas/validation.js';

function assertPacket(packet, knownCommands) {
  const result = validatePacket(packet, { knownCommands });
  if (!result.ok) throw new ContractValidationError('packet', result.issues);
}

function commandText({ command, args }) {
  const token = command === 'help'
    ? '--help'
    : command === 'version' ? '--version' : command;
  return ['akrs', token, ...args].join(' ');
}

function findingText(finding) {
  const location = finding.file === null
    ? ''
    : ` ${finding.file}${finding.line === null ? '' : `:${finding.line}`}`;
  return `  ${finding.severity.toUpperCase()} ${finding.code}${location} — ${finding.message}`;
}

function renderHelp(data) {
  const lines = [data.title, '', 'Usage'];
  for (const command of data.commands) {
    const formats = command.formats.length === 0 ? '' : ` [${command.formats.join('|')}]`;
    lines.push(`  ${command.invocation}${formats}`);
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

export function renderHuman(packet, { knownCommands } = {}) {
  assertPacket(packet, knownCommands);
  if (packet.data.kind === 'help') return renderHelp(packet.data);
  if (packet.data.kind === 'version') return renderVersion(packet.data);

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
    lines.push('', 'Next commands:', ...packet.next_commands.map((command) => `  ${commandText(command)}`));
  }
  return `${lines.join('\n')}\n`;
}
