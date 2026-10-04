// `road move`: relocate a Road file between Plan folders. Report-only unless applied; applying is one recoverable
// transaction (create the new file, delete the old one, retarget the declared references). MOVE_STORE_POLICY.
import { readFile } from 'node:fs/promises';
import { compareStrings, isId } from '../../schemas/common.js';
import { validateRoad } from '../../schemas/road.js';
import { createDefaultProviders } from '../../core/providers.js';
import { runMutationFlow } from '../mutation-flow.js';
import { createPathService } from '../path-service.js';
import { SCOPE_NEXT_COMMAND_BUILDERS } from '../scope/next-commands.js';
import { inRepository, roadPath, taskPath } from './paths.js';
import { collectIdentities, listRoadFiles, readRoad, renderRoad, workflowOption, RoadStoreError } from './repository.js';
import { retargetTaskText } from './task.js';
import { buildUpdatedRoad, guardFinding, loadRoadForChange, sortedFindings, updateFormOf } from './update.js';

const COMMAND = 'road-move';
const segments = (path) => path.split('/').filter((part) => part !== '');
const samePath = (left, right) => {
  const a = segments(left);
  const b = segments(right);
  return a.length === b.length && a.every((part, index) => part === b[index]);
};

// options: { repositoryRoot, workflowRoot, id, plan: <plan ID | 'none'>, apply?, requestId?, expectedSnapshot?, providers?,
//   knownCommands, rootArgs?, ... }. Without `apply` the run is a report (a dry run: no byte changes).
export async function moveRoad(options) {
  const {
    repositoryRoot, workflowRoot, id, plan, apply = false, requestId, expectedSnapshot, providers = createDefaultProviders(),
    knownCommands, boundary, lockOptions, rootArgs = [],
  } = options;
  const root = options.root ?? repositoryRoot;
  const builder = SCOPE_NEXT_COMMAND_BUILDERS[COMMAND];
  const dryRun = !apply || options.dryRun === true;
  const newPlan = plan === 'none' ? null : plan;
  if (newPlan !== null && !isId(newPlan)) throw new TypeError('plan must be a Plan ID or "none"');

  const render = async () => {
    const loaded = await loadRoadForChange({ repositoryRoot, workflowRoot, id, allowActive: false });
    if (loaded.findings !== undefined) return { rejection: { kind: 'findings', reason: 'proposal_rejected', findings: loaded.findings } };
    const { found } = loaded;
    const service = await createPathService({ repositoryRoot, workflowRoot });
    const relative = service.workflow_relative_path;
    const prefix = relative === '' ? '' : `${relative}/`;
    const findings = [];
    const refuse = (reason, message, extra = {}) => findings.push(guardFinding({ reason, subject: id, message, file: found.path, ...extra }));
    if (found.road.plan === newPlan) refuse('no_change', `The Road ${id} already belongs to ${newPlan === null ? 'no Plan' : `the Plan ${newPlan}`}.`);
    if (newPlan !== null) {
      const clash = (await collectIdentities({ repositoryRoot, workflowRoot })).find((entry) => entry.kind === 'road' && entry.id === newPlan);
      if (clash !== undefined) refuse('plan_names_a_road', `The plan "${newPlan}" is the ID of a Road; Plan and Road IDs share one namespace.`, { pointer: '/plan', actual: newPlan });
    }
    const toWorkflow = roadPath({ id, plan: newPlan });
    const fromWorkflow = found.path.slice(prefix.length);
    const toRepository = inRepository(relative, toWorkflow);
    if (toWorkflow !== fromWorkflow) {
      const resolved = await service.resolveWorkflowPath(toWorkflow);
      if (resolved.exists || !resolved.case_matches) refuse('target_exists', `${toRepository} already exists (or differs only in case); a move never overwrites.`, { actual: toRepository });
    } else if (found.road.plan !== newPlan) {
      // misplaced file: the plan changes but the path is already right; still a valid relocation of the field
    }
    if (findings.length > 0) return { rejection: { kind: 'findings', reason: 'proposal_rejected', findings: sortedFindings(findings) } };

    const options2 = workflowOption(service);
    const moved = { ...updateFormOf(found.road), plan: newPlan };
    const schemaIssues = validateRoad(moved, { form: 'update', ...options2 }).issues;
    if (schemaIssues.length > 0) {
      return { rejection: { kind: 'findings', reason: 'proposal_rejected', findings: [guardFinding({ reason: 'plan_names_a_road', subject: id, message: schemaIssues.map(({ path, message }) => `${path} ${message}`).join('; '), file: found.path })] } };
    }
    const movedText = renderRoad(buildUpdatedRoad(moved, options2), options2);
    const operations = [];
    if (toWorkflow !== fromWorkflow) {
      operations.push({ type: 'create', path: toWorkflow, content: movedText }, { type: 'delete', path: fromWorkflow });
    } else {
      operations.push({ type: 'replace', path: fromWorkflow, content: movedText });
    }
    const references = [{ file: toRepository, kind: 'road_plan', pointer: '/plan' }];
    const skipped = [];

    // the Road's Task: identity marker plan and the `Road:` pointer
    if (typeof found.road.task === 'string') {
      const taskWorkflow = taskPath(found.road.task);
      const resolved = await service.resolveWorkflowPath(taskWorkflow);
      if (resolved.exists && resolved.case_matches) {
        const text = (await readFile(resolved.filesystem_path)).toString('utf8');
        const next = retargetTaskText(text, { road: id, plan: newPlan, oldPath: found.path, newPath: toRepository });
        if (next === null) skipped.push({ file: resolved.actual_relative_path, reason: 'task_marker_unverified' });
        else if (next !== text) {
          operations.push({ type: 'replace', path: taskWorkflow, content: next });
          references.push({ file: resolved.actual_relative_path, kind: 'task_marker_and_pointer', pointer: null });
        }
      }
    }

    // other Roads that declare the old path in reads[].path or on_landing (segment-wise equality)
    for (const { id: otherId } of await listRoadFiles({ repositoryRoot, workflowRoot })) {
      if (otherId === id) continue;
      let other;
      try {
        other = await readRoad({ repositoryRoot, workflowRoot, id: otherId });
      } catch (error) {
        if (!(error instanceof RoadStoreError)) throw error;
        continue;
      }
      if (other === null) continue;
      const hits = [];
      (Array.isArray(other.road.reads) ? other.road.reads : []).forEach((read, index) => {
        if (typeof read?.path === 'string' && samePath(read.path, found.path)) hits.push(`/reads/${index}/path`);
      });
      if (typeof other.road.on_landing === 'string' && samePath(other.road.on_landing, found.path)) hits.push('/on_landing');
      if (hits.length === 0) continue;
      if (other.meta_state !== 'declared') {
        skipped.push({ file: other.path, reason: 'road_unverified' });
        continue;
      }
      const changed = updateFormOf(other.road);
      changed.reads = changed.reads.map((read) => (samePath(read.path, found.path) ? { ...read, path: toRepository } : read));
      if (typeof changed.on_landing === 'string' && samePath(changed.on_landing, found.path)) changed.on_landing = toRepository;
      operations.push({ type: 'replace', path: other.path.slice(prefix.length), content: renderRoad(buildUpdatedRoad(changed, options2), options2) });
      for (const pointer of hits) references.push({ file: other.path, kind: 'road_reference', pointer });
    }
    references.sort((left, right) => compareStrings(left.file, right.file) || compareStrings(left.pointer ?? '', right.pointer ?? ''));
    return {
      operations,
      data: {
        kind: 'road_move',
        dry_run: false,
        applied: !dryRun,
        road: { id, from: found.path, to: toRepository, plan_from: found.road.plan, plan_to: newPlan },
        references,
        skipped,
      },
      nextCommands: dryRun && !apply ? builder({ phase: 'planned', id, plan: plan, rootArgs }) : builder({ phase: 'applied', rootArgs }),
      proposed: { files: operations.map(({ path }) => path).sort(compareStrings) },
    };
  };

  const result = await runMutationFlow({
    command: COMMAND,
    repositoryRoot,
    workflowRoot,
    root,
    providers,
    knownCommands,
    target: { road: id, plan: null },
    requestInput: { id, plan: newPlan },
    requestId,
    dryRun,
    expectedSnapshot,
    schema: 'akrs.road/v1',
    boundary,
    lockOptions,
    retryCommands: () => builder({ phase: 'rejected', rootArgs }),
    render,
  });
  return result;
}
