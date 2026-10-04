// Proposal validation: the full proposed state is judged BEFORE any write. A Road is judged against the closed
// input schema, then against every other Road and Plan (identities, dependencies, cycles) and against the
// repository (path safety and case, read windows). A Task is judged against its Road. Every problem is reported at
// once as a finding with an RFC 6901 pointer; any error means the caller writes nothing.
import { foldKey } from '../../schemas/artifact-kit.js';
import { compareStrings } from '../../schemas/common.js';
import { compareFindings, validateFinding } from '../../schemas/finding.js';
import { SCHEMA_VIOLATION_CODES, findingsForSchemaIssues } from '../../schemas/index.js';
import { toJsonPointer } from '../../schemas/primitives.js';
import { ROAD_SCHEMA, TASK_SCHEMA, validateRoad, validateTaskInput } from '../../schemas/road.js';
import { findMissingInputs } from '../../schemas/templates.js';
import { analyzeDependencyCycles } from '../../validation/graph.js';
import { PathSafetyError, createPathService } from '../path-service.js';
import { inRepository, roadPath, taskPath } from './paths.js';
import { AUTHORING_FINDING_CODES, TASK_DIRECTORY } from './policy.js';
import { projectReadWindows } from './read-windows.js';
import {
  RoadStoreError, buildStoredRoad, collectIdentities, readRoad, readRoadGraph, renderRoad, workflowOption,
} from './repository.js';
import { renderTaskScaffold } from './task.js';

const finding = ({ code, message, file, detail, severity = 'error' }) => ({ code, severity, message, file, line: null, detail });
const at = (pointer) => (pointer === '' ? '/' : pointer);
const sorted = (findings) => {
  for (const entry of findings) {
    const verdict = validateFinding(entry);
    if (!verdict.ok) throw new TypeError(`authoring finding is invalid: ${JSON.stringify(verdict.issues)}`);
  }
  return [...findings].sort(compareFindings);
};

// ---- input channel findings (AKRS-C008) ------------------------------------------------------------------------
export function channelFindings(schemaId, issues, file = null) {
  return sorted(issues.map(({ path, code, message }) => {
    const pointer = toJsonPointer(path);
    return finding({
      code: SCHEMA_VIOLATION_CODES.input,
      message: `${schemaId}: ${message} (at ${at(pointer)})`,
      file,
      detail: { schema: schemaId, pointer, issue: `${code}: ${message}` },
    });
  }));
}

// ---- schema stage ----------------------------------------------------------------------------------------------
function schemaStage(schemaId, issues, document, kind, file) {
  if (issues.length === 0) return null;
  return {
    ok: false,
    kind: 'usage',
    reason: 'invalid_input',
    schema: schemaId,
    findings: sorted(findingsForSchemaIssues(schemaId, issues, { file })),
    missing_inputs: findMissingInputs(kind, document),
  };
}

export function validateRoadDocument(document, { workflowRelative = 'akrs', file = null } = {}) {
  const issues = validateRoad(document, { form: 'input', workflowRoot: workflowRelative === '' ? undefined : workflowRelative }).issues;
  return schemaStage(ROAD_SCHEMA, issues, document, 'road', file) ?? { ok: true, findings: [], missing_inputs: [] };
}

export function validateTaskDocument(document, { file = null } = {}) {
  return schemaStage(TASK_SCHEMA, validateTaskInput(document).issues, document, 'task', file) ?? { ok: true, findings: [], missing_inputs: [] };
}

// ---- Road ------------------------------------------------------------------------------------------------------
const EXPLANATIONS = {
  case_mismatch: 'differs in case from the file system entry',
  missing: 'does not exist',
  not_file: 'is a directory, but a read window needs a file',
  not_text: 'is not UTF-8 text, so it has no lines',
  unsafe: 'is not a safe repository path (it resolves outside the repository)',
};

function unresolved(pointer, path, reason, file, lineCount = null, what = 'Path') {
  const explanation = reason === 'out_of_range'
    ? `has ${lineCount} lines, so the declared window ends past the last line`
    : EXPLANATIONS[reason];
  return finding({
    code: AUTHORING_FINDING_CODES.unresolved_path,
    message: `${what} ${path} ${explanation} (at ${pointer}).`,
    file,
    detail: { pointer, path, reason, line_count: lineCount },
  });
}

// A literal path, or the directory part of a glob up to the first segment with a wildcard.
function checkablePath(path) {
  const segments = path.split('/');
  const cut = segments.findIndex((segment) => /[*?]/.test(segment));
  const literal = cut === -1 ? segments : segments.slice(0, cut);
  return literal.join('/');
}

