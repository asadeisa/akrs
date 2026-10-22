import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildScaffold } from '../../lib/store/scaffold/index.js';
import { derivedNext, renderStateMarkdown } from '../../lib/store/state/render.js';

const road = (id, status, extra = {}) => ({ id, plan: 'P1', status, deps: [], path: `akrs/roads/P1/${id}.json`, ...extra });
const base = { roads: [], closures: [], pending: [], plans: [] };

test('the derived Next follows the workflow: scope decision, ACTIVE Road, ready Road, then the Plan test and close', () => {
  assert.equal(derivedNext(base), null, 'an empty workflow has nothing to say');
  assert.match(derivedNext({ ...base, roads: [road('R1', 'QUEUED')] }), /^Activate Road R1 \(akrs road activate R1\)\.$/);
  assert.match(derivedNext({ ...base, roads: [road('R1', 'ACTIVE')] }), /^Road R1 is ACTIVE: the executor runs work, then done\.$/);
  assert.match(derivedNext({ ...base, roads: [road('R1', 'ACTIVE'), road('R2', 'ACTIVE')] }), /^Road R1, R2 are ACTIVE/);
  assert.match(
    derivedNext({ ...base, roads: [road('R1', 'ACTIVE')], pending: [{ road: 'R1', id: 'S1', blocking: true }] }),
    /^Decide the blocking scope request on Road R1 \(akrs scope list R1\)\.$/,
  );
  const done = { ...base, roads: [road('R1', 'DONE')], plans: [{ key: 'P1', policy: 'none', contract: true, handoffs: 1, ready: true }] };
  assert.match(derivedNext(done), /^Every Road is DONE: the Tester runs akrs test-details P1, then the Leader closes the Plan \(akrs plan finish P1\)\.$/);
  assert.equal(derivedNext({ ...done, closures: [{ kind: 'plan', subject: 'P1', outcome: 'DONE' }] }), null, 'a closed Plan leaves nothing open');
});

test('an explicit state.json next always wins over the derived one', () => {
  const state = { mode: 0, role: 'leader', plan: 'P1', phase: null, task: null, next: 'Ship the thing.', updated: { at: '2026-10-03T10:00:00.000Z', by: 'x' } };
  const untrusted = { roads: 0, closures: 0, sources: 0 };
  const derived = { ...base, roads: [road('R1', 'ACTIVE')], untrusted };
  assert.match(renderStateMarkdown({ state, derived }), /## Next\n> Ship the thing\.\n/);
  assert.match(renderStateMarkdown({ state: { ...state, next: null }, derived }), /## Next\n> Road R1 is ACTIVE/);
});

test('the scaffold stores no frozen next note; its STATE.md derives one', () => {
  const built = buildScaffold({ workflowRelative: 'akrs', plan: 'P1', now: '2026-10-03T10:00:00.000Z' });
  const state = JSON.parse(built.files.find(({ path }) => path === 'state.json').content);
  assert.equal(state.next, null);
  const markdown = built.files.find(({ path }) => path === 'STATE.md').content;
  assert.equal(markdown.includes('classify the executors'), false);
  assert.match(markdown, /## Next\n> Activate Road R-P1-1 \(akrs road activate R-P1-1\)\./);
});
