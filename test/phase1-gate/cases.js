// P1-W14 gate: one entry per protected multi-file mutation, driven through the REAL writers. `seed` builds the
// starting repository (canonical codec or finished earlier writers only); `run` performs the mutation under test with
// its own providers and an explicit request ID, so the crash worker (child) and the parent produce identical bytes.
// This module is inert: it only exports data.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRoad, createTask } from '../../lib/store/roads/index.js';
import { addMemory } from '../../lib/store/memory/index.js';
import { appendClosure } from '../../lib/store/log/index.js';
import { renderState, setState } from '../../lib/store/state/index.js';
import { setExecutor } from '../../lib/store/executors/index.js';
import { scaffoldWorkflow } from '../../lib/store/scaffold/index.js';
import { appendHandoff, defineVerification } from '../../lib/store/verification/index.js';
import { appendResult } from '../../lib/store/test-result/index.js';
import { finishPlan } from '../../lib/store/plan-finish/index.js';
import { doneIntent, workIntent, yieldIntent } from '../../lib/store/intents/index.js';
import { PLAN_SCHEMA, PLAN_SPEC } from '../../lib/schemas/plan.js';
import { canonicalizeJson, storedSpec, withMeta } from '../../lib/store/canonical/index.js';
import { commandSnapshot } from '../../lib/store/snapshots/index.js';
import { moveRoad } from '../../lib/store/roads/move.js';
import { updateRoad } from '../../lib/store/roads/update.js';
import { requestScope, resolveScope } from '../../lib/store/scope/writer.js';
import { authoringOptions, fakeProviders, roadInput, seedPlan, seedRoad, ulid } from '../road/support.js';
import { fileWrite, providersOf, readEntry, request, seedRoadWithTask, snapshotOf, updateForm } from '../change/support.js';
import { memoryInput } from '../memory/support.js';

// A repository handle over an existing temp directory (the crash worker rebuilds it in the child process).
export function repoAt(root) {
  return {
    root,
    options: { repositoryRoot: root, workflowRoot: join(root, 'akrs') },
    path: (...segments) => join(root, ...segments),
    read: (path) => readFile(join(root, path), 'utf8'),
    async write(path, data) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), data);
    },
  };
}

export const GATE_REQUEST_ID = ulid(7001);

const stdin = (document) => ({ stdin: Buffer.from(JSON.stringify(document)) });
// `firstId` selects the ID range of the run: a retry after a crash must not reuse the record IDs of the killed run.
const gateOptions = (repo, { firstId = 9000, freshRequest = false, ...extra } = {}) => authoringOptions(repo, {
  providers: fakeProviders({ firstId }), ...(freshRequest ? {} : { requestId: GATE_REQUEST_ID }), ...extra,
});
const contract = async (roads) => {
  const { meta: _meta, ...input } = JSON.parse(await readFile(new URL('../fixtures/schemas/verification/valid/full.json', import.meta.url), 'utf8'));
  return { ...input, roads };
};