export async function declaredPathFindings(service, document, file) {
  const entries = [
    ...document.writes.map(({ path }, index) => [path, `/writes/${index}/path`]),
    ...document.forbidden.map((path, index) => [path, `/forbidden/${index}`]),
    ...(document.on_landing === null ? [] : [[document.on_landing, '/on_landing']]),
  ];
  const findings = [];
  for (const [path, pointer] of entries) {
    const literal = checkablePath(path);
    if (literal === '') continue;
    try {
      const resolved = await service.resolveRepositoryPath(literal);
      if (!resolved.case_matches) findings.push(unresolved(pointer, path, 'case_mismatch', file));
    } catch (error) {
      if (!(error instanceof PathSafetyError)) throw error;
      findings.push(unresolved(pointer, path, 'unsafe', file));
    }
  }
  return findings;
}

export async function readWindowFindings(options, document, file) {
  const windows = await projectReadWindows({ ...options, road: document });
  const findings = [];
  for (const window of windows) {
    const { status } = window;
    if (status === 'ok' || status === 'own_write') continue;
    if (status === 'missing' && window.lines === null) continue; // a whole-file read may name a file created later
    const pointer = status === 'out_of_range' ? `/reads/${window.index}/lines` : `/reads/${window.index}/path`;
    findings.push(unresolved(pointer, window.path, status, file, status === 'out_of_range' ? window.line_count : null, 'Read'));
  }
  return findings;
}

export async function validateRoadProposal({ repositoryRoot, workflowRoot, document, file = null }) {
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const workflowRelative = service.workflow_relative_path;
  const schema = validateRoadDocument(document, { workflowRelative, file });
  if (!schema.ok) return schema;

  const workflowPath = roadPath(document);
  const path = inRepository(workflowRelative, workflowPath);
  const identities = await collectIdentities({ repositoryRoot, workflowRoot });
  const findings = [];
  const folded = foldKey(document.id);

  // identity: one namespace for Roads and Plans, folded
  const clashes = identities.filter(({ id }) => foldKey(id) === folded);
  const duplicate = clashes.length > 0;
  if (duplicate) {
    findings.push(finding({
      code: 'AKRS-R001',
      message: `Duplicate Road identity "${document.id}": it is already used (at /id).`,
      file,
      detail: { road_id: document.id, conflicting_files: [...new Set([...clashes.map((entry) => entry.path), path])].sort(compareStrings) },
    }));
  }

  // plan reference: a Road ID is not a Plan ID
  if (document.plan !== null) {
    const named = identities.find(({ id, kind }) => kind === 'road' && foldKey(id) === foldKey(document.plan));
    if (named !== undefined) {
      findings.push(finding({
        code: AUTHORING_FINDING_CODES.binding,
        message: `The plan "${document.plan}" is the ID of a Road; Plan and Road IDs share one namespace (at /plan).`,
        file,
        detail: { pointer: '/plan', reason: 'plan_names_a_road', subject: document.plan, expected: null, actual: named.path },
      }));
    }
  }

  // dependencies and cycles through the new Road
  const graph = await readRoadGraph({ repositoryRoot, workflowRoot });
  const known = new Set(graph.nodes.map(({ id }) => id));
  document.deps.forEach((dependency, index) => {
    if (known.has(dependency)) return;
    findings.push(finding({
      code: 'AKRS-R005',
      message: `Road dependency "${dependency}" does not exist (at /deps/${index}).`,
      file,
      detail: { road_id: document.id, dependency, status: 'QUEUED' },
    }));
  });
  if (!duplicate) {
    const roads = [...graph.nodes.map(({ id, path: nodePath, deps }) => ({ id, file: nodePath, line: null, deps, status: null })),
      { id: document.id, file, line: null, deps: [...document.deps], status: 'QUEUED' }];
    const byId = new Map(roads.map((road) => [road.id, road]));
    for (const cycle of analyzeDependencyCycles(roads, byId).findings) {
      if (!cycle.detail.cycle.includes(document.id)) continue;
      findings.push(finding({
        code: 'AKRS-R006',
        message: `Road dependency cycle: ${cycle.detail.cycle.join(' -> ')} (at /deps).`,
        file,
        detail: { cycle: cycle.detail.cycle },
      }));
    }
  }

  findings.push(...await declaredPathFindings(service, document, file));
  findings.push(...await readWindowFindings({ repositoryRoot, workflowRoot }, document, file));

  const warnings = graph.problems.map(({ path: problemPath, reason }) => finding({
    code: 'AKRS-C005',
    severity: 'warning',
    message: `The Road graph is incomplete: ${problemPath} cannot give its dependencies (${reason}).`,
    file: problemPath,
    detail: { check: 'road-graph', error: reason },
  }));

  if (findings.length > 0) {
    return {
      ok: false, kind: 'findings', reason: 'proposal_rejected', schema: ROAD_SCHEMA, findings: sorted([...findings, ...warnings]), missing_inputs: [],
    };
  }
  const options = workflowOption(service);
  const stored = buildStoredRoad(document, options);
  return {
    ok: true, document, stored, text: renderRoad(stored, options), workflowPath, path, warnings: sorted(warnings), findings: [],
  };
}

