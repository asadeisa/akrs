// State reader API and the derived inputs of the renderer. Reads only.
import { STATE_SPEC, validateState } from '../../schemas/state.js';
import { compareStrings } from '../../schemas/common.js';
import { normalizeInput, parseStrictJson, verifyMeta } from '../canonical/index.js';
import { readLog } from '../log/repository.js';
import { createPathService } from '../path-service.js';
import { listRoadFiles, readRoad, RoadStoreError, workflowOption } from '../roads/repository.js';
import { readAllRequests } from '../scope/repository.js';
import { locate, readVerification } from '../verification/repository.js';
import { STATE_FILE, STATE_RENDER_FILE } from './policy.js';

// { path, workflow_path, exists, text, state|null, meta_state: 'declared'|'unverified'|null, issues, problem }
export async function readState({ repositoryRoot, workflowRoot }) {
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const file = await locate(service, STATE_FILE);
  const result = { path: file.path, workflow_path: file.workflow_path, exists: file.exists, text: file.text, state: null, meta_state: null, issues: [], problem: file.problem };
  if (file.text === null) return result;
  const normalized = normalizeInput(Buffer.from(file.text));
  const parsed = normalized.ok ? parseStrictJson(normalized.text) : normalized;
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return { ...result, meta_state: 'unverified', problem: 'invalid_json', issues: [{ path: '$', code: 'invalid_json', message: 'state.json is not a JSON object' }] };
  }
  const issues = validateState(parsed.value, { form: 'stored', ...workflowOption(service) }).issues.map((entry) => ({ ...entry }));
  const declared = issues.length === 0 && verifyMeta(parsed.value, { spec: STATE_SPEC }) === 'declared';
  return { ...result, state: parsed.value, meta_state: declared ? 'declared' : 'unverified', issues };
}

// The current STATE.md: { path, exists, text, problem } (the content is only ever compared, never parsed).
export async function readRenderedState({ repositoryRoot, workflowRoot }) {
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const file = await locate(service, STATE_RENDER_FILE);
  return { path: file.path, workflow_path: file.workflow_path, exists: file.exists, text: file.text, problem: file.problem };
}

// Every canonical input of the render, normalised:
//   roads    declared Roads [{ id, plan, status, deps, path }] sorted by id
//   closures every closure record in ledger order
//   pending  pending scope requests [{ id, road, blocking }] sorted by road then ledger order
//   plans    [{ key, policy, contract, handoffs, ready }] for every Plan a Road names, sorted by key
//   untrusted { roads, closures, sources } counts of what did not verify and was therefore left out
export async function deriveState({ repositoryRoot, workflowRoot }) {
  const roads = [];
  let unverifiedRoads = 0;
  let unreadableRoads = 0;
  for (const { id } of await listRoadFiles({ repositoryRoot, workflowRoot })) {
    try {
      const found = await readRoad({ repositoryRoot, workflowRoot, id });
      if (found === null) continue;
      if (found.meta_state !== 'declared') {
        unverifiedRoads += 1;
        continue;
      }
      roads.push({ id, plan: found.road.plan ?? null, status: found.road.status, deps: [...found.road.deps], path: found.path });
    } catch (error) {
      if (!(error instanceof RoadStoreError)) throw error;
      unreadableRoads += 1;
    }
  }
  roads.sort((left, right) => compareStrings(left.id, right.id));

  const log = await readLog({ repositoryRoot, workflowRoot });
  const closures = log.records.filter(({ meta_state: state }) => state === 'declared');
  const scope = await readAllRequests({ repositoryRoot, workflowRoot });
  const pending = scope.requests.filter(({ state }) => state === 'pending').map(({ id, road, blocking }) => ({ id, road, blocking }));

  const plans = [];
  for (const key of [...new Set(roads.map(({ plan }) => plan).filter((plan) => plan !== null))].sort(compareStrings)) {
    const verification = await readVerification({ repositoryRoot, workflowRoot, key });
    const contract = verification.contract.meta_state === 'declared' ? verification.contract.contract : null;
    const handoffs = verification.handoffs.records.map(({ value }) => value);
    plans.push({ key, policy: contract === null ? null : contract.policy, contract: verification.contract.exists, handoffs: handoffs.length, ready: handoffs.length === 0 ? null : handoffs.at(-1).ready });
  }
  return {
    roads,
    closures,
    pending,
    plans,
    untrusted: {
      roads: unverifiedRoads + unreadableRoads,
      closures: log.records.length - closures.length,
      sources: log.issues.length + scope.issues.length,
    },
  };
}
