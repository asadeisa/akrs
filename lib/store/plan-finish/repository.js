// Reads one Plan file (plans/<key>.json) through the canonical codec: { path, workflow_path, exists, plan|null, meta_state, issues, problem }.
import { PLAN_SPEC, validatePlan } from '../../schemas/plan.js';
import { normalizeInput, parseStrictJson, verifyMeta } from '../canonical/index.js';
import { createPathService } from '../path-service.js';
import { locate } from '../verification/repository.js';

export const planPath = (key) => `plans/${key}.json`;

export async function readPlan({ repositoryRoot, workflowRoot, key }) {
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const file = await locate(service, planPath(key));
  const result = { path: file.path, workflow_path: file.workflow_path, exists: file.exists, text: file.text, plan: null, meta_state: null, issues: [], problem: file.problem };
  if (file.text === null) return result;
  const normalized = normalizeInput(Buffer.from(file.text));
  const parsed = normalized.ok ? parseStrictJson(normalized.text) : normalized;
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return { ...result, meta_state: 'unverified', problem: 'invalid_json', issues: [{ path: '$', code: 'invalid_json', message: 'the Plan file is not a JSON object' }] };
  }
  const plan = parsed.value;
  const issues = validatePlan(plan, { form: 'stored' }).issues.map((entry) => ({ ...entry }));
  if (plan.id !== key) issues.push({ path: '$.id', code: 'invalid_value', message: 'must equal the file name' });
  const declared = issues.length === 0 && verifyMeta(plan, { spec: PLAN_SPEC }) === 'declared';
  return { ...result, plan, meta_state: declared ? 'declared' : 'unverified', issues };
}
