// Handlers of `audit --git --road` and `doctor` (P1-W12). Both are queries: they read git and the Road, never write.
import { CliUsageError } from '../core/errors.js';
import { createPacket } from '../core/packet.js';
import { isId } from '../schemas/common.js';
import { auditRoad, postureFinding, readPosture } from '../store/git/index.js';
import { buildHealth } from '../store/navigation/health.js';
import { EMPTY_SNAPSHOT } from '../store/snapshots/projections.js';
import { commandSnapshot } from '../store/snapshots/index.js';
import { knownCommandsOf, resolveRoots } from './authoring.js';

export async function createAuditPacket(parameters) {
  const { input, manifest, providers } = parameters;
  const roots = resolveRoots(parameters);
  const { flags } = input;
  if (flags['--git'] !== true) throw new CliUsageError('audit needs --git (the only audit there is): akrs audit --git --road <id>');
  const road = flags['--road'];
  if (road === undefined) throw new CliUsageError('audit needs --road <id>');
  if (!isId(road)) throw new CliUsageError('--road takes a Road ID');
  const preExisting = flags['--pre-existing'] === undefined ? [] : [].concat(flags['--pre-existing']);
  const options = { repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root };
  const report = await auditRoad({ ...options, road, preExisting });
  if (report.problem === 'road_missing') throw new CliUsageError(`audit: no Road ${road} exists`);
  if (report.problem !== undefined) throw new CliUsageError(`audit: Road ${road} does not verify, so its declarations cannot be trusted`);
  const { snapshot } = await commandSnapshot('audit', { ...options, target: { road } });
  return createPacket({
    command: 'audit',
    status: report.findings.length > 0 ? 'warning' : 'ok',
    root: roots.repository_root,
    snapshot: { before: snapshot, after: snapshot },
    data: { kind: 'audit', audit: report.audit },
    findings: report.findings,
    providers,
    knownCommands: knownCommandsOf(manifest),
  });
}

export async function createDoctorPacket(parameters) {
  const { manifest, providers } = parameters;
  const roots = resolveRoots(parameters);
  const options = { repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root };
  const posture = await readPosture(options);
  const findings = posture.posture === 'tracked' ? [] : [postureFinding(posture)];
  const health = await buildHealth(options);
  return createPacket({
    command: 'doctor',
    status: findings.length > 0 || health.some(({ status }) => status === 'warning' || status === 'error') ? 'warning' : 'ok',
    root: roots.repository_root,
    // The doctrine projection of the doctor row is computed by doctrine-install (P2-W09 joins it); posture reads none.
    snapshot: { before: EMPTY_SNAPSHOT, after: EMPTY_SNAPSHOT },
    data: { kind: 'doctor', doctor: { posture, health } },
    findings,
    providers,
    knownCommands: knownCommandsOf(manifest),
  });
}
