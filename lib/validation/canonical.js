// Canonical v2 validation: every check reads the CLI-written artifacts through the store readers (never Markdown),
// maps its problems to stable finding codes and reports honest coverage. Reads only.
import { basename } from 'node:path';
import { compareStrings } from '../schemas/common.js';
import { compareFindings } from '../schemas/finding.js';
import { EXECUTORS_SCHEMA } from '../schemas/executors.js';
import { findingsForSchemaIssues } from '../schemas/index.js';
import { ROAD_SCHEMA } from '../schemas/road.js';
import { STATE_SCHEMA } from '../schemas/state.js';
import { VERIFICATION_SCHEMA } from '../schemas/verification.js';
import { classFitCheck } from '../store/executors/check.js';
import { readExecutors, unclassifiedFinding } from '../store/executors/repository.js';
import { postureFinding } from '../store/git/audit.js';
import { readPosture } from '../store/git/posture.js';
import { readLog } from '../store/log/repository.js';
import { readMemory } from '../store/memory/repository.js';
import { createPathService } from '../store/path-service.js';
import { RoadStoreError, listRoadFiles, readRoadAt } from '../store/roads/repository.js';
import { declaredPathFindings, readWindowFindings } from '../store/roads/proposal.js';
import { readAllRequests, listScopeFiles } from '../store/scope/repository.js';
import { deriveState, readRenderedState, readState } from '../store/state/repository.js';
import { renderStateMarkdown } from '../store/state/render.js';
import { readVerification } from '../store/verification/repository.js';
import { runCoveredCheck } from './coverage.js';
import {
  analyzeDependencyCycles, analyzeDependencyReadiness, analyzeDependencyReferences, registerRoadIdentities,
} from './graph.js';

export const VALIDATION_CHECK_MANIFEST = Object.freeze([
  'road-integrity', 'road-identities', 'road-paths', 'done-writes-exist', 'dependency-references', 'dependency-cycles',
  'dependency-readiness', 'class-fit', 'executors', 'scope-requests', 'state', 'state-render', 'log', 'closure-consistency',
  'memory', 'verification', 'drafts', 'legacy-forms', 'git-posture',
].map((id) => Object.freeze({ id })));

const finding = ({ code, severity = 'error', message, file = null, line = null, detail }) => ({ code, severity, message, file, line, detail });
const unverified = ({ kind, path, reason, line = null, message }) => finding({
  code: 'AKRS-S007', message: message ?? `${path} is not what the CLI wrote (${reason}); it is unverified and not trusted.`, file: path, line, detail: { kind, path, reason, line },
});

// An artifact that does not verify: schema problems keep their pointers; a clean schema with a bad hash was edited by hand.
function integrity({ kind, schemaId, path, meta_state: state, issues }) {
  if (state === 'declared') return [];
  if (issues.length > 0) return findingsForSchemaIssues(schemaId, issues, { file: path });
  return [unverified({ kind, path, reason: 'hash_mismatch' })];
}

async function loadRoads({ repositoryRoot, workflowRoot }) {
  const files = await listRoadFiles({ repositoryRoot, workflowRoot });
  const entries = [];
  for (const { id, path } of files) {
    try {
      entries.push({ id, path, ...await readRoadAt({ repositoryRoot, workflowRoot, path, id }), problem: null });
    } catch (error) {
      if (!(error instanceof RoadStoreError)) throw error;
      entries.push({ id, path, road: null, meta_state: 'unverified', issues: [], problem: error.message });
    }
  }
  return entries;
}

async function verificationKeys(service) {
  const prefix = service.workflow_relative_path === '' ? '' : `${service.workflow_relative_path}/`;
  const base = `${prefix}verifications/`;
  return [...new Set((await service.walkWorkflowFiles('verifications'))
    .filter((path) => path.startsWith(base))
    .map((path) => path.slice(base.length).split('/'))
    .filter((parts) => parts.length === 2 && ['contract.json', 'handoff.jsonl'].includes(parts[1]))
    .map(([key]) => key))].sort(compareStrings);
}

