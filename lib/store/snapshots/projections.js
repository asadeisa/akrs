// F5 (P1-W02 + A1 F17 projection part): the frozen snapshot projection catalog and the per-command table.
//
// Decisions frozen here:
// - A command's snapshot is the hash of the named projections only (see engine.js). `inputs` of a row are
//   what an explicit expected snapshot is compared against; a lease-implied guard (`lease_guard`) instead
//   compares against LEASE_CONTRACT_PROJECTION (road) or TESTER_LEASE_PROJECTION (plan).
// - Cross-Road checks (write collisions, closure duplicates) are not snapshot inputs: they are revalidated
//   under the workflow lock when a mutation runs.
// - CLI housekeeping (lock, journal, transaction scratch) must live under <workflow>/.ops, which no projection
//   reads, so taking a lock or journaling never stales a snapshot.
// - Product files are read from the working tree only; see PRODUCT_INPUT_POLICY.
import { COMMAND_ID_PATTERN, compareStrings } from '../../schemas/common.js';
import { ContractValidationError, issue, isPlainObject, validationResult } from '../../schemas/validation.js';

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const sortedList = (values) => deepFreeze([...values].sort(compareStrings));

// sha256 of the empty string: the snapshot of an empty projection list.
export const EMPTY_SNAPSHOT = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export const SNAPSHOT_TARGETS = deepFreeze(['none', 'road', 'plan']);

const projection = (scope, engine, source) => ({ scope, engine, source });
const shared = (source) => projection('global', 'snapshots', source);

export const SNAPSHOT_PROJECTIONS = deepFreeze({
  'agent-configs': projection('global', 'agents-registry', 'Agent configuration registry (computed by P2-W16, not by this engine).'),
  doctrine: projection('global', 'doctrine-install', 'docs/akrs doctrine tree (computed by lib/store/doctrine-install.js, not by this engine).'),
  executors: shared('W/executors.json'),
  log: shared('Every file under W/log/.'),
  memory: shared('Every file under W/memory/.'),
  plan: projection('plan', 'snapshots', 'W/plans/<plan>.json'),
  'plan-contract': projection('plan', 'snapshots', 'W/verifications/<plan>/contract.json'),
  'plan-handoffs': projection('plan', 'snapshots', 'W/verifications/<plan>/handoff.jsonl as a whole file.'),
  'plan-product': projection('plan', 'snapshots', 'Product bytes inside the non-ephemeral writes of every applicable Road.'),
  'plan-reads': projection('plan', 'snapshots', 'The contract.reads windows, with no own-writes exclusion.'),
  'plan-results': projection('plan', 'snapshots', 'W/verifications/<plan>/results.jsonl as a whole file.'),
  'plan-roads': projection('plan', 'snapshots', 'Road files of the Roads applicable to the plan.'),
  plans: shared('Every file under W/plans/.'),
  'projects-registry': projection('global', 'user-config', 'User-level projects registry (computed by P2-W17, not by this engine).'),
  road: projection('road', 'snapshots', 'The Road JSON file.'),
  'road-deps': projection('road', 'snapshots', 'Status of each dependency Road.'),
  'road-handoffs': projection('road', 'snapshots', 'Handoff records of this Road in W/verifications/<plan or road>/handoff.jsonl.'),
  'road-reads': projection('road', 'snapshots', 'Declared read windows that are not inside the Road\'s own writes.'),
  'road-scope-requests': projection('road', 'snapshots', 'Request records of W/scope/<road>.jsonl.'),
  'road-scope-resolutions': projection('road', 'snapshots', 'Non-request records of W/scope/<road>.jsonl.'),
  'road-task': projection('road', 'snapshots', 'W/tasks/<road.task>.md'),
  'road-writes': projection('road', 'snapshots', 'Product bytes inside the Road\'s non-ephemeral writes.'),
  roads: shared('Every file under W/roads/.'),
  scope: shared('Every file under W/scope/.'),
  state: shared('W/state.json'),
  'state-render': shared('W/STATE.md'),
  tasks: shared('Every file under W/tasks/.'),
  verifications: shared('W/verifications/<plan>/{contract.json,handoff.jsonl,results.jsonl}; never evidence.'),
});

