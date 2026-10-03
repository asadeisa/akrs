// Task scaffold: narrative Markdown generated only from the submitted Task fields. The first line is the identity
// marker; the rest is headings, the agent's prose and pointers to the Road, which owns everything executable.
// Nothing here reads prose back into an executable field: readTask returns the identity marker only.
import { readFile } from 'node:fs/promises';
import { isId, validateWorkflowPath } from '../../schemas/common.js';
import { TASK_SCHEMA, validateTaskInput } from '../../schemas/road.js';
import { canonicalizeJsonCompact, parseStrictJson } from '../canonical/index.js';
import { createPathService } from '../path-service.js';
import { taskPath } from './paths.js';
import { GENERATOR, TASK_MARKER_PREFIX, TASK_MARKER_SUFFIX } from './policy.js';

const MARKER_KEYS = Object.freeze(['schema', 'id', 'plan', 'road', 'generator']);
const MARKER_SPEC = Object.freeze({ keys: [...MARKER_KEYS], arrays: {}, objects: {} });
const GENERATOR_PATTERN = /^akrs\/[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?$/;
const NOT_PROVIDED = '_Not provided._';
const need = (value, message) => {
  if (!value) throw new TypeError(message);
};

const prose = (text) => (text === null ? NOT_PROVIDED : text.replace(/\r\n?/g, '\n').replace(/\n+$/, ''));

export function renderTaskScaffold(task, { roadPath, generator = GENERATOR } = {}) {
  need(task !== null && typeof task === 'object', 'a Task document is required');
  const verdict = validateTaskInput(task);
  need(verdict.ok, `Task input is invalid: ${verdict.issues.map(({ path, message }) => `${path} ${message}`).join('; ')}`);
  need(typeof roadPath === 'string' && roadPath.endsWith('.json') && validateWorkflowPath(roadPath).ok && !roadPath.includes('`'),
    'roadPath must be the normalized repository-relative path of the Road file');
  const marker = canonicalizeJsonCompact({
    schema: TASK_SCHEMA, id: task.id, plan: task.plan, road: task.road, generator,
  }, MARKER_SPEC);
  return `${[
    `${TASK_MARKER_PREFIX}${marker}${TASK_MARKER_SUFFIX}`,
    `# Task ${task.id}`,
    '',
    `- Road: \`${roadPath}\``,
    '- The Road owns everything executable: `reads`, `writes`, `forbidden`, `checks`, `acceptance`, `boundaries` and `steps`. This Task never restates them.',
    '',
    '## Objective',
    '',
    prose(task.objective),
    '',
    '## Constraints',
    '',
    prose(task.constraints),
    '',
    '## Approach',
    '',
    prose(task.approach),
    '',
    `Executable steps are not written here: follow \`steps\` in \`${roadPath}\`.`,
    '',
    '## Notes',
    '',
    prose(task.notes),
  ].join('\n')}\n`;
}

// The closed identity shape of the first line, or null. Later lines (including forged markers) never count.
export function parseTaskMarker(text) {
  if (typeof text !== 'string') return null;
  const [first] = text.replace(/^﻿/, '').replaceAll('\r\n', '\n').split('\n');
  if (!first.startsWith(TASK_MARKER_PREFIX) || !first.endsWith(TASK_MARKER_SUFFIX)) return null;
  const parsed = parseStrictJson(first.slice(TASK_MARKER_PREFIX.length, first.length - TASK_MARKER_SUFFIX.length));
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return null;
  const marker = parsed.value;
  const keys = Object.keys(marker);
  if (keys.length !== MARKER_KEYS.length || !MARKER_KEYS.every((key) => keys.includes(key))) return null;
  if (marker.schema !== TASK_SCHEMA || !isId(marker.id) || !isId(marker.road)) return null;
  if (marker.plan !== null && !isId(marker.plan)) return null;
  if (typeof marker.generator !== 'string' || !GENERATOR_PATTERN.test(marker.generator)) return null;
  return Object.fromEntries(MARKER_KEYS.map((key) => [key, marker[key]]));
}

// { id, plan, road, path, meta_state } or null. `declared` means the marker is the closed identity shape and names
// this very file; otherwise `unverified` with no identity: it is never recovered from prose.
export async function readTask({ repositoryRoot, workflowRoot, id }) {
  need(isId(id), 'id must be a valid ID');
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const resolved = await service.resolveWorkflowPath(taskPath(id));
  if (!resolved.exists || !resolved.case_matches) return null;
  const marker = parseTaskMarker((await readFile(resolved.filesystem_path)).toString('utf8'));
  const path = resolved.relative_path;
  if (marker === null || marker.id !== id) return { id, plan: null, road: null, path, meta_state: 'unverified' };
  return { id, plan: marker.plan, road: marker.road, path, meta_state: 'declared' };
}
