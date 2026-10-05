// `stale` (P2-W09): what is no longer current and the exact inputs that invalidated it. Read only; nothing is refreshed.
import { compareStrings } from '../../schemas/common.js';
import { checkLease, readLease } from '../leases/index.js';
import { LEASE_CONTRACT_PROJECTION, TESTER_LEASE_PROJECTION, computeSnapshot } from '../snapshots/index.js';
import { readRenderedState } from '../state/repository.js';
import { deriveState } from '../state/repository.js';
import { renderStateMarkdown } from '../state/render.js';
import { readRuns } from '../test-run/record.js';
import { STALE_SCHEMA } from './policy.js';

const delta = (check) => ({ added: [...check.delta.added], changed: [...check.delta.changed], removed: [...check.delta.removed] });

async function staleLease({ base, kind, target, projection, holderKey }) {
  const stored = await readLease({ ...base, kind, target });
  if (stored.status !== 'held') return null;
  const current = await computeSnapshot({ ...base, projections: projection, target: { [holderKey]: target } });
  const check = checkLease({ lease: stored.lease, current });
  if (check.state !== 'stale') return null;
  return {
    kind: kind === 'road' ? 'road_lease' : 'plan_lease', subject: target, plan: kind === 'plan' ? target : null, holder: stored.lease.holder,
    reasons: [check.reason === 'unstable' ? 'unstable' : 'inputs_changed'], inputs: delta(check),
  };
}

export async function buildStaleData(model, { repositoryRoot, workflowRoot }) {
  const base = { repositoryRoot, workflowRoot };
  const items = [];
  for (const road of model.roads) {
    const item = road.lease.holder === null ? null : await staleLease({ base, kind: 'road', target: road.id, projection: LEASE_CONTRACT_PROJECTION, holderKey: 'road' });
    if (item !== null) items.push(item);
  }
  for (const plan of model.plans) {
    const lease = await staleLease({ base, kind: 'plan', target: plan.id, projection: TESTER_LEASE_PROJECTION, holderKey: 'plan' });
    if (lease !== null) items.push(lease);
    const data = plan.packet?.data;
    if (data === undefined || data.kind !== 'test_details') continue;
    const hash = data.contract.hash;
    const now = await computeSnapshot({ ...base, projections: TESTER_LEASE_PROJECTION, target: { plan: plan.id } });
    for (const run of (await readRuns({ ...base, key: plan.id })).runs.slice(0, 5)) {
      const reasons = [];
      if (run.record.snapshot !== now.snapshot) reasons.push('snapshot_changed');
      if (run.record.contract_hash !== hash) reasons.push('contract_changed');
      if (reasons.length > 0) items.push({ kind: 'run', subject: run.id, plan: plan.id, holder: null, reasons, inputs: null });
    }
    const latest = plan.results.at(-1);
    if (latest !== undefined && latest.verdict === 'pass' && plan.closure !== 'closed') {
      const reasons = [];
      if (latest.tested_snapshot !== data.tested_snapshot) reasons.push('snapshot_changed');
      if (latest.contract_hash !== hash) reasons.push('contract_changed');
      if (reasons.length > 0) items.push({ kind: 'result', subject: latest.id, plan: plan.id, holder: null, reasons, inputs: null });
    }
  }
  if (model.state !== null) {
    const rendered = await readRenderedState(base);
    if (rendered.exists && rendered.text !== null) {
      const expected = renderStateMarkdown({ state: model.state, derived: await deriveState(base) });
      if (rendered.text !== expected) items.push({ kind: 'state_render', subject: rendered.path, plan: null, holder: null, reasons: ['differs_from_derived'], inputs: null });
    }
  }
  items.sort((left, right) => compareStrings(left.kind, right.kind) || compareStrings(left.subject, right.subject));
  return { kind: 'stale', packet_version: STALE_SCHEMA, empty: items.length === 0, items };
}
