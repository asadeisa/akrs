// Workflow-relative locations of the Tester sources (VERIFICATION_STORE_POLICY.location).
import { isId } from '../../schemas/common.js';
import { VERIFICATION_DIRECTORY } from './policy.js';

const need = (key) => {
  if (!isId(key)) throw new TypeError('key must be a valid ID');
  return key;
};
export const contractPath = (key) => `${VERIFICATION_DIRECTORY}/${need(key)}/contract.json`;
export const handoffPath = (key) => `${VERIFICATION_DIRECTORY}/${need(key)}/handoff.jsonl`;
export const resultsPath = (key) => `${VERIFICATION_DIRECTORY}/${need(key)}/results.jsonl`;
