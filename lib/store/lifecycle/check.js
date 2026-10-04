// `road check`: the readiness of one Road and the legal transitions from its status. A query: it reads the Leader packet
// (the one source of readiness) and writes nothing, not even a lease or a cache.
//
// checkRoad(options) -> { problem } | { status, data, findings, nextCommands, snapshot }
//   options: { repositoryRoot, workflowRoot, id, env?, rootArgs? }
import { isId } from '../../schemas/common.js';
import { buildRoadDetails } from '../road-details/index.js';
import { commandSnapshot } from '../snapshots/index.js';
import { LIFECYCLE_FINDING_CODE, LIFECYCLE_TRANSITIONS } from './policy.js';
import { LIFECYCLE_NEXT_COMMAND_BUILDERS } from './next-commands.js';

export const lifecycleFinding = ({ road, transition, reason, subject = null, message, file = null }) => ({
  code: LIFECYCLE_FINDING_CODE, severity: 'error', message, file, line: null, detail: { road, transition, reason, subject },
});

const BLOCKER_MESSAGES = {
  class_fit: (subject) => `The Road does not fit its executor class (${subject}); split it or change its class.`,
  dependency_cycle: (subject) => `The Road is in a dependency cycle: ${subject}.`,
  dependency_missing: (subject) => `The dependency ${subject} does not exist.`,
  dependency_not_done: (subject) => `The dependency ${subject} is not DONE.`,
  executor_class_missing: () => 'The Road has no executor class, so no executor is known to fit it.',
  executors_unusable: () => 'executors.json does not verify, so the class profile cannot be applied.',
  no_executor_for_class: (subject) => `No Worker executor of class ${subject} is recorded.`,
  read_unresolved: (subject) => `The declared read ${subject} is unresolved.`,
  road_unverified: (subject) => `The Road file ${subject} does not verify (hand-edited or invalid).`,
  snapshot_unstable: () => 'The workflow changed while the snapshot was read; ask again.',
  road_ambiguous: (subject) => `The Road exists in more than one file: ${subject}.`,
};

export const blockerFindings = (road, transition, blockers) => blockers.map(({ reason, subject }) => lifecycleFinding({
  road, transition, reason, subject, message: (BLOCKER_MESSAGES[reason] ?? (() => `The Road is blocked: ${reason}.`))(subject),
}));

// The Leader readiness of a Road: { problem } | { details, blockers, ready }. One reader for check and for activate.
export async function readReadiness({ repositoryRoot, workflowRoot, id, env = process.env, rootArgs = [] }) {
  const result = await buildRoadDetails({ repositoryRoot, workflowRoot, id, role: 'leader', env, rootArgs });
  if (result.problem !== undefined) return { problem: result.problem };
  const { data } = result;
  const blockers = data.kind === 'road_details' ? data.readiness.blockers : data.blockers;
  return { details: result, data, blockers, ready: data.kind === 'road_details' && data.readiness.ready };
}

export async function checkRoad(options) {
  const { repositoryRoot, workflowRoot, id, env = process.env, rootArgs = [] } = options;
  if (!isId(id)) throw new TypeError('id must be a valid ID');
  const base = { repositoryRoot, workflowRoot };
  const read = await readReadiness({ ...base, id, env, rootArgs });
  if (read.problem !== undefined) return { problem: read.problem };
  const { data, blockers, ready } = read;
  const builder = LIFECYCLE_NEXT_COMMAND_BUILDERS['road-check'];
  if (data.kind !== 'road_details') {
    const snapshot = read.details.snapshot;
    return {
      status: 'blocked',
      data: { kind: 'road_check', road: null, ready: false, needs_split: false, class_fit: null, readiness: { ready: false, blockers }, transitions: [] },
      findings: blockerFindings(id, 'check', blockers),
      nextCommands: builder({ phase: 'blocked', id, rootArgs }),
      snapshot,
    };
  }
  const { road } = data;
  const transitions = Object.entries(LIFECYCLE_TRANSITIONS).map(([command, row]) => {
    const fromStatus = row.from.includes(road.status);
    const held = row.verb === 'activate' && fromStatus ? blockers : [];
    return {
      command, verb: row.verb, from: [...row.from], to: row.to, legal: fromStatus && held.length === 0, blockers: held.map((entry) => ({ ...entry })), requires: [...row.requires],
    };
  });
  const blocked = road.status === 'QUEUED' && !ready;
  const snapshot = (await commandSnapshot('road-activate', { ...base, target: { road: id } })).snapshot;
  return {
    status: blocked ? 'blocked' : 'ok',
    data: {
      kind: 'road_check',
      road: { id: road.id, plan: road.plan, status: road.status, contract: road.contract, executor_class: road.executor_class, path: road.path },
      ready,
      needs_split: data.needs_split,
      class_fit: data.class_fit,
      readiness: { ready, blockers: blockers.map((entry) => ({ ...entry })) },
      transitions,
    },
    findings: blocked ? blockerFindings(id, 'check', blockers) : [],
    nextCommands: blocked ? builder({ phase: 'blocked', id, rootArgs }) : builder({ phase: 'ready', id, status: road.status, snapshot, rootArgs }),
    snapshot: read.details.snapshot,
  };
}
