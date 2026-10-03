// Workflow-relative locations of the artifacts these writers own (ROAD_STORE_POLICY, TASK_STORE_POLICY).
import { isId } from '../../schemas/common.js';
import { DRAFT_DIRECTORY, ROAD_DIRECTORY, TASK_DIRECTORY } from './policy.js';

const need = (value, label) => {
  if (!isId(value)) throw new TypeError(`${label} must be a valid ID`);
  return value;
};

// roads/<plan>/<id>.json with a Plan, roads/<id>.json without one.
export function roadPath({ id, plan = null }) {
  need(id, 'id');
  if (plan === null || plan === undefined) return `${ROAD_DIRECTORY}/${id}.json`;
  return `${ROAD_DIRECTORY}/${need(plan, 'plan')}/${id}.json`;
}

export const taskPath = (id) => `${TASK_DIRECTORY}/${need(id, 'id')}.md`;
export const draftPath = (name) => `${DRAFT_DIRECTORY}/${need(name, 'draft name')}.json`;
export const isDraftName = (name) => isId(name);

// Repository-relative form of a workflow-relative path (`workflowRelative` is '' when the workflow is the repository).
export const inRepository = (workflowRelative, path) => (workflowRelative === '' ? path : `${workflowRelative}/${path}`);
