import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateExecutors } from '../../lib/schemas/executors.js';
import { EXECUTOR_FINDING_CODES, readExecutors, unclassifiedFinding } from '../../lib/store/executors/index.js';
import { commandSnapshot } from '../../lib/store/snapshots/index.js';
import { assertFindingsMatchCatalog } from '../road/support.js';
import { createRepo, everything, executorsFile, flash, lead, removeExec, runCommand, seedPlan, seedRoad, setExec } from './support.js';

const reasons = (packet) => packet.findings.filter(({ code }) => code === EXECUTOR_FINDING_CODES.guard).map(({ detail }) => detail.reason);

test('executor set records exactly the user-supplied class and words; nothing is inferred from the label', async (t) => {
  const repo = await createRepo(t);
  const tricky = { id: 'flash', role: 'worker', class: 'frontier', label: 'a weak tiny flash model', user_answer: 'frontier — سطر أول 🚀\nسطر ثاني' };
  const result = await setExec(repo, tricky);
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(result.packet.changed, ['executors.json']);
  const file = await executorsFile(repo);
  assert.equal(validateExecutors(file, { form: 'stored' }).ok, true);
  assert.deepEqual(file.executors, [tricky]);
  assert.deepEqual(file.class_overrides, {});
  assert.equal((await readExecutors(repo.options)).meta_state, 'declared');
});

test('invalid class, role, missing user_answer, unknown knob or class write nothing', async (t) => {
  const repo = await createRepo(t);
  const before = await everything(repo);
  const cases = [
    [{ ...flash, class: 'genius' }, {}],
    [{ ...flash, role: 'boss' }, {}],
    [{ ...flash, user_answer: undefined }, {}],
    [{ ...flash, user_answer: '   ' }, {}],
    [flash, { setOverrides: [{ class: 'weak', knob: 'max_tokens', value: 5 }] }],
    [flash, { setOverrides: [{ class: 'tiny', knob: 'max_writes', value: 5 }] }],
    [flash, { setOverrides: [{ class: 'weak', knob: 'max_writes', value: 0 }] }],
  ];
  for (const [executor, extra] of cases) {
    const result = await setExec(repo, executor, extra);
    assert.equal(result.outcome, 'rejected', JSON.stringify([executor, extra]));
    assert.equal(result.packet.data.kind, 'usage');
  }
  assert.deepEqual(await everything(repo), before);
});

test('overrides change numbers only: set, clear, list shows the effective profile; remove and no-change refusals', async (t) => {
  const repo = await createRepo(t);
  await setExec(repo, flash);
  await setExec(repo, lead);
  const set = await setExec(repo, null, { setOverrides: [{ class: 'weak', knob: 'max_writes', value: 2 }] });
  assert.equal(set.outcome, 'committed');
  assert.deepEqual((await executorsFile(repo)).class_overrides, { weak: { max_writes: 2 } });
  const listed = JSON.parse((await runCommand(repo, ['executor', 'list', '--json'])).stdout);
  assert.equal(listed.data.profiles.weak.max_writes, 2);
  assert.equal(listed.data.profiles.weak.max_write_dirs, 1);
  assert.equal(listed.data.profiles.medium.max_writes, 8);
  assert.equal(listed.data.unclassified, false);
  assert.equal(listed.data.executors.length, 2);
  const again = await setExec(repo, null, { setOverrides: [{ class: 'weak', knob: 'max_writes', value: 2 }] });
  assert.equal(again.packet.status, 'noop', 'an identical retried request replays from the journal');
  const nothing = await setExec(repo, null, { clearOverrides: [{ class: 'medium', knob: 'max_writes' }] });
  assert.deepEqual(reasons(nothing.packet), ['no_change']);
  const cleared = await setExec(repo, null, { clearOverrides: [{ class: 'weak', knob: 'max_writes' }] });
  assert.equal(cleared.outcome, 'committed');
  assert.deepEqual((await executorsFile(repo)).class_overrides, {});
  const removed = await removeExec(repo, 'flash');
  assert.equal(removed.outcome, 'committed');
  assert.deepEqual((await executorsFile(repo)).executors.map(({ id }) => id), ['lead']);
  const missing = await removeExec(repo, 'ghost');
  assert.deepEqual(reasons(missing.packet), ['executor_missing']);
  assertFindingsMatchCatalog(missing.packet);
});

test('replacing an executor by id keeps one entry; dry run and a retried request write nothing more', async (t) => {
  const repo = await createRepo(t);
  const dry = await setExec(repo, flash, { dryRun: true });
  assert.equal(dry.outcome, 'dry_run');
  assert.deepEqual(dry.packet.data.would_change, ['executors.json']);
  const first = await setExec(repo, flash, { requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
  const after = await everything(repo);
  const retry = await setExec(repo, flash, { requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
  assert.equal(first.outcome, 'committed');
  assert.equal(retry.packet.status, 'noop');
  assert.deepEqual(await everything(repo), after);
  await setExec(repo, { ...flash, class: 'medium', user_answer: 'medium now' });
  const file = await executorsFile(repo);
  assert.equal(file.executors.length, 1);
  assert.equal(file.executors[0].class, 'medium');
});

test('unclassified: no executor file, or no Leader/Worker classification, is flagged; the finding is in the catalog', async (t) => {
  const repo = await createRepo(t);
  const none = await readExecutors(repo.options);
  assert.equal(none.exists, false);
  assert.equal(none.unclassified, true);
  assert.equal(none.leader_class, null);
  const finding = unclassifiedFinding();
  assert.equal(finding.code, EXECUTOR_FINDING_CODES.unclassified);
  assertFindingsMatchCatalog({ findings: [finding] });
  await setExec(repo, flash);
  assert.equal((await readExecutors(repo.options)).unclassified, true, 'no Leader yet');
  await setExec(repo, lead);
  const both = await readExecutors(repo.options);
  assert.equal(both.unclassified, false);
  assert.equal(both.leader_class, 'frontier');
});

test('class_overrides are part of the road-fit snapshot projection: changing them stales the packet', async (t) => {
  const repo = await createRepo(t);
  await seedPlan(repo, 'P6');
  await seedRoad(repo, { id: 'R-P6-1', plan: 'P6' }, { folder: 'roads/P6' });
  const snap = async () => (await commandSnapshot('road-fit', { ...repo.options, target: { road: 'R-P6-1' } })).snapshot;
  const before = await snap();
  await setExec(repo, flash);
  const withExecutor = await snap();
  assert.notEqual(withExecutor, before);
  await setExec(repo, null, { setOverrides: [{ class: 'weak', knob: 'max_writes', value: 2 }] });
  assert.notEqual(await snap(), withExecutor);
});
