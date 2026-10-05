// P2-W12 `boot`: the Leader's one-call start. A query: the Kernel files, the workflow in counts, questions for the user (an unclassified
// executor, a class without a Worker, a yielded Road), class-fit blockers, Roads that need a split, pending scope requests and the legal next
// commands. It writes nothing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateBoot } from '../../lib/schemas/intents.js';
import { commandManifest } from '../../lib/commands/manifest.js';
import { assertFindingsMatchCatalog } from '../road/support.js';
import { createRepo, packetWorld } from '../road-details/support.js';
import { fileWrite, request } from '../change/support.js';
import { fakeProviders } from '../idempotency/support.js';
import { FAILING, ROAD, addRoad, everything, intent, strict, work, workWorld, yieldRoad } from './support.js';

const boot = (repo, args = []) => intent(repo, ['boot', ...args]);
const questionKinds = (packet) => packet.data.questions_for_user.map(({ kind, subject }) => `${kind}:${subject}`);

test('boot is a Leader query: it writes nothing and its packet validates', async (t) => {
  const { repo } = await workWorld(t);
  const before = await strict(repo);
  const result = await boot(repo);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  assert.equal(result.packet.status, 'ok');
  assert.equal(validateBoot(result.packet.data).ok, true, JSON.stringify(validateBoot(result.packet.data).issues));
  assert.equal(await strict(repo), before, 'not even a cache was written');
  assert.equal(commandManifest.commands.find(({ id }) => id === 'boot').required_role, 'leader');
  assert.equal(commandManifest.commands.find(({ id }) => id === 'boot').mutability, 'query');
  assertFindingsMatchCatalog(result.packet);
});

test('boot counts the workflow, lists executors with their classes and shows leases', async (t) => {
  const { repo } = await workWorld(t);
  assert.equal((await work(repo)).packet.status, 'ok');
  const { data } = (await boot(repo)).packet;
  assert.deepEqual(data.workflow.roads, { total: 2, by_status: { ACTIVE: 1, DONE: 1, QUEUED: 0 }, unverified: 0 });
  assert.deepEqual(data.workflow.plans, { total: 1, closed: 0 });
  assert.deepEqual(data.workflow.executors.map(({ id, role, class: cls }) => `${id}:${role}:${cls}`), ['flash:worker:weak', 'flash2:worker:weak', 'lead:leader:frontier', 'mid:worker:medium', 'top:worker:frontier']);
  assert.deepEqual(data.workflow.leases, [{ kind: 'road', target: ROAD, holder: 'flash', state: 'fresh' }]);
  assert.deepEqual(data.questions_for_user, []);
  assert.deepEqual(data.needs_split, []);
});

test('the Kernel files are returned when the workflow has them and named as not generated when it has not', async (t) => {
  const { repo } = await workWorld(t);
  const bare = (await boot(repo)).packet.data.kernel;
  assert.deepEqual(bare, { core: null, leader: null });
  await repo.write('akrs/kernel/CORE.md', '# CORE\nOne route.\n');
  await repo.write('akrs/kernel/leader.md', '# Leader\nDecompose, then dispatch.\n');
  const packet = (await boot(repo)).packet;
  assert.deepEqual(packet.data.kernel.core, { path: 'akrs/kernel/CORE.md', bytes: 18, text: '# CORE\nOne route.\n' });
  assert.equal(packet.data.kernel.leader.text, '# Leader\nDecompose, then dispatch.\n');
  await repo.write('akrs/kernel/leader.md', 'x'.repeat(20_000));
  const big = (await boot(repo)).packet.data.kernel.leader;
  assert.deepEqual([big.bytes, big.text], [20_000, null], 'a file over the cap is named, not inlined');
});