// ---- Task ------------------------------------------------------------------------------------------------------
const binding = (pointer, reason, subject, expected, actual, message, file) => finding({
  code: AUTHORING_FINDING_CODES.binding,
  message: `${message} (at ${pointer}).`,
  file,
  detail: { pointer, reason, subject, expected, actual },
});

export async function validateTaskProposal({ repositoryRoot, workflowRoot, document, file = null }) {
  const schema = validateTaskDocument(document, { file });
  if (!schema.ok) return schema;
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const findings = [];

  let found = null;
  try {
    found = await readRoad({ repositoryRoot, workflowRoot, id: document.road });
  } catch (error) {
    if (!(error instanceof RoadStoreError)) throw error;
    if (error.code === 'ambiguous') {
      const files = (await collectIdentities({ repositoryRoot, workflowRoot }))
        .filter(({ id, kind }) => kind === 'road' && id === document.road).map(({ path }) => path).sort(compareStrings);
      findings.push(finding({
        code: 'AKRS-R001',
        message: `Duplicate Road identity "${document.road}": the Task cannot name one Road (at /road).`,
        file,
        detail: { road_id: document.road, conflicting_files: files },
      }));
    } else {
      findings.push(binding('/road', 'road_unreadable', document.road, null, error.path,
        `The Road ${document.road} cannot be read (${error.message})`, file));
    }
  }
  if (findings.length === 0 && found === null) {
    findings.push(binding('/road', 'road_missing', document.road, null, null, `No Road ${document.road} exists; create it before its Task`, file));
  } else if (found !== null) {
    const declaredTask = typeof found.road.task === 'string' ? found.road.task : null;
    const declaredPlan = typeof found.road.plan === 'string' ? found.road.plan : null;
    if (declaredTask === null) {
      findings.push(binding('/id', 'road_declares_no_task', document.road, null, document.id,
        `The Road ${document.road} declares no Task, so it has none to scaffold`, file));
    } else if (declaredTask !== document.id) {
      findings.push(binding('/id', 'task_id_mismatch', document.road, declaredTask, document.id,
        `The Road ${document.road} declares the Task ${declaredTask}, not ${document.id}`, file));
    }
    if (declaredPlan !== document.plan) {
      findings.push(binding('/plan', 'plan_mismatch', document.road, declaredPlan, document.plan,
        `The Road ${document.road} belongs to ${declaredPlan === null ? 'no Plan' : `the Plan ${declaredPlan}`}, not ${document.plan === null ? 'no Plan' : document.plan}`, file));
    }
  }

  const prefix = inRepository(service.workflow_relative_path, `${TASK_DIRECTORY}/`);
  const twin = (await service.walkWorkflowFiles(TASK_DIRECTORY))
    .find((path) => path.endsWith('.md') && !path.slice(prefix.length).includes('/')
      && foldKey(path.slice(prefix.length, -'.md'.length)) === foldKey(document.id));
  if (twin !== undefined) {
    findings.push(binding('/id', 'task_exists', document.id, null, twin, `A Task file already exists for ${document.id} and is never overwritten`, file));
  }

  if (findings.length > 0) {
    return {
      ok: false, kind: 'findings', reason: 'proposal_rejected', schema: TASK_SCHEMA, findings: sorted(findings), missing_inputs: [],
    };
  }
  const workflowPath = taskPath(document.id);
  return {
    ok: true,
    document,
    text: renderTaskScaffold(document, { roadPath: found.path }),
    workflowPath,
    path: inRepository(service.workflow_relative_path, workflowPath),
    road: { id: found.road.id, path: found.path, meta_state: found.meta_state },
    warnings: [],
    findings: [],
  };
}
