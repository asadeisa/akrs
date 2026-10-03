// Workflow-relative location of a Memory topic file (MEMORY_STORE_POLICY.location).
import { isId } from '../../schemas/common.js';
import { MEMORY_DIRECTORY } from './policy.js';

export function memoryPath(topic) {
  if (!isId(topic)) throw new TypeError('topic must be a valid ID');
  return `${MEMORY_DIRECTORY}/${topic}.md`;
}
