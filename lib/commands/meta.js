import packageJson from '../../package.json' with { type: 'json' };
import { createPacket } from '../core/packet.js';
import { createExplainPacket, createValidationPacket } from './validation.js';

const EMPTY_SNAPSHOT = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export const VERSION_INFO = Object.freeze({
  cli_version: packageJson.version,
  doctrine_version: packageJson.version,
  packet_schema: 'akrs.packet/v2',
  event_schema: 'akrs.event/v1',
  manifest_schema: 'akrs.command-manifest/v1',
});

function basePacket({ command, root, data, providers, knownCommands }) {
  return createPacket({
    command,
    status: 'ok',
    root,
    snapshot: { before: EMPTY_SNAPSHOT, after: EMPTY_SNAPSHOT },
    data,
    providers,
    knownCommands,
  });
}

export function createHelpPacket({ context, manifest, providers }) {
  const knownCommands = manifest.commands.map(({ id }) => id);
  return basePacket({
    command: 'help',
    root: context.repository_root,
    providers,
    knownCommands,
    data: {
      kind: 'help',
      title: 'AKRS — Adaptive Knowledge Routing System',
      commands: manifest.commands.map(({ id, tokens, summary, flags, positionals }) => ({
        id,
        invocation: `akrs ${tokens.join(' ')}${positionals
          .map((positional) => ` <${positional.name}>`).join('')}`,
        summary,
        formats: flags
          .filter(({ name }) => name === '--json' || name === '--prompt')
          .map(({ name }) => name),
      })),
    },
  });
}

export function createVersionPacket({ context, manifest, providers }) {
  return basePacket({
    command: 'version',
    root: context.repository_root,
    providers,
    knownCommands: manifest.commands.map(({ id }) => id),
    data: {
      kind: 'version',
      ...VERSION_INFO,
    },
  });
}

export const commandHandlers = Object.freeze({
  help: createHelpPacket,
  version: createVersionPacket,
  validate: createValidationPacket,
  explain: createExplainPacket,
});