export const CASES = Object.freeze({
  'road-new': {
    command: 'road new',
    seed: async () => {},
    run: (repo, extra) => createRoad({ ...gateOptions(repo, extra), channel: stdin(roadInput({ plan: null, task: null, id: 'R-GATE' })) }),
  },
  'task-new': {
    command: 'task new',
    seed: async (repo) => { await seedPlan(repo, 'P6'); await seedRoad(repo, { id: 'R-P6-1', plan: 'P6', task: 'T-P6-1' }, { folder: 'roads/P6' }); },
    run: (repo, extra) => createTask({
      ...gateOptions(repo, extra),
      channel: stdin({ schema: 'akrs.task/v1', id: 'T-P6-1', plan: 'P6', road: 'R-P6-1', objective: 'Build the admin page.', constraints: null, approach: null, notes: null }),
    }),
  },
  'road-update': {
    command: 'road update',
    seed: async (repo) => { await seedRoad(repo, { id: 'R-GATE' }); },
    // the snapshot the Leader read: a retry must send the same one, so it is computed once from the seeded state
    prepare: async (repo) => ({ expectedSnapshot: await snapshotOf(repo, 'road-update', 'R-GATE') }),
    run: async (repo, extra) => updateRoad({
      ...gateOptions(repo, extra), id: 'R-GATE', channel: stdin(await updateForm(repo, 'R-GATE', { boundaries: ['No backend change.', 'Gate edit.'] })),
    }),
  },
  'scope-request': {
    command: 'scope request',
    seed: async (repo) => { await seedRoad(repo, { id: 'R-GATE' }); },
    run: (repo, extra) => requestScope({
      ...gateOptions(repo, extra),
      channel: stdin({ schema: 'akrs.scope-request/v1', road: 'R-GATE', add_reads: [readEntry('src/own.js')], add_writes: [], reason: 'Need to read src/own.js.', blocking: true }),
    }),
  },
  'scope-approve': {
    command: 'scope approve',
    seed: async (repo) => {
      await seedRoad(repo, { id: 'R-GATE' });
      await request(repo, { road: 'R-GATE', add_reads: [readEntry('src/own.js')], add_writes: [fileWrite('src/new.js')] });
    },
    run: (repo, extra) => resolveScope({ ...gateOptions(repo, extra), mode: 'approve', target: 'R-GATE', reason: 'Agreed.' }),
  },
  'road-move': {
    command: 'road move',
    seed: async (repo) => { await seedRoadWithTask(repo); },
    run: (repo, extra) => moveRoad({ ...gateOptions(repo, extra), id: 'R-P6-1', plan: 'P7', apply: true }),
  },
  'memory-add': {
    command: 'memory add',
    seed: async () => {},
    run: (repo, extra) => addMemory({ ...gateOptions(repo, extra), channel: stdin(memoryInput()) }),
  },
  'log-append': {
    command: 'log append',
    seed: async () => {},
    run: (repo, extra) => appendClosure({
      ...gateOptions(repo, extra), document: { kind: 'road', subject: 'R-GATE', outcome: 'DONE', deviations: null },
    }),
  },
  'test-define': {
    command: 'test define',
    seed: async (repo) => {
      await seedPlan(repo, 'P6');
      await seedRoad(repo, { id: 'R-P6-1', plan: 'P6' }, { folder: 'roads/P6', status: 'ACTIVE' });
    },
    run: async (repo, extra) => defineVerification({ ...gateOptions(repo, extra), key: 'P6', channel: stdin(await contract(['R-P6-1'])) }),
  },
  'test-handoff': {
    command: 'test handoff',
    seed: async (repo) => {
      await seedPlan(repo, 'P6');
      await seedRoad(repo, { id: 'R-P6-1', plan: 'P6' }, { folder: 'roads/P6', status: 'ACTIVE' });
      await defineVerification({ ...authoringOptions(repo, { providers: providersOf(repo) }), key: 'P6', channel: stdin(await contract(['R-P6-1'])) });
    },
    run: (repo, extra) => appendHandoff({
      ...gateOptions(repo, extra), key: 'P6',
      channel: stdin({ schema: 'akrs.handoff/v1', road: 'R-P6-1', result: 'The admin page is reachable.', reach: ['Open /admin'], expect: 'The page lists reservations.' }),
    }),
  },
  // P2-W07: the Tester result is a transactional append like the handoff; a checks-policy contract needs no run
  'test-result': {
    command: 'test result',
    seed: async (repo) => {
      await seedPlan(repo, 'P6');
      await seedRoad(repo, { id: 'R-P6-1', plan: 'P6' }, { folder: 'roads/P6', status: 'DONE' });
      const verification = { ...(await contract(['R-P6-1'])), policy: 'checks', launch: null, setup: [], teardown: [], measurements: [], scenario: [], evidence_types: [] };
      await defineVerification({ ...authoringOptions(repo, { providers: providersOf(repo) }), key: 'P6', channel: stdin(verification) });
      await appendHandoff({
        ...authoringOptions(repo, { providers: providersOf(repo) }), key: 'P6',
        channel: stdin({ schema: 'akrs.handoff/v1', road: 'R-P6-1', result: 'The admin page is reachable.', reach: ['Open /admin'], expect: 'The page lists reservations.' }),
      });
    },
    run: (repo, extra) => appendResult({ ...gateOptions(repo, extra), key: 'P6', flat: { verdict: 'fail', because: 'The page does not list reservations.' } }),
  },
  // P2-W12: the Worker's finish (handoff, DONE status and closure) and its yield (the ledger record) are one transaction each; the lease
  // lives under .ops, outside the digest, and never joins the request, so a retry after the commit replays
  'done': {
    command: 'done',
    seed: async (repo) => {
      await setExecutor({ ...authoringOptions(repo, { providers: providersOf(repo) }), executor: { id: 'flash', role: 'worker', class: 'weak', label: 'Flash', user_answer: 'weak' }, setOverrides: [], clearOverrides: [] });
      await seedRoad(repo, { id: 'R-GATE', plan: null, task: null, writes: [fileWrite('src/own.js')], checks: [{ name: 'unit', argv: ['node', '-e', 'process.exit(0)'], timeout_ms: 30000 }] }, { status: 'ACTIVE' });
      const claimed = await workIntent({ ...authoringOptions(repo, { providers: providersOf(repo) }), road: 'R-GATE', executorFlag: 'flash' });
      if (claimed.packet.status !== 'ok') throw new Error(`the gate lease was not claimed: ${claimed.packet.status}`);
    },
    run: (repo, extra) => doneIntent({
      ...gateOptions(repo, extra), road: 'R-GATE', executorFlag: 'flash', baton: { result: 'The own file is ready.', reach: ['Open it'], expect: 'The change.' },
    }),
  },
  'yield': {
    command: 'yield',
    seed: async (repo) => {
      await setExecutor({ ...authoringOptions(repo, { providers: providersOf(repo) }), executor: { id: 'flash', role: 'worker', class: 'weak', label: 'Flash', user_answer: 'weak' }, setOverrides: [], clearOverrides: [] });
      await seedRoad(repo, { id: 'R-GATE', plan: null, task: null, writes: [fileWrite('src/own.js')] }, { status: 'ACTIVE' });
      const claimed = await workIntent({ ...authoringOptions(repo, { providers: providersOf(repo) }), road: 'R-GATE', executorFlag: 'flash' });
      if (claimed.packet.status !== 'ok') throw new Error(`the gate lease was not claimed: ${claimed.packet.status}`);
    },
    run: (repo, extra) => yieldIntent({ ...gateOptions(repo, extra), road: 'R-GATE', executorFlag: 'flash', reason: 'The Road is too big for its class.' }),
  },
  // P2-W08: the Plan close is one transaction over the Plan file and the closure ledger
  'plan-finish': {
    command: 'plan finish',
    seed: async (repo) => {
      await seedPlan(repo, 'P6');
      await repo.write('SOT/10-budgets.md', 'frame budget 16ms\n');
      const plan = withMeta({ schema: PLAN_SCHEMA, id: 'P6', title: 'Plan P6', questions: [], seams: [], findings: [], closure: { status: 'open', at: null, operation: null } },
        { schema: PLAN_SCHEMA, generator: 'akrs/2.0.0-alpha.0', spec: PLAN_SPEC });
      await repo.write('akrs/plans/P6.json', canonicalizeJson(plan, storedSpec(PLAN_SPEC)));
      await seedRoad(repo, { id: 'R-P6-1', plan: 'P6' }, { folder: 'roads/P6', status: 'DONE' });
      const verification = { ...(await contract(['R-P6-1'])), policy: 'checks', launch: null, setup: [], teardown: [], measurements: [], scenario: [], evidence_types: [] };
      await defineVerification({ ...authoringOptions(repo, { providers: providersOf(repo) }), key: 'P6', channel: stdin(verification) });
      await appendHandoff({
        ...authoringOptions(repo, { providers: providersOf(repo) }), key: 'P6',
        channel: stdin({ schema: 'akrs.handoff/v1', road: 'R-P6-1', result: 'The admin page is reachable.', reach: ['Open /admin'], expect: 'The page lists reservations.' }),
      });
      const recorded = await appendResult({ ...authoringOptions(repo, { providers: providersOf(repo) }), key: 'P6', flat: { verdict: 'pass', because: 'The page lists reservations.' } });
      if (recorded.outcome !== 'committed') throw new Error(`the pass was not recorded: ${JSON.stringify(recorded.packet.findings)}`);
    },
    // the snapshot the Leader read: a retry must send the same one, so it is computed once from the seeded state
    prepare: async (repo) => ({ expectedSnapshot: (await commandSnapshot('plan-finish', { ...repo.options, target: { plan: 'P6' } })).snapshot }),
    run: (repo, extra) => finishPlan({ ...gateOptions(repo, extra), key: 'P6' }),
  },
  'state-set': {
    command: 'state set',
    seed: async () => {},
    run: (repo, extra) => setState({ ...gateOptions(repo, extra), changes: { mode: 3, role: 'leader', next: 'Wire the work list.' }, clear: [] }),
  },
  'state-render': {
    command: 'state render',
    // the request names the STATE.md bytes it saw, so after a commit the same request ID is a conflict by design;
    // a retry then comes as a fresh request, which must find nothing left to do
    forwardRetry: 'fresh_request',
    seed: async (repo) => { await setState({ ...authoringOptions(repo, { providers: providersOf(repo) }), changes: { next: 'Seeded.' }, clear: [] }); await repo.write('akrs/STATE.md', 'hand edited\n'); },
    run: (repo, extra) => renderState({ ...gateOptions(repo, extra) }),
  },
  'executor-set': {
    command: 'executor set',
    seed: async () => {},
    run: (repo, extra) => setExecutor({
      ...gateOptions(repo, extra),
      executor: { id: 'flash', role: 'worker', class: 'weak', label: 'DeepSeek Flash', user_answer: 'weak — cheap, needs small steps' },
      setOverrides: [], clearOverrides: [],
    }),
  },
  'init-scaffold': {
    command: 'init --scaffold',
    emptyWorkflow: true,
    // Written by the scaffold under the lock but outside the workflow transaction (an idempotent managed block in a
    // user-owned file): compared separately, never as part of the workflow tree.
    outside: ['.gitignore'],
    seed: async (repo) => { await mkdir(repo.path('akrs'), { recursive: true }); },
    run: (repo, extra) => scaffoldWorkflow({ ...gateOptions(repo, extra), plan: null, road: null, force: false }),
  },
});

export const CASE_IDS = Object.freeze(Object.keys(CASES));
