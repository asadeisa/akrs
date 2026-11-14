// P2-W11 (owner decision 2026-11-14): the Plan record writers. `plan new`, `plan question add|resolve` and `plan seam add|remove` write
// only the Leader-owned parts of akrs/plans/<plan>.json, generate the next Q<n>/S<n> when no ID is given, refuse with AKRS-S011 and a
// named reason (writing nothing), never touch a closed or hand-edited Plan, and answer a retried request as a noop.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPlan } from '../../lib/store/plan-finish/repository.js';
import { buildStoredPlan } from '../../lib/store/plan-records/index.js';
import { assertFindingsMatchCatalog, createRepo, fakeProviders, runCommand, seedRoad, treeDigest } from '../road/support.js';

const plan = async (repo, argv, options = {}) => {
  const result = await runCommand(repo, [...argv, '--json'], { providers: repo.providers, ...options });
  return { exitCode: result.exitCode, packet: result.stdout === '' ? null : JSON.parse(result.stdout), stderr: result.stderr };
};
const reasonOf = ({ packet }) => packet.findings.find(({ code }) => code === 'AKRS-S011')?.detail.reason ?? null;
const stored = async (repo, key) => (await readPlan({ ...repo.options, key }));

async function world(t) {
  const repo = await createRepo(t);
  repo.providers = fakeProviders({ firstId: 7000 });
  await seedRoad(repo, { id: 'R-P6-1', plan: 'P6' }, { folder: 'roads/P6' });
  return repo;
}

test('plan new writes a canonical, verifying Plan record and refuses an existing Plan or a Road ID', async (t) => {
  const repo = await world(t);
  const created = await plan(repo, ['plan', 'new', 'P6', '--title', 'Admin area — لوحة الإدارة']);
  assert.equal(created.exitCode, 0, JSON.stringify(created.packet));
  assert.equal(created.packet.status, 'ok');
  assert.deepEqual(created.packet.changed, ['plans/P6.json']);
  assert.deepEqual(created.packet.data.item, { type: 'plan', id: 'P6' });
  assert.equal(created.packet.data.plan.created, true);
  const read = await stored(repo, 'P6');
  assert.equal(read.meta_state, 'declared');
  assert.deepEqual({ title: read.plan.title, questions: read.plan.questions, seams: read.plan.seams, findings: read.plan.findings, closure: read.plan.closure }, {
    title: 'Admin area — لوحة الإدارة', questions: [], seams: [], findings: [], closure: { status: 'open', at: null, operation: null },
  });
  assert.deepEqual(created.packet.next_commands.map(({ command }) => command), ['status', 'plan-finish']);

  for (const [argv, reason] of [[['plan', 'new', 'P6', '--title', 'again'], 'plan_exists'], [['plan', 'new', 'R-P6-1', '--title', 'clash'], 'id_taken']]) {
    const before = await treeDigest(repo);
    const refused = await plan(repo, argv);
    assert.equal(refused.exitCode, 1);
    assert.equal(reasonOf(refused), reason);
    assertFindingsMatchCatalog(refused.packet);
    assert.deepEqual(await treeDigest(repo), before, `${reason} writes nothing`);
  }
  const missingTitle = await plan(repo, ['plan', 'new', 'P7']);
  assert.equal(missingTitle.exitCode, 2, 'a missing --title is a usage error');
});

test('questions: the next Q<n> is generated, an explicit ID is kept, resolve records the answer, and every misuse is named', async (t) => {
  const repo = await world(t);
  assert.equal((await plan(repo, ['plan', 'new', 'P6', '--title', 'Admin'])).exitCode, 0);
  assert.deepEqual((await plan(repo, ['plan', 'question', 'add', 'P6', '--text', 'Which database?'])).packet.data.item, { type: 'question', id: 'Q1' });
  assert.deepEqual((await plan(repo, ['plan', 'question', 'add', 'P6', '--text', 'Who signs off?', '--question', 'Q7'])).packet.data.item, { type: 'question', id: 'Q7' });
  const third = await plan(repo, ['plan', 'question', 'add', 'P6', '--text', 'Which region?']);
  assert.deepEqual(third.packet.data.item, { type: 'question', id: 'Q8' }, 'one more than the highest number in use');
  assert.equal(third.packet.data.plan.open_questions, 3);
  assert.equal(reasonOf(await plan(repo, ['plan', 'question', 'add', 'P6', '--text', 'dup', '--question', 'q1'])), 'question_exists', 'IDs collide case-folded');

  const resolved = await plan(repo, ['plan', 'question', 'resolve', 'P6', 'Q1', '--resolution', 'Postgres 16']);
  assert.equal(resolved.packet.status, 'ok');
  assert.equal(resolved.packet.data.plan.open_questions, 2);
  const q1 = (await stored(repo, 'P6')).plan.questions.find(({ id }) => id === 'Q1');
  assert.deepEqual(q1, { id: 'Q1', text: 'Which database?', status: 'resolved', resolution: 'Postgres 16', decision: null });
  assert.equal(reasonOf(await plan(repo, ['plan', 'question', 'resolve', 'P6', 'Q1', '--resolution', 'again'])), 'question_resolved');
  assert.equal(reasonOf(await plan(repo, ['plan', 'question', 'resolve', 'P6', 'Q99', '--resolution', 'x'])), 'question_missing');
  assert.equal(reasonOf(await plan(repo, ['plan', 'question', 'add', 'P9', '--text', 'no plan'])), 'plan_missing');
  assert.equal((await plan(repo, ['plan', 'question', 'resolve', 'P6', 'Q7'])).exitCode, 2, 'a missing --resolution is a usage error');
});

