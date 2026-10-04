// The core of `test-details`: ONE Tester packet over the canonical Phase-1 readers. It reads and computes only; it never
// writes (not even a lease), never copies a source file body and never shortens a packet to fit.
//
// buildTesterPacket(options) -> { problem: 'unknown_plan' } | { status, data, findings, nextCommands, snapshot }
//   options: { repositoryRoot, workflowRoot, key, env?, rootArgs?, hooks?: { afterRead? } }
import { isId, compareStrings } from '../../schemas/common.js';
import { pathOverlap } from '../../schemas/glob.js';
import { TEST_DETAILS_SCHEMA } from '../../schemas/test-details.js';
import { readExecutors } from '../executors/index.js';
import { checkLease, readLease, resolveHolder } from '../leases/index.js';
import { createPathService } from '../path-service.js';
import { RoadStoreError, readRoad } from '../roads/repository.js';
import { projectReadWindows } from '../roads/read-windows.js';
import { TESTER_LEASE_PROJECTION, commandSnapshot, computeSnapshot } from '../snapshots/index.js';
import { readContract, readHandoffs, readResults, readRoadPlans } from '../verification/index.js';
import { TEST_DETAILS_NEXT_COMMAND_BUILDERS } from './next-commands.js';
import { NEVER_EDIT, TESTER_FINDING_CODE } from './policy.js';

export { TEST_DETAILS_POLICY, NEVER_EDIT, TESTER_FINDING_CODE } from './policy.js';
export { TEST_DETAILS_NEXT_COMMAND_BUILDERS };
const builder = TEST_DETAILS_NEXT_COMMAND_BUILDERS['test-details'];

const MESSAGES = {
  acceptance_missing: () => 'The contract declares no acceptance, so there is nothing to test against.',
  changed_during_query: () => 'The workflow changed while the packet was read; ask again.',
  contract_missing: (subject) => `The Plan ${subject} has no verification contract yet.`,
  contract_unverified: (subject) => `The verification contract ${subject} does not verify (hand-edited or invalid).`,
  evidence_types_missing: () => 'The contract names no evidence type for a live or measured policy.',
  handoff_missing: (subject) => `The Road ${subject} has no Worker handoff.`,
  handoff_unresolved: (subject) => `The latest handoff of ${subject} is not ready.`,
  launch_missing: () => 'The contract declares no launch data for a live or measured policy.',
  ledger_unusable: (subject) => `The ledger ${subject} cannot be read.`,
  measurement_missing: () => 'The contract defines no measurement for a measured policy.',
  read_unresolved: (subject) => `The declared read ${subject} is unresolved.`,
  road_missing: (subject) => `The Road ${subject} does not exist.`,
  road_not_done: (subject) => `The Road ${subject} is not DONE.`,
  road_unverified: (subject) => `The Road ${subject} does not verify (hand-edited or invalid).`,
  snapshot_unstable: () => 'The workflow changed while the snapshot was read; ask again.',
};

const blockerFinding = (plan, { reason, subject }) => ({
  code: TESTER_FINDING_CODE, severity: 'error', message: MESSAGES[reason](subject), file: null, line: null, detail: { plan, reason, subject },
});

const writePatterns = ({ path, class: pathClass }) => (pathClass === 'dir' ? [`${path}/**`] : (pathClass === 'ephemeral' ? [path, `${path}/**`] : [path]));

async function leaseOf({ repositoryRoot, workflowRoot, key }) {
  const stored = await readLease({ repositoryRoot, workflowRoot, kind: 'plan', target: key });
  if (stored.status === 'none') return { holder: null, state: 'none' };
  if (stored.status !== 'held') return { holder: null, state: 'unreadable' };
  const current = await computeSnapshot({ repositoryRoot, workflowRoot, projections: TESTER_LEASE_PROJECTION, target: { plan: key } });
  return { holder: stored.lease.holder, state: checkLease({ lease: stored.lease, current }).state === 'fresh' ? 'fresh' : 'stale' };
}