// -> [{ result, findings }] in VALIDATION_CHECK_MANIFEST order.
export async function runCanonicalChecks({ repositoryRoot, workflowRoot }) {
  const options = { repositoryRoot, workflowRoot };
  const service = await createPathService(options);
  const roadEntries = await loadRoads(options);
  const declared = roadEntries.filter(({ meta_state: state }) => state === 'declared');
  const node = ({ id, path, road }) => ({ id, file: path, line: null, deps: road.deps, status: road.status });
  const graphRoads = declared.map(node);
  const fileRoads = roadEntries.map(({ id, path }) => ({ id, file: path, line: null }));
  const registry = registerRoadIdentities(fileRoads);
  const outcomes = [];
  const run = async (spec) => outcomes.push(await runCoveredCheck({ required: true, ...spec }));

  await run({
    id: 'road-integrity',
    applicable: roadEntries.length > 0,
    notApplicableReason: 'the workflow has no Road files',
    run: async ({ examined }) => {
      const findings = [];
      for (const entry of roadEntries) {
        examined();
        if (entry.problem !== null) findings.push(unverified({ kind: 'road', path: entry.path, reason: 'unreadable', message: `${entry.path} cannot be read as a Road: ${entry.problem}.` }));
        else findings.push(...integrity({ kind: 'road', schemaId: ROAD_SCHEMA, path: entry.path, meta_state: entry.meta_state, issues: entry.issues }));
      }
      return findings.sort(compareFindings);
    },
  });
  await run({
    id: 'road-identities',
    applicable: roadEntries.length > 0,
    notApplicableReason: 'the workflow has no Road files',
    run: async ({ examined }) => {
      examined(fileRoads.length);
      return registry.findings;
    },
  });
  await run({
    id: 'road-paths',
    applicable: declared.length > 0,
    notApplicableReason: 'no verified Road declares paths to resolve',
    run: async ({ examined }) => {
      const findings = [];
      for (const entry of declared) {
        examined();
        findings.push(...await declaredPathFindings(service, entry.road, entry.path));
        findings.push(...await readWindowFindings(options, entry.road, entry.path));
      }
      return findings.sort(compareFindings);
    },
  });
  const done = declared.filter(({ road }) => road.status === 'DONE');
  await run({
    id: 'done-writes-exist',
    applicable: done.length > 0,
    notApplicableReason: 'no Road is DONE',
    run: async ({ examined }) => {
      const findings = [];
      for (const { id, path, road } of done) {
        examined();
        for (const write of road.writes.filter(({ class: kind, action }) => kind === 'file' && action !== 'delete')) {
          const resolved = await service.resolveRepositoryPath(write.path);
          if (resolved.exists) continue;
          findings.push(finding({
            code: 'AKRS-R017', message: `The DONE Road ${id} declares ${write.action} of ${write.path}, which is not in the repository.`, file: path,
            detail: { road: id, path: write.path, action: write.action, status: 'DONE' },
          }));
        }
      }
      return findings.sort(compareFindings);
    },
  });
  const graph = (id, analyze, applicable = declared.length > 0, notApplicableReason = 'no verified Road exists') => run({
    id,
    applicable,
    notApplicableReason,
    run: async ({ examined, incomplete }) => {
      if (!registry.ok) {
        incomplete('duplicate Road identities prevent unambiguous dependency analysis');
        return [];
      }
      const result = analyze(graphRoads, new Map(graphRoads.map((road) => [road.id, road])));
      examined(result.examined_count);
      return result.findings;
    },
  });
  await graph('dependency-references', analyzeDependencyReferences);
  await graph('dependency-cycles', analyzeDependencyCycles);
  await graph('dependency-readiness', analyzeDependencyReadiness, graphRoads.some(({ status, deps }) => status === 'ACTIVE' && deps.length > 0), 'no ACTIVE Road declares dependencies');

  const classed = declared.filter(({ road }) => road.executor_class !== null);
  await run({
    id: 'class-fit',
    applicable: classed.length > 0,
    notApplicableReason: 'no Road declares an executor class',
    run: async ({ examined }) => {
      const findings = [];
      for (const { path, road } of classed) {
        examined();
        findings.push(...(await classFitCheck({ ...options, document: road, file: path })).findings);
      }
      return findings.sort(compareFindings);
    },
  });

  const executors = await readExecutors(options);
  await run({
    id: 'executors',
    applicable: true,
    run: async ({ examined }) => {
      examined();
      if (executors.exists && (executors.problem !== null || executors.meta_state !== 'declared')) {
        return executors.problem !== null && executors.document === null
          ? [unverified({ kind: 'executors', path: executors.path, reason: executors.problem === 'invalid_json' ? 'invalid' : 'unreadable' })]
          : integrity({ kind: 'executors', schemaId: EXECUTORS_SCHEMA, path: executors.path, meta_state: executors.meta_state, issues: executors.issues });
      }
      if (!executors.unclassified) return [];
      const has = (role) => executors.executors.some((entry) => entry.role === role);
      return [{ ...unclassifiedFinding(), detail: { has_leader: has('leader'), has_worker: has('worker') } }];
    },
  });

  const scopeFiles = await listScopeFiles(options);
  await run({
    id: 'scope-requests',
    applicable: scopeFiles.length > 0,
    notApplicableReason: 'no scope request was ever recorded',
    run: async ({ examined }) => {
      const { requests, issues } = await readAllRequests(options);
      examined(scopeFiles.length);
      const findings = issues.map((entry) => unverified({ kind: 'scope', path: entry.file, reason: 'invalid', line: entry.line ?? null, message: `The scope ledger ${entry.file} is not canonical: ${entry.message}.` }));
      for (const { id, road, blocking } of requests.filter(({ state }) => state === 'pending')) {
        findings.push(finding({
          code: 'AKRS-R018', severity: 'warning', message: `The ${blocking ? 'blocking ' : ''}scope request ${id} on ${road} is still pending.`, file: scopeFiles.find((entry) => entry.road === road)?.path ?? null,
          detail: { road, request: id, blocking },
        }));
      }
      return findings.sort(compareFindings);
    },
  });

  const state = await readState(options);
  await run({
    id: 'state',
    applicable: state.exists,
    notApplicableReason: 'there is no state.json',
    run: async ({ examined }) => {
      examined();
      if (state.problem !== null && state.state === null) return [unverified({ kind: 'state', path: state.path, reason: state.problem === 'invalid_json' ? 'invalid' : 'unreadable' })];
      return integrity({ kind: 'state', schemaId: STATE_SCHEMA, path: state.path, meta_state: state.meta_state, issues: state.issues });
    },
  });
  await run({
    id: 'state-render',
    applicable: state.exists && state.meta_state === 'declared',
    notApplicableReason: 'there is no verified state.json to render',
    run: async ({ examined }) => {
      examined();
      const rendered = await readRenderedState(options);
      const expected = renderStateMarkdown({ state: state.state, derived: await deriveState(options) });
      if (rendered.exists && rendered.text === expected) return [];
      const path = rendered.path ?? `${service.workflow_relative_path === '' ? '' : `${service.workflow_relative_path}/`}STATE.md`;
      return [finding({
        code: 'AKRS-S008', severity: 'warning', message: `${path} ${rendered.exists ? 'does not equal the render of the canonical inputs' : 'is missing'}.`, file: path,
        detail: { path, reason: rendered.exists ? 'stale' : 'missing' },
      })];
    },
  });

  const log = await readLog(options);
  await run({
    id: 'log',
    applicable: log.segments.length > 0,
    notApplicableReason: 'the closure ledger has no segment',
    run: async ({ examined }) => {
      examined(log.segments.length);
      const findings = log.issues.map((entry) => finding({
        code: 'AKRS-S003', message: `The closure ledger segment ${entry.file} cannot be trusted: ${entry.message}.`, file: entry.file, line: entry.line ?? null,
        detail: { path: entry.file, reason: entry.code, line: entry.line ?? null },
      }));
      for (const record of log.unverified) findings.push(unverified({ kind: 'log', path: record.path, reason: 'hash_mismatch', line: record.line }));
      return findings.sort(compareFindings);
    },
  });
  const closed = log.records.filter(({ meta_state: stateName, outcome }) => stateName === 'declared' && outcome === 'DONE');
  const planIds = new Set((await service.walkWorkflowFiles('plans')).map((path) => basename(path)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)));
  await run({
    id: 'closure-consistency',
    applicable: closed.length > 0 || done.length > 0,
    notApplicableReason: 'there is no DONE Road and no DONE closure',
    run: async ({ examined }) => {
      examined(closed.length + done.length);
      const findings = [];
      const roadIds = new Set(roadEntries.map(({ id }) => id));
      for (const record of closed) {
        const known = record.kind === 'road' ? roadIds.has(record.subject) : planIds.has(record.subject);
        if (!known) {
          findings.push(finding({
            code: 'AKRS-S009', severity: 'warning', message: `The DONE closure of ${record.kind} ${record.subject} names a ${record.kind} that does not exist.`, file: record.path, line: record.line,
            detail: { reason: 'closure_unknown_subject', kind: record.kind, subject: record.subject },
          }));
        }
      }
      const closedRoads = new Set(closed.filter(({ kind }) => kind === 'road').map(({ subject }) => subject));
      for (const { id, path } of done) {
        if (closedRoads.has(id)) continue;
        findings.push(finding({
          code: 'AKRS-S009', severity: 'warning', message: `The Road ${id} is DONE but the closure ledger has no DONE record for it.`, file: path,
          detail: { reason: 'done_without_closure', kind: 'road', subject: id },
        }));
      }
      return findings.sort(compareFindings);
    },
  });

  const memory = await readMemory(options);
  await run({
    id: 'memory',
    applicable: memory.files.length > 0,
    notApplicableReason: 'there is no Memory file',
    run: async ({ examined }) => {
      examined(memory.files.length);
      const findings = [];
      for (const record of memory.unverified) {
        findings.push(...record.issues.filter(({ code }) => code === 'unverified_record').map(() => unverified({ kind: 'memory', path: record.path, reason: 'hash_mismatch', line: record.line })));
        const schema = record.issues.filter(({ code }) => code === 'schema_violation');
        findings.push(...findingsForSchemaIssues('akrs.memory-record/v1', schema.map(({ message, pointer }) => ({ path: pointer ?? '$', code: 'schema_violation', message })), { file: record.path }));
      }
      for (const issue of memory.issues.filter(({ code }) => code !== 'schema_violation' && code !== 'unverified_record')) {
        findings.push(unverified({ kind: 'memory', path: issue.file, reason: 'invalid', line: issue.line ?? null, message: `${issue.file} is not canonical Memory: ${issue.message}.` }));
      }
      return findings.sort(compareFindings);
    },
  });

  const keys = await verificationKeys(service);
  const knownRoads = new Set(roadEntries.map(({ id }) => id));
  await run({
    id: 'verification',
    applicable: keys.length > 0,
    notApplicableReason: 'no verification contract or handoff exists',
    run: async ({ examined }) => {
      const findings = [];
      for (const key of keys) {
        examined();
        const { contract, handoffs } = await readVerification({ ...options, key });
        if (contract.exists) {
          findings.push(...integrity({ kind: 'verification', schemaId: VERIFICATION_SCHEMA, path: contract.path, meta_state: contract.meta_state, issues: contract.issues }));
          if (contract.meta_state === 'declared') {
            for (const road of contract.contract.roads.filter((id) => !knownRoads.has(id))) {
              findings.push(finding({
                code: 'AKRS-T002', message: `The verification contract of ${key} names the Road ${road}, which does not exist.`, file: contract.path,
                detail: { reason: 'road_missing', subject: road, pointer: '/roads', expected: null, actual: null },
              }));
            }
          }
        }
        if (handoffs.exists && handoffs.issues.length > 0) findings.push(unverified({ kind: 'handoff', path: handoffs.path, reason: 'invalid' }));
      }
      return findings.sort(compareFindings);
    },
  });

  const prefix = service.workflow_relative_path === '' ? '' : `${service.workflow_relative_path}/`;
  const drafts = (await service.walkWorkflowFiles('drafts')).filter((path) => path.startsWith(`${prefix}drafts/`));
  await run({
    id: 'drafts',
    applicable: drafts.length > 0,
    notApplicableReason: 'no draft is left behind',
    run: async ({ examined }) => {
      examined(drafts.length);
      return drafts.map((path) => finding({ code: 'AKRS-C017', severity: 'warning', message: `${path} is a left-over draft; it is not a canonical artifact and is never parsed.`, file: path, detail: { path } }));
    },
  });
  const legacy = (await service.walkWorkflowFiles('roads')).filter((path) => path.toLowerCase().endsWith('.md') && basename(path).toLowerCase() !== 'readme.md');
  await run({
    id: 'legacy-forms',
    applicable: legacy.length > 0,
    notApplicableReason: 'no v1 Markdown Road file exists',
    run: async ({ examined }) => {
      examined(legacy.length);
      return legacy.map((path) => finding({ code: 'AKRS-R019', message: `${path} is a v1 Markdown Road; Roads are JSON artifacts written by the CLI and this form is never parsed.`, file: path, detail: { path } }));
    },
  });

  const posture = await readPosture(options);
  await run({
    id: 'git-posture',
    applicable: posture.git && posture.tracked.length + posture.ignored.length + posture.untracked.length > 0,
    notApplicableReason: posture.git ? 'the workflow has no artifact files' : 'the project is not a git repository',
    run: async ({ examined }) => {
      examined(posture.tracked.length + posture.ignored.length + posture.untracked.length);
      return posture.posture === 'tracked' ? [] : [postureFinding(posture)];
    },
  });
  return outcomes;
}
