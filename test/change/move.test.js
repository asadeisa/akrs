import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { test } from 'node:test';
import { parseTaskMarker } from '../../lib/store/roads/task.js';
import { validateMutationChanges } from '../../lib/schemas/packet.js';
import { createRepo, everything, move, readEntry, roadJson, seedRoad, seedRoadWithTask, strict, text } from './support.js';

const ID = 'R-P6-1';
const OLD = 'akrs/roads/P6/R-P6-1.json';
const reasons = (packet) => packet.findings.filter(({ code }) => code === 'AKRS-R014').map(({ detail }) => detail.reason);
const exists = (repo, path) => access(repo.path(path)).then(() => true, () => false);

async function world(t) {
  const repo = await createRepo(t);
  await seedRoadWithTask(repo);
  // a Road that declares the moved Road file in reads, one that only looks similar, and an unrelated one
  await seedRoad(repo, { id: 'R-REF', reads: [readEntry(OLD), readEntry(`${OLD}.bak`)], on_landing: OLD });
  await seedRoad(repo, { id: 'R-NEAR', reads: [readEntry('akrs/roads/P6/R-P6-1.jsonx')] });
  return repo;
}

test('report-only is the default: the plan is returned and no byte changes', async (t) => {
  const repo = await world(t);
  const before = await strict(repo);
  const result = await move(repo, ID, 'P7');
  assert.equal(result.outcome, 'dry_run');
  const { data } = result.packet;
  assert.equal(data.applied, false);
  assert.deepEqual(data.road, { id: ID, from: OLD, to: 'akrs/roads/P7/R-P6-1.json', plan_from: 'P6', plan_to: 'P7' });
  assert.deepEqual(data.references.map(({ file, kind }) => [file, kind]), [
    ['akrs/roads/P7/R-P6-1.json', 'road_plan'],
    ['akrs/roads/R-REF.json', 'road_reference'],
    ['akrs/roads/R-REF.json', 'road_reference'],
    ['akrs/tasks/T-P6-1.md', 'task_marker_and_pointer'],
  ]);
  assert.deepEqual(data.would_change, ['roads/P6/R-P6-1.json', 'roads/P7/R-P6-1.json', 'roads/R-REF.json', 'tasks/T-P6-1.md']);
  assert.deepEqual(result.packet.next_commands[0].args.slice(0, 4), [ID, '--plan', 'P7', '--apply']);
  assert.deepEqual(await strict(repo), before);
});

test('apply is explicit and transactional and updates only the declared references', async (t) => {
  const repo = await world(t);
  const task = await text(repo, 'akrs/tasks/T-P6-1.md');
  const result = await move(repo, ID, 'P7', { apply: true });
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(result.packet.changed, ['roads/P6/R-P6-1.json', 'roads/P7/R-P6-1.json', 'roads/R-REF.json', 'tasks/T-P6-1.md']);
  assert.equal(validateMutationChanges(result.packet, result.packet.changed).ok, true);
  assert.equal(await exists(repo, OLD), false);
  const moved = await roadJson(repo, ID, 'roads/P7');
  assert.equal(moved.plan, 'P7');
  assert.equal(moved.id, ID);
  const next = await text(repo, 'akrs/tasks/T-P6-1.md');
  assert.equal(parseTaskMarker(next).plan, 'P7');
  assert.equal(next, task.replace('"plan":"P6"', '"plan":"P7"').replaceAll(`\`${OLD}\``, '`akrs/roads/P7/R-P6-1.json`'));
  assert.equal(next.includes('Custom note.'), true, 'prose is untouched');
  const ref = await roadJson(repo, 'R-REF');
  assert.deepEqual(ref.reads.map(({ path }) => path), ['akrs/roads/P7/R-P6-1.json', `${OLD}.bak`]);
  assert.equal(ref.on_landing, 'akrs/roads/P7/R-P6-1.json');
  assert.equal((await roadJson(repo, 'R-NEAR')).reads[0].path, 'akrs/roads/P6/R-P6-1.jsonx', 'a similar path is not a reference');
  const again = await move(repo, ID, 'P7', { apply: true, requestId: result.packet.request_id });
  assert.equal(again.packet.status, 'noop');
});

test('moving to no Plan puts the Road in the top tier', async (t) => {
  const repo = await world(t);
  const result = await move(repo, ID, 'none', { apply: true });
  assert.equal(result.outcome, 'committed');
  assert.equal((await roadJson(repo, ID)).plan, null);
  assert.equal(await exists(repo, 'akrs/roads/R-P6-1.json'), true);
  assert.equal(parseTaskMarker(await text(repo, 'akrs/tasks/T-P6-1.md')).plan, null);
});

test('refusals write nothing: ACTIVE, a Plan that is a Road ID, no change, a duplicate target, missing and DONE Roads', async (t) => {
  const repo = await world(t);
  await seedRoad(repo, { id: 'R-BUSY', plan: 'P6' }, { folder: 'roads/P6', status: 'ACTIVE' });
  await seedRoad(repo, { id: 'R-FIN', plan: 'P6' }, { folder: 'roads/P6', status: 'DONE' });
  const cases = [
    [ID, 'R-REF', 'plan_names_a_road'],
    [ID, 'P6', 'no_change'],
    ['R-BUSY', 'P7', 'road_active'],
    ['R-FIN', 'P7', 'road_done'],
    ['R-NOPE', 'P7', 'road_missing'],
  ];
  for (const [id, plan, reason] of cases) {
    const before = await everything(repo);
    const result = await move(repo, id, plan, { apply: true });
    assert.equal(result.outcome, 'rejected', reason);
    assert.equal(reasons(result.packet).includes(reason), true, `${reason}: ${JSON.stringify(result.packet.findings.map(({ message }) => message))}`);
    assert.deepEqual(await everything(repo), before, reason);
  }
  // target_exists is a defence: any file named <id>.json under roads/ is already a duplicate identity, caught first
  await repo.write('akrs/roads/P7/R-P6-1.json', '{}');
  const taken = await move(repo, ID, 'P7', { apply: true });
  assert.equal(taken.outcome, 'rejected');
});