export async function buildTesterPacket(options) {
  const { repositoryRoot, workflowRoot, key, env = process.env, rootArgs = [], hooks = {} } = options;
  if (!isId(key)) throw new TypeError('key must be a valid ID');
  const base = { repositoryRoot, workflowRoot };

  const roadPlans = await readRoadPlans(base);
  const service = await createPathService(base);
  const planFile = await service.resolveWorkflowPath(`plans/${key}.json`);
  const planned = roadPlans.filter((road) => road.plan === key);
  let mode;
  if (planFile.exists || planned.length > 0) mode = 'plan';
  else if (roadPlans.some((road) => road.id === key && road.plan === null)) mode = 'road';
  else return { problem: 'unknown_plan' };

  const first = await commandSnapshot('test-details', { ...base, target: { plan: key } });
  const snapshot = first.status === 'ok' ? first.snapshot : null;
  const blockers = [];
  const block = (reason, subject = null) => blockers.push({ reason, subject });
  const blockedOnly = (extra, phase) => ({
    status: 'blocked',
    data: { kind: 'test_details_blocked', packet_version: TEST_DETAILS_SCHEMA, plan: key, mode, blockers: extra },
    findings: extra.map((entry) => blockerFinding(key, entry)),
    nextCommands: builder({ phase, rootArgs }),
    snapshot,
  });
  if (snapshot === null) return blockedOnly([{ reason: 'snapshot_unstable', subject: null }], 'blocked');

  const read = await readContract({ ...base, key });
  if (!read.exists) return blockedOnly([{ reason: 'contract_missing', subject: key }], 'no_contract');
  if (read.meta_state !== 'declared') return blockedOnly([{ reason: 'contract_unverified', subject: read.path ?? read.workflow_path }], 'blocked');
  const { contract } = read;
  const required = contract.policy !== 'none';
  const need = (reason, subject = null) => {
    if (required) block(reason, subject);
  };

  // Roads
  const roads = [];
  const loaded = [];
  for (const id of contract.roads) {
    let found = null;
    try {
      found = await readRoad({ ...base, id });
    } catch (error) {
      if (!(error instanceof RoadStoreError)) throw error;
      need('road_unverified', id);
      continue;
    }
    if (found === null) {
      need('road_missing', id);
      continue;
    }
    if (found.meta_state !== 'declared') need('road_unverified', id);
    else {
      if (found.road.status !== 'DONE') need('road_not_done', id);
      loaded.push(found);
    }
    roads.push({
      id, plan: found.road.plan ?? null, status: found.road.status ?? null, contract: found.meta_state, executor_class: found.road.executor_class ?? null, path: found.path,
    });
  }

  // Reads: pointers only; no body is read into the packet
  const windows = await projectReadWindows({ ...base, road: { reads: contract.reads, writes: [] } });
  const reads = windows.map((window, index) => ({
    index, path: window.path, window: window.lines === null ? null : { lines: [...window.lines] }, kind: window.kind, status: window.status, why: window.why, line_count: window.line_count,
  }));
  for (const entry of reads) if (entry.status !== 'ok') need('read_unresolved', entry.path);

  // Handoffs
  const ledger = await readHandoffs({ ...base, key });
  if (ledger.problem !== null) need('ledger_unusable', ledger.path ?? ledger.workflow_path);
  const handoffs = ledger.records.map(({ value }) => ({
    id: value.id, ts: value.ts, road: value.road, snapshot: value.snapshot, result: value.result, reach: [...value.reach], expect: value.expect, ready: value.ready,
  }));
  let handedOff = 0;
  for (const id of contract.roads) {
    const own = handoffs.filter((entry) => entry.road === id);
    if (own.length === 0) need('handoff_missing', id);
    else if (own.at(-1).ready !== true) need('handoff_unresolved', id);
    else handedOff += 1;
  }

  if (contract.acceptance.length === 0) need('acceptance_missing');
  if (['live', 'measured'].includes(contract.policy)) {
    if (contract.launch === null) need('launch_missing');
    if (contract.evidence_types.length === 0) need('evidence_types_missing');
  }
  if (contract.policy === 'measured' && contract.measurements.length === 0) need('measurement_missing');

  // Results: previous failures and the latest captured check results, never a carried-forward pass
  const results = await readResults({ ...base, key });
  const hash = read.contract.meta.content_hash;
  const isCurrent = (value) => value.tested_snapshot === snapshot && value.contract_hash === hash;
  const previousFailures = results.records.filter(({ value }) => value.verdict !== 'pass').map(({ value }) => ({
    id: value.id, ts: value.ts, verdict: value.verdict, tested_snapshot: value.tested_snapshot, contract_hash: value.contract_hash, current: isCurrent(value), counts_as_pass: false,
    open_findings: value.findings.filter(({ status }) => status === 'open').map(({ id, text }) => ({ id, text })),
  }));
  const lastNamed = (name) => results.records.map(({ value }) => value).filter((value) => value.checks.some((check) => check.name === name)).at(-1);
  const checks = loaded.flatMap((found) => found.road.checks.map((check) => {
    const latest = lastNamed(check.name);
    const entry = latest === undefined ? null : latest.checks.find((candidate) => candidate.name === check.name);
    return {
      road: found.road.id, name: check.name, argv: [...check.argv], timeout_ms: check.timeout_ms,
      last_result: entry === undefined || entry === null ? null : { result: latest.id, passed: entry.passed, exit_code: entry.exit_code ?? null, current: isCurrent(latest) },
    };
  }));
  const directory = `verifications/${key}/evidence`;
  const currentResults = results.records.map(({ value }) => value).filter(isCurrent);
  const evidenceSlots = contract.evidence_types.map((type) => ({ type, directory, filled: currentResults.some((value) => value.evidence.some((entry) => entry.type === type)) }));

  // Diff: the declared product writes as the snapshot projection measures them
  const product = (await computeSnapshot({ ...base, projections: ['plan-product'], target: { plan: key } })).inventory;
  const writes = loaded.flatMap((found) => found.road.writes.map((write) => ({ road: found.road.id, ...write })));
  const files = product.map((entry) => ({
    path: entry.key, kind: entry.kind, sha256: entry.value,
    declared_by: [...new Set(writes.filter((write) => writePatterns(write).some((pattern) => pathOverlap(pattern, entry.key) !== 'disjoint')).map(({ road }) => road))].sort(compareStrings),
  })).filter((entry) => /^sha256:/.test(entry.sha256));
  const present = new Set(files.map(({ path }) => path));
  const declaredAbsent = writes.filter((write) => write.class === 'file' && write.action !== 'delete' && !present.has(write.path))
    .map(({ road, path, action }) => ({ road, path, action })).sort((left, right) => compareStrings(left.road, right.road) || compareStrings(left.path, right.path));

  const executors = (await readExecutors(base)).executors;
  const resolved = resolveHolder({ env, executors, role: 'tester' });
  const testerExecutor = resolved.status === 'resolved' ? executors.find((entry) => entry.id === resolved.holder) : null;
  const lease = await leaseOf({ ...base, key });

  await hooks.afterRead?.();
  const second = await commandSnapshot('test-details', { ...base, target: { plan: key } });
  if (second.status !== 'ok' || second.snapshot !== snapshot) block('changed_during_query');

  const data = {
    kind: 'test_details',
    packet_version: TEST_DETAILS_SCHEMA,
    plan: key,
    mode,
    tested_snapshot: snapshot,
    policy: contract.policy,
    contract: { hash, path: read.path, meta_state: read.meta_state },
    roads,
    reads,
    acceptance: [...contract.acceptance],
    launch: contract.launch === null ? null : structuredClone(contract.launch),
    setup: contract.setup.map(({ name, argv }) => ({ name, argv: [...argv] })),
    teardown: contract.teardown.map(({ name, argv }) => ({ name, argv: [...argv] })),
    checks,
    diff: { pinned_to: snapshot, files, declared_absent: declaredAbsent },
    handoffs,
    measurements: structuredClone(contract.measurements),
    evidence_slots: evidenceSlots,
    previous_failures: previousFailures,
    reachability: [...contract.reachability],
    boundaries: [NEVER_EDIT, ...contract.boundaries.filter((entry) => entry !== NEVER_EDIT)],
    timeout_ms: contract.timeout_ms,
    allowed_hosts: [...contract.allowed_hosts],
    scenario: structuredClone(contract.scenario),
    runs: [],
    permissions: { product_code_write: false, may_write: [{ what: 'evidence', where: directory }, { what: 'result', where: `akrs test result ${key}` }] },
    lease,
    tester: { holder: testerExecutor?.id ?? null, class: testerExecutor?.class ?? null, run_required: testerExecutor?.class === 'weak' },
    coverage: {
      required,
      roads: `${roads.filter(({ status, contract: state }) => status === 'DONE' && state === 'declared').length}/${contract.roads.length}`,
      reads: `${reads.filter(({ status }) => status === 'ok').length}/${reads.length}`,
      handoffs: `${handedOff}/${contract.roads.length}`,
      acceptance: contract.acceptance.length,
      measurements: contract.measurements.length,
      evidence_types: contract.evidence_types.length,
      blockers: blockers.length,
    },
    blockers,
  };
  return {
    status: blockers.length > 0 ? 'blocked' : 'ok',
    data,
    findings: blockers.map((entry) => blockerFinding(key, entry)),
    nextCommands: builder({ phase: blockers.length > 0 ? 'blocked' : 'ready', rootArgs }),
    snapshot,
  };
}
