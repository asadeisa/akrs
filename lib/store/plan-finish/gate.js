// The Plan close gate (P2-W08): ONE closed evaluator that returns every blocker, never the first only. It reads only (the Plan
// file, the Roads, the Tester packet and its current-result projection, the results ledger, the run records and the evidence
// files) and is called twice by `plan finish`: to preview, and again under the repository lock right before the write.
//
// evaluatePlanGate({ repositoryRoot, workflowRoot, key, env?, rootArgs? })
//   -> { problem: 'unknown_plan' | 'not_a_plan' } | { blockers: [{ reason, subject }], plan, tester }
import { compareStrings, isId } from '../../schemas/common.js';
import { createPathService } from '../path-service.js';
import { buildTesterPacket } from '../test-details/index.js';
import { measureEvidence } from '../test-result/evidence.js';
import { readRuns } from '../test-run/record.js';
import { readContract, readResults, readRoadPlans } from '../verification/index.js';
import { readPlan } from './repository.js';

const budgetMet = (slot, value) => (slot.direction === 'min' ? value >= slot.budget : value <= slot.budget);
const bySubject = (left, right) => compareStrings(left.reason, right.reason) || compareStrings(left.subject ?? '', right.subject ?? '');

export async function evaluatePlanGate({ repositoryRoot, workflowRoot, key, env = process.env, rootArgs = [] }) {
  if (!isId(key)) throw new TypeError('key must be a valid ID');
  const base = { repositoryRoot, workflowRoot };
  const blockers = [];
  const block = (reason, subject = null) => blockers.push({ reason, subject });
  const finished = (plan = null, tester = null) => ({ blockers: blockers.sort(bySubject), plan, tester });

  const roadPlans = await readRoadPlans(base);
  const service = await createPathService(base);
  const file = await service.resolveWorkflowPath(`plans/${key}.json`);
  const planned = roadPlans.filter((road) => road.plan === key);
  if (!file.exists && planned.length === 0) return { problem: roadPlans.some((road) => road.id === key) ? 'not_a_plan' : 'unknown_plan' };

  // the Plan file: its own state, its seams, questions and finding pointers
  const read = await readPlan({ ...base, key });
  let plan = null;
  if (!read.exists) {
    block('plan_file_missing', key);
  } else if (read.meta_state !== 'declared') {
    block('plan_unverified', read.path ?? read.workflow_path);
  } else {
    plan = read.plan;
    if (plan.closure.status === 'closed') {
      block('already_closed', key);
      return finished(plan);
    }
  }

  // every required Road
  if (planned.length === 0) block('no_roads', key);
  for (const road of planned) {
    if (road.meta_state !== 'declared') block('road_unverified', road.id);
    else if (road.status !== 'DONE') block('road_not_done', road.id);
  }

  // the Tester proof, as the current-result projection states it
  const packet = await buildTesterPacket({ ...base, key, env, rootArgs });
  const ledger = await readResults({ ...base, key });
  if (ledger.problem !== null) block('ledger_unusable', ledger.path ?? ledger.workflow_path);
  let tester = null;
  if (packet.data.kind === 'test_details_blocked') {
    block('tester_unverified', packet.data.blockers[0]?.reason ?? null);
  } else {
    tester = packet.data.result.state;
    const latest = packet.data.result.latest;
    if (tester === 'unverified') block('tester_unverified', packet.data.blockers[0]?.reason ?? null);
    else if (tester === 'ready_for_test' || tester === 'testing') block('tester_missing', null);
    else if (tester === 'failed') block('tester_failed', latest.id);
    else if (tester === 'stale') block('tester_stale', latest.id);
    else if (tester === 'passed') await judgePass({ base, service, workflowRoot, key, record: ledger.records.at(-1).value, block });
  }

  // open Tester findings: the latest status by finding ID over the ledger, and any open pointer in the Plan file
  const status = new Map();
  for (const { value } of ledger.records) for (const entry of value.findings) status.set(entry.id, entry.status);
  for (const [id, state] of status) if (state === 'open') block('finding_open', id);
  for (const pointer of plan?.findings ?? []) if (pointer.status === 'open') block('finding_open', `${pointer.result}:${pointer.finding}`);

  // seams and questions the Plan owns
  for (const seam of plan?.seams ?? []) {
    if (seam.owner === null) {
      block('seam_unowned', seam.id);
    } else if (seam.owner.road !== null) {
      const owner = roadPlans.find((road) => road.id === seam.owner.road);
      if (owner === undefined) block('seam_owner_missing', seam.id);
      else if (owner.status !== 'DONE') block('seam_owner_not_done', seam.id);
    }
  }
  for (const question of plan?.questions ?? []) if (question.status === 'open') block('question_open', question.id);
  return finished(plan, tester);
}

// A current pass is judged once more: evidence is excluded from every snapshot, so it can change without the pass going stale.
async function judgePass({ base, service, workflowRoot, key, record, block }) {
  const { contract } = await readContract({ ...base, key });
  for (const slot of contract.measurements) {
    const entry = record.measurements.find((candidate) => candidate.name === slot.name);
    if (entry === undefined) block('measurement_missing', slot.name);
    else if (!budgetMet(slot, entry.value)) block('measurement_over_budget', slot.name);
  }
  for (const type of contract.evidence_types) {
    if (!record.evidence.some((entry) => entry.type === type)) block('evidence_type_missing', type);
  }
  for (const entry of record.evidence) {
    const measured = await measureEvidence({ service, workflowRoot, path: entry.path });
    if (measured === null) block('evidence_missing', entry.path);
    else if (measured.sha256 !== entry.sha256) block('evidence_changed', entry.path);
  }
  if (['live', 'measured'].includes(contract.policy) && contract.scenario.length > 0) {
    const found = record.run === null ? undefined : (await readRuns({ ...base, key })).runs.find(({ id }) => id === record.run);
    if (found === undefined) block('run_missing', record.run);
    else if (found.record.status !== 'passed') block('run_failed', record.run);
  }
}
