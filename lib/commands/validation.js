import { existsSync, statSync } from 'node:fs';
import { getFindingDefinition } from '../findings/catalog.js';
import { createPacket } from '../core/packet.js';
import { CliUsageError, WorkflowNotFoundError } from '../core/errors.js';
import { createPathService, PathSafetyError } from '../store/path-service.js';
import { discoverRoots } from '../store/roots.js';
import { ContractValidationError } from '../schemas/validation.js';
import {
  aggregateCoverage,
  runCoveredCheck,
  validateValidationData,
} from '../validation/coverage.js';
import {
  analyzeDependencyCycles,
  analyzeDependencyReadiness,
  analyzeDependencyReferences,
  registerRoadIdentities,
} from '../validation/graph.js';
import { loadLegacyRoads } from '../validation/legacy-roads.js';
import { EMPTY_SNAPSHOT } from '../store/snapshots/projections.js';
import { captureReadSnapshot } from '../store/snapshots/engine.js';

export const VALIDATION_CHECK_MANIFEST = Object.freeze([
  Object.freeze({ id: 'road-identities', legacy_derived: true }),
  Object.freeze({ id: 'road-statuses', legacy_derived: true }),
  Object.freeze({ id: 'legacy-expected-files', legacy_derived: true }),
  Object.freeze({ id: 'dependency-references', legacy_derived: true }),
  Object.freeze({ id: 'dependency-cycles', legacy_derived: true }),
  Object.freeze({ id: 'dependency-readiness', legacy_derived: true }),
]);

function roadFinding(road, code, message, detail, severity = 'error') {
  return {
    code,
    severity,
    message,
    file: road.file,
    line: road.line,
    detail,
  };
}

function packetStatus(checks, findings) {
  if (findings.some(({ severity }) => severity === 'error')) return 'error';
  if (findings.length > 0 || checks.some(({ status }) => status === 'skipped')) return 'warning';
  return 'ok';
}

function validateDirectory(workflowRoot) {
  if (!existsSync(workflowRoot) || !statSync(workflowRoot).isDirectory()) {
    throw new WorkflowNotFoundError(workflowRoot);
  }
}

export async function validateWorkflow({ repositoryRoot, workflowRoot, providers, knownCommands }) {
  validateDirectory(workflowRoot);
  // One stable capture of the declared inputs; an unstable capture (files kept changing) reports null/null.
  const capture = await captureReadSnapshot('validate', { repositoryRoot, workflowRoot });
  const paths = await createPathService({ repositoryRoot, workflowRoot });
  const roads = await loadLegacyRoads({ pathService: paths });
  const outcomes = [];

  const identities = await runCoveredCheck({
    id: 'road-identities',
    applicable: true,
    required: true,
    emptyReason: 'no Road files were available for identity registration',
    run: async ({ examined }) => {
      examined(roads.length);
      return registerRoadIdentities(roads).findings;
    },
  });
  outcomes.push(identities);
  const registry = registerRoadIdentities(roads);

  outcomes.push(await runCoveredCheck({
    id: 'road-statuses',
    applicable: true,
    required: true,
    emptyReason: 'no readable Road status inputs were available',
    run: async ({ examined, incomplete }) => {
      const findings = [];
      for (const road of roads) {
        if (!road.readable) {
          incomplete(`Road input could not be read: ${road.file}`);
          continue;
        }
        examined();
        if (road.status === null) {
          findings.push(roadFinding(
            road,
            'AKRS-R002',
            'Road has no Status line.',
            { road_id: road.id },
          ));
        } else if (!road.status_legal) {
          findings.push(roadFinding(
            road,
            'AKRS-R003',
            `Road has illegal Status "${road.status_raw}".`,
            { road_id: road.id, status: road.status_raw },
          ));
        }
      }
      return findings;
    },
  }));

  const expectedRoads = roads.filter(({ status }) => status === 'ACTIVE' || status === 'DONE');
  outcomes.push(await runCoveredCheck({
    id: 'legacy-expected-files',
    applicable: expectedRoads.length > 0,
    required: true,
    emptyReason: 'required Expected files input was not readable by the legacy parser',
    notApplicableReason: 'no ACTIVE or DONE legacy Road requires Expected files validation',
    run: async ({ examined, incomplete }) => {
      const findings = [];
      for (const road of expectedRoads) {
        if (!road.readable || road.expected.length === 0) {
          incomplete('required Expected files input was not readable by the legacy parser');
          findings.push(roadFinding(
            road,
            'AKRS-R004',
            'Expected files check skipped for unreadable legacy input.',
            { road_id: road.id, parser: 'legacy-bullet-list' },
            'warning',
          ));
          continue;
        }
        for (const expectedPath of road.expected) {
          examined();
          let resolvedPath;
          try {
            resolvedPath = await paths.resolveRepositoryPath(expectedPath);
          } catch (error) {
            if (!(error instanceof PathSafetyError)) throw error;
            findings.push(roadFinding(
              road,
              'AKRS-R010',
              `Road Expected path is unsafe: ${expectedPath}.`,
              { road_id: road.id, expected_path: expectedPath, reason: error.message },
            ));
            continue;
          }
          if (resolvedPath.findings.length > 0) {
            findings.push(...resolvedPath.findings);
            continue;
          }
          if (resolvedPath.exists) continue;
          const done = road.status === 'DONE';
          findings.push(roadFinding(
            road,
            done ? 'AKRS-R009' : 'AKRS-R008',
            `${road.status} Road Expected path is missing: ${expectedPath}.`,
            { road_id: road.id, expected_path: expectedPath, status: road.status },
            done ? 'error' : 'warning',
          ));
        }
      }
      return findings;
    },
  }));

  const graphCheck = async (id, analyze) => runCoveredCheck({
    id,
    applicable: true,
    required: true,
    emptyReason: 'no Road inputs were available for dependency analysis',
    run: async ({ examined, incomplete }) => {
      if (!registry.ok) {
        incomplete('duplicate Road identities prevent unambiguous dependency analysis');
        return [];
      }
      const result = analyze(roads, registry.by_id);
      examined(result.examined_count);
      return result.findings;
    },
  });
  outcomes.push(await graphCheck('dependency-references', analyzeDependencyReferences));
  outcomes.push(await graphCheck('dependency-cycles', analyzeDependencyCycles));

  const readinessRoads = roads.filter(({ status, deps }) => status === 'ACTIVE' && deps.length > 0);
  outcomes.push(await runCoveredCheck({
    id: 'dependency-readiness',
    applicable: readinessRoads.length > 0,
    required: true,
    notApplicableReason: 'no ACTIVE Road declares dependencies',
    run: async ({ examined, incomplete }) => {
      if (!registry.ok) {
        incomplete('duplicate Road identities prevent unambiguous readiness analysis');
        return [];
      }
      const result = analyzeDependencyReadiness(roads, registry.by_id);
      examined(result.examined_count);
      return result.findings;
    },
  }));

  const checks = outcomes.map(({ result }) => result);
  const findings = outcomes.flatMap((outcome) => outcome.findings);
  const data = {
    kind: 'validation',
    legacy_characterization: true,
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
