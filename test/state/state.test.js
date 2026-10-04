import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateState } from '../../lib/schemas/state.js';
import { STATE_FINDING_CODE, deriveState, readState, renderStateMarkdown } from '../../lib/store/state/index.js';
import { commandSnapshot } from '../../lib/store/snapshots/index.js';
import {
  closeOut, createRepo, everything, render, request, reasons, seedPlan, seedRoad, set, stateJson, stateMd, strict,
} from './support.js';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

async function world(t) {
  const repo = await createRepo(t);
  await seedPlan(repo, 'P6');
  await seedRoad(repo, { id: 'R-P6-1', plan: 'P6' }, { folder: 'roads/P6', status: 'ACTIVE' });
  await seedRoad(repo, { id: 'R-P6-2', plan: 'P6', deps: ['R-P6-1'] }, { folder: 'roads/P6', status: 'QUEUED' });
  await seedRoad(repo, { id: 'R-P6-0', plan: 'P6' }, { folder: 'roads/P6', status: 'DONE' });
  await seedRoad(repo, { id: 'R-P6-3', plan: 'P6', deps: ['R-P6-0'] }, { folder: 'roads/P6', status: 'QUEUED' });
  return repo;
}

test('state set creates state.json and STATE.md in ONE transaction: Leader-owned fields round-trip', async (t) => {
  const repo = await createRepo(t);
  const result = await set(repo, { mode: 3, role: 'leader', plan: 'P6', phase: 'Content', task: 'T-P6-1', next: 'Wire the work list.' }, { by: 'claude-code' });
  assert.equal(result.outcome, 'committed');
  assert.equal(result.packet.status, 'ok');
  assert.deepEqual(result.packet.changed, ['STATE.md', 'state.json']);
  const state = await stateJson(repo);
  assert.equal(validateState(state, { form: 'stored' }).ok, true);
  assert.deepEqual({ ...state, updated: null, meta: null }, {
    schema: 'akrs.state/v1', mode: 3, role: 'leader', plan: 'P6', phase: 'Content', task: 'T-P6-1', next: 'Wire the work list.', updated: null, meta: null,
  });
  assert.equal(state.updated.by, 'claude-code');
  assert.equal(result.packet.data.state.meta_state, 'declared');
  const read = await readState({ ...repo.options });
  assert.equal(read.meta_state, 'declared');
  assert.match(await stateMd(repo), /^# STATE\n/);
});

test('a partial set keeps the other fields; --clear nulls a nullable field; the defaults of a first set are explicit', async (t) => {
  const repo = await createRepo(t);
  await set(repo, { next: 'First.' });
  assert.deepEqual(
    (({ mode, role, plan, phase, task, next }) => ({ mode, role, plan, phase, task, next }))(await stateJson(repo)),
    { mode: 0, role: 'leader', plan: null, phase: null, task: null, next: 'First.' },
  );
  await set(repo, { plan: 'P6', phase: 'Content' });
  await set(repo, { mode: 2 }, { clear: ['phase'] });
  const state = await stateJson(repo);
  assert.equal(state.mode, 2);
  assert.equal(state.plan, 'P6');
  assert.equal(state.phase, null);
  assert.equal(state.next, 'First.');
});

test('free text keeps Unicode and newlines verbatim in state.json and line for line in STATE.md', async (t) => {
  const repo = await createRepo(t);
  const text = 'سطر أول 🚀\néclair — ünïcode\n\n  indented\twith tab\r\nlast line without end';
  const result = await set(repo, { next: text, phase: 'مرحلة\nاثنين' });
  assert.equal(result.outcome, 'committed');
  const state = await stateJson(repo);
  assert.equal(state.next, text);
  assert.equal(state.phase, 'مرحلة\nاثنين');
  const md = await stateMd(repo);
  assert.equal(md.includes('\r'), false, 'STATE.md uses LF only');
  for (const line of text.split(/\r\n|\r|\n/)) assert.equal(md.includes(line === '' ? '>\n' : `> ${line}\n`), true, JSON.stringify(line));
});

test('derived facts come from the canonical artifacts, never from state.json or the old STATE.md', async (t) => {
  const repo = await world(t);
  await set(repo, { plan: 'P6', next: 'Finish the admin page.' });
  const md = await stateMd(repo);
  assert.match(md, /R-P6-1/);
  assert.match(md, /Ready[^\n]*\n(?:.*\n)*?.*R-P6-3/, 'a QUEUED Road whose deps are DONE is ready');
  assert.doesNotMatch(md.split('## Ready')[1] ?? '', /R-P6-2/, 'R-P6-2 waits for R-P6-1');
  assert.deepEqual(Object.keys(await stateJson(repo)), ['schema', 'mode', 'role', 'plan', 'phase', 'task', 'next', 'updated', 'meta']);
  assert.equal(JSON.stringify(await stateJson(repo)).includes('R-P6-1'), false, 'nothing derived is stored');

  await closeOut(repo, { kind: 'road', subject: 'R-P6-0', outcome: 'DONE' });
  await closeOut(repo, { kind: 'road', subject: 'R-P6-9', outcome: 'BLOCKED', deviations: 'needs a decision' });
  await request(repo, { road: 'R-P6-1', add_reads: [{ path: 'SOT/02-rules.md', lines: null, why: 'rules' }], blocking: true });
  const done = await render(repo);
  assert.equal(done.outcome, 'committed');
  assert.deepEqual(done.packet.changed, ['STATE.md']);
  const fresh = await stateMd(repo);
  assert.match(fresh, /## Done[^]*R-P6-0/);
  assert.match(fresh, /## Blockers[^]*R-P6-9[^]*R-P6-1/, 'a BLOCKED closure and a pending blocking scope request');
});

test('state render is byte-identical on repeat and replaces a hand-edited STATE.md without reading it', async (t) => {
  const repo = await world(t);
  await set(repo, { plan: 'P6', next: 'Go.' });
  const first = await stateMd(repo);
  const again = await render(repo);
  assert.equal(again.outcome, 'rejected');
  assert.deepEqual(reasons(again.packet), ['no_change']);
  assert.equal(await stateMd(repo), first);
  await repo.write('akrs/STATE.md', '# STATE\nActive: R-FAKE\n\nthis is stale and wrong\n');
  const replaced = await render(repo);
  assert.equal(replaced.outcome, 'committed');
  assert.equal(await stateMd(repo), first, 'the render equals the canonical output byte for byte');
  const inputs = { state: (await readState({ ...repo.options })).state, derived: await deriveState({ ...repo.options }) };
  assert.equal(renderStateMarkdown(inputs), renderStateMarkdown(inputs));
  assert.equal(renderStateMarkdown(inputs), first);
  assert.equal(first.endsWith('\n') && !first.endsWith('\n\n'), true);
});

test('the same inputs in two repositories render the same bytes', async (t) => {
  const left = await world(t);
  const right = await world(t);
  await set(left, { plan: 'P6', next: 'Same.' }, { by: 'x' });
  await set(right, { plan: 'P6', next: 'Same.' }, { by: 'x' });
  assert.equal(await stateMd(left), await stateMd(right));
});

test('render refuses without a usable state.json and writes nothing', async (t) => {
  const repo = await world(t);
  const before = await everything(repo);
  const missing = await render(repo);
  assert.equal(missing.outcome, 'rejected');
  assert.deepEqual(reasons(missing.packet), ['state_missing']);
  assert.deepEqual(await everything(repo), before);
  await set(repo, { next: 'ok' });
  const text = await repo.read('akrs/state.json');
  await repo.write('akrs/state.json', text.replace('"ok"', '"hand edited"'));
  const tampered = await render(repo);
  assert.deepEqual(reasons(tampered.packet), ['state_unusable']);
  const set2 = await set(repo, { next: 'again' });
  assert.deepEqual(reasons(set2.packet), ['state_unusable']);
  assert.equal(STATE_FINDING_CODE, 'AKRS-S004');
});

test('invalid field values and an empty set write nothing', async (t) => {
  const repo = await createRepo(t);
  const before = await strict(repo);
  for (const changes of [{ mode: 9 }, { role: 'boss' }, { plan: 'not an id' }, { next: '' }, {}]) {
    const result = await set(repo, changes);
    assert.equal(result.outcome, 'rejected', JSON.stringify(changes));
    assert.equal(result.packet.data.kind, 'usage');
  }
  const unknownClear = await set(repo, { mode: 1 }, { clear: ['mode'] });
  assert.equal(unknownClear.outcome, 'rejected');
  assert.deepEqual(await strict(repo), before);
});

test('dry run previews the exact files; retry and stale snapshot write nothing', async (t) => {
  const repo = await createRepo(t);
  const before = await strict(repo);
  const dry = await set(repo, { next: 'Preview.' }, { dryRun: true });
  assert.equal(dry.outcome, 'dry_run');
  assert.deepEqual(dry.packet.data.would_change, ['STATE.md', 'state.json']);
  assert.deepEqual(await strict(repo), before);

  const first = await set(repo, { next: 'Real.' }, { requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
  const after = await everything(repo);
  const retry = await set(repo, { next: 'Real.' }, { requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
  assert.equal(first.outcome, 'committed');
  assert.equal(retry.packet.status, 'noop');
  assert.deepEqual(await everything(repo), after);

  const stale = await set(repo, { next: 'Stale.' }, { expectedSnapshot: `sha256:${'0'.repeat(64)}` });
  assert.equal(stale.packet.status, 'blocked');
  assert.deepEqual(await everything(repo), after);
  const guard = (await commandSnapshot('state-set', { ...repo.options })).snapshot;
  const guarded = await set(repo, { next: 'Guarded.' }, { expectedSnapshot: guard });
  assert.equal(guarded.outcome, 'committed');
  assert.match(guarded.packet.data.state.updated_at, /^\d{4}-/);
  assert.match(guarded.packet.request_id, ULID);
});
