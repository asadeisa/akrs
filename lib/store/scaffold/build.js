// The scaffold builder: pure, no file system. Every artifact is produced by the same builder its writer uses.
import { compareStrings, isId } from '../../schemas/common.js';
import { PLAN_SCHEMA, PLAN_SPEC, validatePlan } from '../../schemas/plan.js';
import { canonicalizeJson, parseStrictJson, storedSpec, withMeta } from '../canonical/index.js';
import { renderStateMarkdown } from '../state/render.js';
import { buildStoredState } from '../state/writer.js';
import { buildStoredVerification } from '../verification/writer.js';
import { inRepository, roadPath, taskPath } from '../roads/paths.js';
import { GENERATOR } from '../roads/policy.js';
import { validateRoadDocument } from '../roads/proposal.js';
import { buildStoredRoad, renderRoad } from '../roads/repository.js';
import { renderTaskScaffold } from '../roads/task.js';
import { contractPath } from '../verification/paths.js';

const taskIdOf = (road) => (/^R(?=[-0-9])/.test(road) ? `T${road.slice(1)}` : `T-${road}`);

function planText(id, generator) {
  const stored = {
    schema: PLAN_SCHEMA, id, title: `Plan ${id}`, questions: [], seams: [], findings: [], closure: { status: 'open', at: null, operation: null },
  };
  const stamped = withMeta(stored, { schema: PLAN_SCHEMA, generator, spec: PLAN_SPEC });
  const text = canonicalizeJson(stamped, storedSpec(PLAN_SPEC));
  const verdict = validatePlan(parseStrictJson(text).value, { form: 'stored' });
  if (!verdict.ok) throw new TypeError(`scaffold Plan is invalid: ${JSON.stringify(verdict.issues)}`);
  return text;
}

// options: { workflowRelative ('' when the workflow is the repository), plan?, road?, now, generator? }
// -> { tier, plan_id, road_id, task_id, key, files: [{ path, content }] } with workflow-relative paths in code point order.
export function buildScaffold({ workflowRelative, plan = null, road = null, now, generator = GENERATOR }) {
  if (typeof workflowRelative !== 'string') throw new TypeError('workflowRelative is required');
  if (typeof now !== 'string') throw new TypeError('now is required');
  if (plan !== null && !isId(plan)) throw new TypeError('plan must be a valid ID');
  const roadId = road ?? (plan === null ? 'R1' : `R-${plan}-1`);
  if (!isId(roadId)) throw new TypeError('road must be a valid ID');
  const taskId = taskIdOf(roadId);
  if (!isId(taskId)) throw new TypeError('the derived Task ID is not valid');
  const key = plan ?? roadId;
  const options = workflowRelative === '' ? {} : { workflowRoot: workflowRelative };
  const storeOptions = { ...options, generator };

  const roadDocument = {
    schema: 'akrs.road/v1',
    id: roadId,
    plan,
    task: taskId,
    deps: [],
    reads: [],
    writes: [{ path: 'README.md', class: 'file', action: 'modify' }],
    forbidden: [],
    checks: [{ name: 'node-version', argv: ['node', '--version'], timeout_ms: 60000 }],
    acceptance: ['README.md says what the project does.'],
    boundaries: ['Change no file other than README.md.'],
    on_landing: null,
    complexity: 1,
    executor_class: null,
    steps: ['Open README.md.', 'Describe what the project does in a few lines.'],
    scope_policy: { auto_reads: [], auto_writes: [] },
    oversize_reason: null,
  };
  const checked = validateRoadDocument(roadDocument, { workflowRelative });
  if (!checked.ok) throw new TypeError(`scaffold Road is invalid: ${JSON.stringify(checked.findings)}`);
  const storedRoad = buildStoredRoad(roadDocument, storeOptions);
  const roadFile = roadPath({ id: roadId, plan });

  const task = renderTaskScaffold({
    schema: 'akrs.task/v1', id: taskId, plan, road: roadId, objective: 'Make README.md say what the project does.', constraints: null, approach: null, notes: null,
  }, { roadPath: inRepository(workflowRelative, roadFile), generator });

  const contract = buildStoredVerification({
    schema: 'akrs.verification/v1',
    plan: key,
    roads: [roadId],
    policy: 'none',
    reads: [],
    launch: null,
    setup: [],
    teardown: [],
    acceptance: ['README.md says what the project does.'],
    measurements: [],
    evidence_types: [],
    reachability: [],
    boundaries: ['Never edit product code.'],
    timeout_ms: 600000,
    allowed_hosts: [],
    scenario: [],
  }, { workflowRoot: options.workflowRoot, generator });

  const next = `Review the Road ${roadId}, then classify the executors with executor set.`;
  const { stored: state, text: stateText } = buildStoredState({ mode: 0, role: 'leader', plan, phase: null, task: taskId, next }, { updatedAt: now, updatedBy: generator, generator });
  const markdown = renderStateMarkdown({
    state,
    derived: {
      roads: [{ id: roadId, plan, status: 'QUEUED', deps: [], path: inRepository(workflowRelative, roadFile) }],
      closures: [],
      pending: [],
      plans: plan === null ? [] : [{ key: plan, policy: 'none', contract: true, handoffs: 0, ready: null }],
      untrusted: { roads: 0, closures: 0, sources: 0 },
    },
  });

  const files = [
    { path: 'STATE.md', content: markdown },
    ...(plan === null ? [] : [{ path: `plans/${plan}.json`, content: planText(plan, generator) }]),
    { path: roadFile, content: renderRoad(storedRoad, options) },
    { path: 'state.json', content: stateText },
    { path: taskPath(taskId), content: task },
    { path: contractPath(key), content: contract.text },
  ].sort((left, right) => compareStrings(left.path, right.path));
  return { tier: plan === null ? 'no_plan' : 'plan', plan_id: plan, road_id: roadId, task_id: taskId, key, files };
}
