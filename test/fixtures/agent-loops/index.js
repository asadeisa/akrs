// P2-W12 golden: the Worker loop (work, a repeated work, a contested lease, a refused done, a finished done, yield), the Leader boot and the
// guard decisions of fixed worlds, as JSON, prompt and human views, byte-compared to committed JSON. Machine-dependent values (the root) are
// placeholders. Regenerate with AKRS_REGENERATE_AGENT_LOOPS=1 only after reviewing why the contract changed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { commandManifest } from '../../../lib/commands/manifest.js';
import { renderHuman } from '../../../lib/renderers/human.js';
import { renderPrompt } from '../../../lib/renderers/prompt.js';
import { FAILING, ROAD, edit, runCommand, workWorld } from '../../intents/support.js';

const GOLDEN = new URL('./expected.json', import.meta.url);
const ROOT = /(?:[A-Za-z]:)?[\\/][^"\s]*akrs-road-[A-Za-z0-9_-]+/g;
const normalize = (_key, value) => (typeof value === 'string' ? value.replace(ROOT, '<root>') : value);

// One run, then the prompt and the human views rendered from the very packet the JSON run returned (a rendering is a pure projection, and a
// claim run twice would no longer say "claimed").
const KNOWN = commandManifest.commands.map(({ id }) => id);
const TOKENS = new Map(commandManifest.commands.map(({ id, tokens }) => [id, tokens]));

async function capture(repo, argv) {
  const result = await runCommand(repo, [...argv, '--json'], { providers: repo.providers });
  const packet = JSON.parse(result.stdout);
  const context = { knownCommands: KNOWN, commandTokens: TOKENS };
  return JSON.parse(JSON.stringify({ json: { exit_code: result.exitCode, packet }, prompt: renderPrompt(packet, context), human: renderHuman(packet, context) }, normalize));
}

const WORK = ['work', '--executor', 'flash'];
const DONE = ['done', ROAD, '--executor', 'flash', '--result', 'the admin page is ready', '--reach', 'open /admin', '--expect', 'a table of users'];

async function produce(t) {
  const cases = {};
  const loop = await workWorld(t);
  cases.boot_before = await capture(loop.repo, ['boot']);
  cases.work_claimed = await capture(loop.repo, WORK);
  cases.work_unchanged = await capture(loop.repo, WORK);
  cases.work_lease_held = await capture(loop.repo, ['work', ROAD, '--executor', 'flash2']);
  cases.work_no_ready_road = await capture(loop.repo, ['work', '--executor', 'flash2']);
  cases.guard_allow = await capture(loop.repo, ['guard', 'src/admin.js', '--executor', 'flash']);
  cases.guard_outside_writes = await capture(loop.repo, ['guard', 'src/other.js', '--executor', 'flash']);
  cases.guard_cli_owned = await capture(loop.repo, ['guard', 'akrs/roads/P6/R-P6-1.json']);

  const failing = await workWorld(t, { checks: [FAILING] });
  await runCommand(failing.repo, [...WORK, '--json'], { providers: failing.repo.providers });
  await edit(failing.repo);
  cases.done_refused_first = await capture(failing.repo, DONE);

  const finished = await workWorld(t);
  await runCommand(finished.repo, [...WORK, '--json'], { providers: finished.repo.providers });
  await edit(finished.repo);
  cases.done_finished = await capture(finished.repo, DONE);
  cases.boot_after = await capture(finished.repo, ['boot']);

  const yielded = await workWorld(t);
  await runCommand(yielded.repo, [...WORK, '--json'], { providers: yielded.repo.providers });
  cases.yield_done = await capture(yielded.repo, ['yield', ROAD, '--executor', 'flash', '--reason', 'it needs the payment module as well']);
  cases.boot_yielded = await capture(yielded.repo, ['boot']);
  return cases;
}

test('the committed agent-loops golden equals what the CLI returns for the fixed worlds', async (t) => {
  const actual = await produce(t);
  if (process.env.AKRS_REGENERATE_AGENT_LOOPS === '1') await writeFile(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(actual, JSON.parse(await readFile(GOLDEN, 'utf8')));
});

test('the golden loop is shaped as the contract says: ok claims, named refusals, no bookkeeping anywhere an agent would type it', async () => {
  const golden = JSON.parse(await readFile(GOLDEN, 'utf8'));
  assert.deepEqual(Object.entries(golden).map(([name, entry]) => [name, entry.json.exit_code, entry.json.packet.status]), [
    ['boot_before', 0, 'ok'], ['work_claimed', 0, 'ok'], ['work_unchanged', 0, 'noop'], ['work_lease_held', 1, 'blocked'], ['work_no_ready_road', 1, 'blocked'],
    ['guard_allow', 0, 'ok'], ['guard_outside_writes', 1, 'blocked'], ['guard_cli_owned', 1, 'blocked'], ['done_refused_first', 1, 'blocked'],
    ['done_finished', 0, 'ok'], ['boot_after', 0, 'ok'], ['yield_done', 0, 'ok'], ['boot_yielded', 0, 'ok'],
  ]);
  // what the Worker is told to run never carries a snapshot flag, a hash or a request ID
  for (const [name, entry] of Object.entries(golden)) {
    if (!name.startsWith('work') && !name.startsWith('done') && !name.startsWith('yield')) continue;
    for (const { args } of entry.json.packet.next_commands) {
      assert.ok(!args.includes('--if-snapshot') && !args.includes('--request-id') && !args.some((argument) => argument.startsWith('sha256:')), name);
    }
  }
  assert.match(golden.work_claimed.prompt, /akrs done R-P6-1 --result/);
  assert.match(golden.done_refused_first.prompt, /Fix the failing check/);
  assert.equal(golden.boot_yielded.json.packet.data.questions_for_user[0].kind, 'yielded_road');
});