export const LEASE_CONTRACT_PROJECTION = sortedList(['executors', 'road', 'road-deps', 'road-reads', 'road-scope-resolutions']);
export const ROAD_PACKET_PROJECTION = sortedList([
  'executors', 'road', 'road-deps', 'road-reads', 'road-scope-requests', 'road-scope-resolutions', 'road-task',
]);
export const TESTER_LEASE_PROJECTION = sortedList(['plan-contract', 'plan-product', 'plan-reads', 'plan-roads']);
export const TESTER_PACKET_PROJECTION = sortedList([
  'plan', 'plan-contract', 'plan-handoffs', 'plan-product', 'plan-reads', 'plan-roads',
]);
export const PLAN_CLOSE_PROJECTION = sortedList([
  'plan', 'plan-contract', 'plan-handoffs', 'plan-product', 'plan-reads', 'plan-results', 'plan-roads',
]);
export const WORKFLOW_PROJECTION = sortedList([
  'executors', 'log', 'memory', 'plans', 'roads', 'scope', 'state', 'state-render', 'tasks', 'verifications',
]);

export const SNAPSHOT_EXCLUSIONS = deepFreeze([
  '.git/**',
  '{workflow}/.cache/**',
  '{workflow}/.ops/**',
  '{workflow}/drafts/**',
  '{workflow}/verifications/*/evidence/**',
]);

export const SNAPSHOT_VALUE_TOKENS = sortedList([
  'ambiguous', 'case_mismatch', 'missing', 'not_file', 'not_text', 'out_of_range', 'unparseable', 'unsafe',
]);

export const PRODUCT_INPUT_POLICY = deepFreeze({
  source: 'working_tree_bytes',
  git_index: 'not_an_input',
  tracked_dirty: 'Working-tree bytes are read; the committed bytes are never consulted.',
  staged: 'Staging alone never changes a snapshot; the git index and HEAD are never read, so committing does not stale either.',
  untracked: 'Untracked files are included when declared or matched.',
  ignored: 'Git-ignored files are included when declared or matched; git ignore rules are not consulted.',
  missing: 'A missing declared file is recorded as `missing`.',
  symlinks: 'Symlinks are skipped in walks; a declared path escaping the repository via a symlink is `unsafe`.',
  text_normalization: 'UTF-8 text without NUL is hashed with CRLF normalized to LF; any other bytes are hashed raw.',
});

const LEASE = LEASE_CONTRACT_PROJECTION;
const row = (target, inputs, leaseGuard = null) => ({ target, inputs: sortedList(inputs), lease_guard: leaseGuard });
const none = (inputs) => row('none', inputs);
const road = (inputs, leaseGuard) => row('road', inputs, leaseGuard);
const plan = (inputs, leaseGuard) => row('plan', inputs, leaseGuard);

export const COMMAND_SNAPSHOT_TABLE = deepFreeze({
  'agents-doctor': none(['agent-configs']),
  'agents-list': none(['agent-configs']),
  'agents-setup': none(['agent-configs']),
  audit: road(['road', 'road-writes']),
  boot: none(WORKFLOW_PROJECTION),
  doctor: none(['doctrine', 'executors']),
  done: road(LEASE, 'road'),
  'executor-list': none(['executors']),
  'executor-remove': none(['executors']),
  'executor-set': none(['executors']),
  explain: none([]),
  graph: none(WORKFLOW_PROJECTION),
  guard: none([]),
  help: none([]),
  init: none(['doctrine']),
  'init-scaffold': none(WORKFLOW_PROJECTION),
  'lease-release': road(LEASE),
  log: none(['log']),
  'log-append': none(['log']),
  mcp: none([]),
  'memory-add': none(['memory']),
  next: none(WORKFLOW_PROJECTION),
  page: none([]),
  'plan-finish': plan(PLAN_CLOSE_PROJECTION),
  postinstall: none(['doctrine']),
  'projects-add': none(['projects-registry']),
  'projects-list': none(['projects-registry']),
  'projects-remove': none(['projects-registry']),
  'reuse-scan': none(['roads', 'tasks']),
  'road-activate': road(ROAD_PACKET_PROJECTION),
  'road-check': road(ROAD_PACKET_PROJECTION),
  'road-details': road(ROAD_PACKET_PROJECTION),
  'road-finish': road(ROAD_PACKET_PROJECTION, 'road'),
  'road-fit': road(['executors', 'road', 'road-reads']),
  'road-move': none(['roads', 'tasks']),
  'road-new': none(['executors', 'plans', 'roads']),
  'road-reopen': road(ROAD_PACKET_PROJECTION),
  'road-update': road(ROAD_PACKET_PROJECTION),
  'scope-approve': road(ROAD_PACKET_PROJECTION),
  'scope-list': none(['scope']),
  'scope-reject': road(['road', 'road-scope-requests', 'road-scope-resolutions']),
  'scope-request': road(['executors', 'road', 'road-scope-requests', 'road-scope-resolutions']),
  stale: none(WORKFLOW_PROJECTION),
  'state-render': none(['executors', 'log', 'plans', 'roads', 'scope', 'state', 'verifications']),
  'state-set': none(['state']),
  status: none(WORKFLOW_PROJECTION),
  'status-all-projects': none(['projects-registry']),
  sync: none(['doctrine']),
  'task-new': road(['road', 'road-task']),
  template: none([]),
  'test-define': plan(['plan', 'plan-contract', 'plan-roads']),
  'test-details': plan(TESTER_PACKET_PROJECTION),
  'test-handoff': road(['road', 'road-handoffs']),
  'test-result': plan(TESTER_LEASE_PROJECTION, 'plan'),
  'test-run': plan(TESTER_LEASE_PROJECTION, 'plan'),
  validate: none(WORKFLOW_PROJECTION),
  verify: road(['road', 'road-reads', 'road-writes']),
  version: none([]),
  view: none(WORKFLOW_PROJECTION),
  watch: none([]),
  where: none(WORKFLOW_PROJECTION),
  work: road(LEASE, 'road'),
  yield: road(LEASE, 'road'),
});

