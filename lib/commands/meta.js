import packageJson from '../../package.json' with { type: 'json' };
import { createPacket } from '../core/packet.js';
import { createRoadNewPacket, createTaskNewPacket, createTemplatePacket } from './authoring.js';
import {
  createRoadMovePacket, createRoadUpdatePacket, createScopeApprovePacket, createScopeListPacket, createScopeRejectPacket, createScopeRequestPacket,
} from './change.js';
import { createLogAppendPacket } from './log.js';
import { createAuditPacket, createDoctorPacket } from './audit.js';
import { createExecutorListPacket, createExecutorRemovePacket, createExecutorSetPacket, createRoadFitPacket } from './executor.js';
import { createRoadDetailsPacket } from './road-details.js';
import { createVerifyPacket } from './verify.js';
import { createTestDetailsPacket } from './test-details.js';
import { createPagePacket } from './page.js';
import { createTestRunPacket } from './test-run.js';
import {
  createLeaseReleasePacket, createRoadActivatePacket, createRoadCheckPacket, createRoadFinishPacket, createRoadReopenPacket,
} from './lifecycle.js';
import { createScaffoldPacket } from './scaffold.js';
import { createStateRenderPacket, createStateSetPacket } from './state.js';
import { createGraphPacket, createLogPacket, createNextPacket, createStalePacket, createStatusPacket, createWherePacket } from './navigation.js';
import { createPlanFinishPacket } from './plan.js';
import { createTestDefinePacket, createTestHandoffPacket, createTestResultPacket } from './tester.js';
import { createMemoryAddPacket } from './memory.js';
import { createInitPacket, createPostinstallPacket, createSyncPacket } from './install.js';
import { createExplainPacket, createValidationPacket } from './validation.js';

// Flags every command shares or that only select the output format; help lists a command's other flags.
const HELP_SHARED_FLAGS = Object.freeze(['--json', '--jsonl', '--prompt', '--root', '--workflow-root']);

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
        // the command's own flags (output formats and the root overrides every workflow command shares are left out)
        options: flags
          .filter(({ name }) => !HELP_SHARED_FLAGS.includes(name))
          .map(({ name, value_type: valueType, required }) => ({ name, value_type: valueType, required })),
        // a command with an --input channel also reads its document from stdin: `--json -`
        stdin: flags.some(({ name }) => name === '--input'),
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
  init: createInitPacket,
  sync: createSyncPacket,
  postinstall: createPostinstallPacket,
  'road-new': createRoadNewPacket,
  'task-new': createTaskNewPacket,
  'memory-add': createMemoryAddPacket,
  'log-append': createLogAppendPacket,
  'road-update': createRoadUpdatePacket,
  'road-move': createRoadMovePacket,
  'scope-request': createScopeRequestPacket,
  'scope-approve': createScopeApprovePacket,
  'scope-reject': createScopeRejectPacket,
  'scope-list': createScopeListPacket,
  'test-define': createTestDefinePacket,
  'test-handoff': createTestHandoffPacket,
  'state-set': createStateSetPacket,
  'state-render': createStateRenderPacket,
  'init-scaffold': createScaffoldPacket,
  audit: createAuditPacket,
  'executor-set': createExecutorSetPacket,
  'executor-remove': createExecutorRemovePacket,
  'executor-list': createExecutorListPacket,
  'road-fit': createRoadFitPacket,
  'road-details': createRoadDetailsPacket,
  verify: createVerifyPacket,
  'test-details': createTestDetailsPacket,
  'test-run': createTestRunPacket,
  'test-result': createTestResultPacket,
  'plan-finish': createPlanFinishPacket,
  status: createStatusPacket,
  next: createNextPacket,
  where: createWherePacket,
  graph: createGraphPacket,
  stale: createStalePacket,
  log: createLogPacket,
  page: createPagePacket,
  'road-check': createRoadCheckPacket,
  'road-activate': createRoadActivatePacket,
  'road-finish': createRoadFinishPacket,
  'road-reopen': createRoadReopenPacket,
  'lease-release': createLeaseReleasePacket,
  doctor: createDoctorPacket,
  template: createTemplatePacket,
});