test('unclassified executors become questions for the user, one per missing role', async (t) => {
  const none = await createRepo(t, { executors: [] });
  none.providers = fakeProviders({ firstId: 7000 });
  assert.deepEqual(questionKinds((await boot(none)).packet), ['classify_executors:leader', 'classify_executors:worker']);
  assert.match((await boot(none)).packet.data.questions_for_user[0].text, /weak, medium or frontier/);
  const leaderOnly = await createRepo(t, { executors: [{ id: 'lead', role: 'leader', class: 'frontier', label: 'Lead', user_answer: 'frontier' }] });
  leaderOnly.providers = fakeProviders({ firstId: 7000 });
  assert.deepEqual(questionKinds((await boot(leaderOnly)).packet), ['classify_executors:worker']);
});

test('a Road class with no Worker is a question and a class-fit blocker', async (t) => {
  const { repo } = await packetWorld(t, {}, { road: { status: 'QUEUED' }, executors: [
    { id: 'lead', role: 'leader', class: 'frontier', label: 'Lead', user_answer: 'frontier' },
    { id: 'mid', role: 'worker', class: 'medium', label: 'Mid', user_answer: 'medium' },
  ] });
  repo.providers = fakeProviders({ firstId: 7000 });
  const { data } = (await boot(repo)).packet;
  assert.deepEqual(questionKinds({ data }), ['no_worker_for_class:weak']);
  assert.deepEqual(data.class_fit_blockers.map(({ road, reasons }) => [road, reasons.map(({ reason }) => reason)]), [[ROAD, ['no_executor_for_class']]]);
});

test('pending scope requests are listed and `next` names the decision', async (t) => {
  const { repo } = await workWorld(t);
  const requested = await request(repo, { road: ROAD, add_writes: [fileWrite('src/new.js')], reason: 'need one more file' });
  assert.equal(requested.outcome, 'committed');
  const { data, next_commands: next } = (await boot(repo)).packet;
  assert.deepEqual(data.pending_scope_requests.map(({ road, blocking }) => [road, blocking]), [[ROAD, true]]);
  assert.equal(data.next.actions[0].kind, 'decide_scope');
  assert.ok(next.some(({ command }) => command === 'scope-list'));
});

test('a yielded Road is a needs-split entry and a question for the Leader, with the Worker\'s words', async (t) => {
  const { repo } = await workWorld(t);
  assert.equal((await work(repo)).packet.status, 'ok');
  assert.equal((await yieldRoad(repo)).packet.status, 'ok');
  const { data } = (await boot(repo)).packet;
  assert.deepEqual(data.needs_split, [{ road: ROAD, holder: 'flash', reason: 'it needs the payment module as well' }]);
  assert.deepEqual(questionKinds({ data }), [`yielded_road:${ROAD}`]);
  assert.match(data.questions_for_user[0].text, /it needs the payment module as well/);
});

test('every next command runs as it is: a manifest command with real arguments', async (t) => {
  const { repo } = await workWorld(t);
  await addRoad(repo, 'R-P6-2');
  const { next_commands: next } = (await boot(repo)).packet;
  assert.ok(next.length > 0);
  const known = new Set(commandManifest.commands.map(({ id }) => id));
  for (const { command, args } of next) {
    assert.ok(known.has(command), command);
    assert.ok(args.every((argument) => typeof argument === 'string' && argument !== ''));
  }
  const worked = next.find(({ command }) => command === 'work');
  assert.ok(worked, 'an ACTIVE Road nobody holds is offered as work');
  assert.equal((await intent(repo, ['work', ...worked.args.filter((argument) => argument !== repo.root && argument !== '--root'), '--executor', 'flash'])).packet.status, 'ok');
});

test('boot reads the workflow whatever is wrong with it: an unverified Road is counted, the packet still returns', async (t) => {
  const { repo } = await workWorld(t, { checks: [FAILING] });
  const text = await repo.read('akrs/roads/P6/R-P6-1.json');
  await repo.write('akrs/roads/P6/R-P6-1.json', text.replace('"complexity": 3', '"complexity": 4'));
  const result = await boot(repo);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.equal(result.packet.data.workflow.roads.unverified, 1);
  assert.ok(await everything(repo));
});