const ROW_KEYS = ['inputs', 'lease_guard', 'target'];

export function validateSnapshotTable(table) {
  const issues = [];
  if (!isPlainObject(table)) {
    issue(issues, '$', 'invalid_type', 'must be an object');
    return validationResult(issues);
  }
  for (const [id, entry] of Object.entries(table)) {
    const path = `$.${id}`;
    if (!COMMAND_ID_PATTERN.test(id)) issue(issues, path, 'invalid_format', 'must be a stable command ID');
    if (!isPlainObject(entry)) {
      issue(issues, path, 'invalid_type', 'must be an object');
      continue;
    }
    const keys = Object.keys(entry).sort();
    for (const key of ROW_KEYS) {
      if (!Object.hasOwn(entry, key)) issue(issues, `${path}.${key}`, 'missing_key', `missing required key: ${key}`);
    }
    for (const key of keys) {
      if (!ROW_KEYS.includes(key)) issue(issues, `${path}.${key}`, 'unknown_key', `unknown key: ${key}`);
    }
    if (!SNAPSHOT_TARGETS.includes(entry.target)) {
      issue(issues, `${path}.target`, 'invalid_value', `must be one of: ${SNAPSHOT_TARGETS.join(', ')}`);
    }
    if (!Array.isArray(entry.inputs)) {
      issue(issues, `${path}.inputs`, 'invalid_type', 'must be an array');
    } else {
      entry.inputs.forEach((input, index) => {
        const known = typeof input === 'string' && Object.hasOwn(SNAPSHOT_PROJECTIONS, input);
        if (!known) {
          issue(issues, `${path}.inputs[${index}]`, 'unknown_projection', 'must be a known projection ID');
          return;
        }
        const { scope } = SNAPSHOT_PROJECTIONS[input];
        if (scope !== 'global' && scope !== entry.target) {
          issue(issues, `${path}.inputs[${index}]`, 'scope_mismatch', `${input} needs a ${scope} target`);
        }
      });
      const ordered = entry.inputs.every((input, index) => index === 0 || (typeof input === 'string'
        && typeof entry.inputs[index - 1] === 'string' && compareStrings(entry.inputs[index - 1], input) < 0));
      if (!ordered) issue(issues, `${path}.inputs`, 'invalid_order', 'must be sorted and unique');
    }
    if (entry.lease_guard !== null && entry.lease_guard !== 'road' && entry.lease_guard !== 'plan') {
      issue(issues, `${path}.lease_guard`, 'invalid_value', 'must be null, road, or plan');
    } else if (entry.lease_guard !== null && entry.lease_guard !== entry.target) {
      issue(issues, `${path}.lease_guard`, 'scope_mismatch', 'must equal the row target');
    }
  }
  return validationResult(issues);
}

{
  const result = validateSnapshotTable(COMMAND_SNAPSHOT_TABLE);
  if (!result.ok) throw new ContractValidationError('snapshot table', result.issues);
}
