import { existsSync, statSync } from 'node:fs';
import { getFindingDefinition } from '../findings/catalog.js';
import { createPacket } from '../core/packet.js';
import { CliUsageError, WorkflowNotFoundError } from '../core/errors.js';
import { discoverRoots } from '../store/roots.js';
import { ContractValidationError } from '../schemas/validation.js';
import { runCanonicalChecks, VALIDATION_CHECK_MANIFEST } from '../validation/canonical.js';
import { aggregateCoverage, validateValidationData } from '../validation/coverage.js';
import { EMPTY_SNAPSHOT } from '../store/snapshots/projections.js';
import { captureReadSnapshot } from '../store/snapshots/engine.js';

function packetStatus(checks, findings) {
  if (findings.some(({ severity }) => severity === 'error')) return 'error';
  if (findings.length > 0 || checks.some(({ status }) => status === 'skipped')) return 'warning';
  return 'ok';
}

export { VALIDATION_CHECK_MANIFEST };

function validateDirectory(workflowRoot) {
  if (!existsSync(workflowRoot) || !statSync(workflowRoot).isDirectory()) {
    throw new WorkflowNotFoundError(workflowRoot);
  }
}

export async function validateWorkflow({ repositoryRoot, workflowRoot, providers, knownCommands }) {
  validateDirectory(workflowRoot);
  // One stable capture of the declared inputs; an unstable capture (files kept changing) reports null/null.
  const capture = await captureReadSnapshot('validate', { repositoryRoot, workflowRoot });
  const outcomes = await runCanonicalChecks({ repositoryRoot, workflowRoot });
  const checks = outcomes.map(({ result }) => result);
  const findings = outcomes.flatMap((outcome) => outcome.findings);
  const data = {
    kind: 'validation',
    legacy_characterization: false,
    coverage: aggregateCoverage(checks),
    checks,
  };
  const validation = validateValidationData(data);
  if (!validation.ok) throw new ContractValidationError('validation data', validation.issues);

  return createPacket({
    command: 'validate',
    status: packetStatus(checks, findings),
    root: repositoryRoot,
    snapshot: { before: capture.snapshot.before, after: capture.snapshot.after },
    data,
    findings,
    providers,
    knownCommands,
  });
}

function resolveValidationRoots({ context, input }) {
  const repositoryRoot = input.flags['--root'];
  const workflowRoot = input.flags['--workflow-root'];
  try {
    return discoverRoots({
      cwd: context.cwd,
      repositoryRoot,
      workflowRoot,
    });
  } catch (error) {
    if (workflowRoot !== undefined) throw new WorkflowNotFoundError(workflowRoot);
    if (error instanceof TypeError) throw new CliUsageError(error.message);
    throw error;
  }
}

export async function createValidationPacket({ context, input, manifest, providers }) {
  const roots = resolveValidationRoots({ context, input });
  return validateWorkflow({
    repositoryRoot: roots.repository_root,
    workflowRoot: roots.workflow_root,
    providers,
    knownCommands: manifest.commands.map(({ id }) => id),
  });
}

export function createExplainPacket({ context, input, manifest, providers }) {
  const code = input.positionals.code;
  const definition = getFindingDefinition(code);
  if (definition === null) throw new CliUsageError(`unknown finding code: ${code}`);
  return createPacket({
    command: 'explain',
    status: 'ok',
    root: context.repository_root,
    snapshot: { before: EMPTY_SNAPSHOT, after: EMPTY_SNAPSHOT },
    data: { kind: 'finding_explanation', finding: definition },
    providers,
    knownCommands: manifest.commands.map(({ id }) => id),
  });
}