test('seams: owned by an existing Road, by an intent, or unowned; a missing Road, two owners and an unknown seam are refused', async (t) => {
  const repo = await world(t);
  assert.equal((await plan(repo, ['plan', 'new', 'P6', '--title', 'Admin'])).exitCode, 0);
  assert.deepEqual((await plan(repo, ['plan', 'seam', 'add', 'P6', '--text', 'API wiring', '--road', 'R-P6-1'])).packet.data.item, { type: 'seam', id: 'S1' });
  assert.deepEqual((await plan(repo, ['plan', 'seam', 'add', 'P6', '--text', 'Event bus', '--intent', 'subscribe in the shell'])).packet.data.item, { type: 'seam', id: 'S2' });
  const unowned = await plan(repo, ['plan', 'seam', 'add', 'P6', '--text', 'Nobody owns this yet']);
  assert.equal(unowned.packet.data.plan.unowned_seams, 1);
  assert.deepEqual((await stored(repo, 'P6')).plan.seams, [
    { id: 'S1', text: 'API wiring', owner: { road: 'R-P6-1', intent: null } },
    { id: 'S2', text: 'Event bus', owner: { road: null, intent: 'subscribe in the shell' } },
    { id: 'S3', text: 'Nobody owns this yet', owner: null },
  ]);
  assert.equal(reasonOf(await plan(repo, ['plan', 'seam', 'add', 'P6', '--text', 'x', '--road', 'R-NOPE'])), 'road_missing');
  assert.equal((await plan(repo, ['plan', 'seam', 'add', 'P6', '--text', 'x', '--road', 'R-P6-1', '--intent', 'y'])).exitCode, 2, 'two owners is a usage error');

  const removed = await plan(repo, ['plan', 'seam', 'remove', 'P6', 'S3']);
  assert.equal(removed.packet.status, 'ok');
  assert.equal(removed.packet.data.plan.unowned_seams, 0);
  assert.equal((await plan(repo, ['plan', 'seam', 'remove', 'P6', 'S3'])).packet.status, 'noop', 'the same request again is answered from the journal');
  assert.equal(reasonOf(await plan(repo, ['plan', 'seam', 'remove', 'P6', 'S9'])), 'seam_missing');
});

test('a closed or hand-edited Plan is never rewritten; --dry-run writes nothing; a retried request is a noop', async (t) => {
  const repo = await world(t);
  assert.equal((await plan(repo, ['plan', 'new', 'P6', '--title', 'Admin'])).exitCode, 0);

  const before = await treeDigest(repo);
  const dry = await plan(repo, ['plan', 'question', 'add', 'P6', '--text', 'Dry?', '--dry-run']);
  assert.equal(dry.packet.status, 'ok');
  assert.deepEqual(dry.packet.data.item, { type: 'question', id: 'Q1' });
  assert.deepEqual(await treeDigest(repo), before, 'a dry run writes nothing');

  const requestId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const first = await plan(repo, ['plan', 'question', 'add', 'P6', '--text', 'Once', '--request-id', requestId]);
  assert.equal(first.packet.status, 'ok');
  const again = await plan(repo, ['plan', 'question', 'add', 'P6', '--text', 'Once', '--request-id', requestId]);
  assert.equal(again.packet.status, 'noop');
  assert.equal((await stored(repo, 'P6')).plan.questions.length, 1, 'the retry added nothing');

  const text = await repo.read('akrs/plans/P6.json');
  await repo.write('akrs/plans/P6.json', text.replace('"Admin"', '"Edited by hand"'));
  const edited = await treeDigest(repo);
  const unusable = await plan(repo, ['plan', 'seam', 'add', 'P6', '--text', 'x']);
  assert.equal(reasonOf(unusable), 'plan_unusable');
  assert.deepEqual(await treeDigest(repo), edited, 'a hand-edited Plan is left as it is');

  const { plan: current } = await stored(repo, 'P6');
  const closed = buildStoredPlan({ ...current, title: 'Admin', closure: {
    status: 'closed', at: '2026-10-03T12:00:00.000Z', operation: { request: '01BX5ZZKBKACTAV9WEVGEMMVRY', run: '01HZX9Q7M3T5V8W2K4N6P0R1S2' },
  } });
  await repo.write('akrs/plans/P6.json', closed.text);
  assert.equal(reasonOf(await plan(repo, ['plan', 'question', 'add', 'P6', '--text', 'late'])), 'plan_closed');
});
