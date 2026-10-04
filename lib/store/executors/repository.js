// Executors reader API: the document through the canonical codec plus the derived `unclassified` flag and Leader class.
import { EXECUTORS_SPEC, validateExecutors } from '../../schemas/executors.js';
import { normalizeInput, parseStrictJson, verifyMeta } from '../canonical/index.js';
import { createPathService } from '../path-service.js';
import { workflowOption } from '../roads/repository.js';
import { locate } from '../verification/repository.js';
import { CLASS_ORDER, EXECUTORS_FILE } from './policy.js';

// { path, exists, text, document|null, meta_state, issues, problem, executors, class_overrides, unclassified, leader_class }
export async function readExecutors({ repositoryRoot, workflowRoot }) {
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const file = await locate(service, EXECUTORS_FILE);
  const result = {
    path: file.path, workflow_path: file.workflow_path, exists: file.exists, text: file.text, document: null, meta_state: null, issues: [], problem: file.problem,
    executors: [], class_overrides: {}, unclassified: true, leader_class: null,
  };
  if (file.text === null) return result;
  const normalized = normalizeInput(Buffer.from(file.text));
  const parsed = normalized.ok ? parseStrictJson(normalized.text) : normalized;
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return { ...result, meta_state: 'unverified', problem: 'invalid_json', issues: [{ path: '$', code: 'invalid_json', message: 'executors.json is not a JSON object' }] };
  }
  const issues = validateExecutors(parsed.value, { form: 'stored', ...workflowOption(service) }).issues.map((entry) => ({ ...entry }));
  const declared = issues.length === 0 && verifyMeta(parsed.value, { spec: EXECUTORS_SPEC }) === 'declared';
  if (!declared) return { ...result, document: parsed.value, meta_state: 'unverified', issues };
  const { executors, class_overrides: overrides } = parsed.value;
  const leaders = executors.filter(({ role }) => role === 'leader');
  const leaderClass = leaders.length === 0 ? null : CLASS_ORDER[Math.min(...leaders.map((entry) => CLASS_ORDER.indexOf(entry.class)))];
  return {
    ...result,
    document: parsed.value,
    meta_state: 'declared',
    executors,
    class_overrides: overrides,
    unclassified: leaders.length === 0 || !executors.some(({ role }) => role === 'worker'),
    leader_class: leaderClass,
  };
}

export function unclassifiedFinding() {
  return {
    code: 'AKRS-S006',
    severity: 'warning',
    message: 'No executor is classified (a usable executors.json with at least one leader and one worker is missing): ask the user to classify each model as weak, medium or frontier, then record it with executor set.',
    file: null,
    line: null,
    detail: { has_leader: false, has_worker: false },
  };
}
