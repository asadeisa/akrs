import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { buildScaffold } from '../../lib/store/scaffold/index.js';
import { setExecutor } from '../../lib/store/executors/index.js';
import { assertFindingsMatchCatalog, authoringOptions } from '../road/support.js';
import { emptyRepo, scaffold, treeOf, validate } from './support.js';

const exists = (path) => stat(path).then(() => true, () => false);
const FILES = ['STATE.md', 'roads/R1.json', 'state.json', 'tasks/T1.md', 'verifications/R1/contract.json'];

test('the builder is pure and deterministic; ids and tiers follow the flags', () => {
  const one = buildScaffold({ workflowRelative: 'akrs', now: '2026-10-03T10:00:00.000Z' });
  const two = buildScaffold({ workflowRelative: 'akrs', now: '2026-10-03T10:00:00.000Z' });
  assert.deepEqual(one, two);
  assert.deepEqual({ tier: one.tier, plan_id: one.plan_id, road_id: one.road_id, task_id: one.task_id, key: one.key }, { tier: 'no_plan', plan_id: null, road_id: 'R1', task_id: 'T1', key: 'R1' });
  assert.deepEqual(one.files.map(({ path }) => path), FILES);
  const planned = buildScaffold({ workflowRelative: 'akrs', plan: 'P1', now: '2026-10-03T10:00:00.000Z' });
  assert.deepEqual({ tier: planned.tier, plan_id: planned.plan_id, road_id: planned.road_id, task_id: planned.task_id, key: planned.key }, { tier: 'plan', plan_id: 'P1', road_id: 'R-P1-1', task_id: 'T-P1-1', key: 'P1' });
  assert.deepEqual(planned.files.map(({ path }) => path), ['STATE.md', 'plans/P1.json', 'roads/P1/R-P1-1.json', 'state.json', 'tasks/T-P1-1.md', 'verifications/P1/contract.json']);
  assert.equal(buildScaffold({ workflowRelative: 'akrs', road: 'R-ONE', now: '2026-10-03T10:00:00.000Z' }).task_id, 'T-ONE');
});

test('init --scaffold writes the minimal workflow through one transaction and names tier, Road and Plan', async (t) => {
  const repo = await emptyRepo(t);
  assert.equal(await exists(repo.path('akrs')), false);
  const { exitCode, packet } = await scaffold(repo);
  assert.equal(exitCode, 0);
  assert.equal(packet.status, 'ok');
  assert.equal(packet.command, 'init-scaffold');
  assert.deepEqual(packet.data.scaffold, { tier: 'no_plan', plan_id: null, road_id: 'R1', task_id: 'T1', key: 'R1', files: FILES });
  assert.deepEqual(packet.changed, FILES);
  const tree = await treeOf(repo.path('akrs'));
  for (const file of FILES) assert.ok(tree[file] !== undefined, file);
  assert.equal(tree['executors.json'], undefined, 'executors come only from explicit input');
  assert.equal(packet.data.questions_for_user[0].id, 'classify_executors');
  assert.deepEqual(packet.data.gitignore, { path: '.gitignore', outcome: 'created' });
  const ignore = await repo.read('.gitignore');
  for (const line of ['akrs/drafts/', 'akrs/.ops/', 'akrs/.cache/']) assert.ok(ignore.includes(line), line);
});

test('the scaffold validates honestly: not_applicable where nothing applies, no skipped, only the open executor question', async (t) => {
  const repo = await emptyRepo(t);
  await scaffold(repo);
  const packet = await validate(repo);
  assert.equal(packet.data.coverage.skipped, 0);
  assert.equal(packet.data.coverage.failed, 1);
  assert.deepEqual(packet.findings.map(({ code }) => code), ['AKRS-S006']);
  assert.equal(packet.status, 'warning');
  assertFindingsMatchCatalog(packet);
  const status = (id) => packet.data.checks.find(({ check }) => check === id).status;
  for (const id of ['road-integrity', 'road-identities', 'road-paths', 'state', 'state-render', 'verification']) assert.equal(status(id), 'passed', id);
  for (const id of ['done-writes-exist', 'log', 'memory', 'scope-requests', 'drafts', 'legacy-forms', 'dependency-readiness', 'git-posture']) assert.equal(status(id), 'not_applicable', id);
});

test('the Plan tier writes the Plan file and keys the verification contract by the Plan', async (t) => {
  const repo = await emptyRepo(t);
  const { packet } = await scaffold(repo, ['--plan', 'P1']);
  assert.deepEqual(packet.data.scaffold, {
    tier: 'plan', plan_id: 'P1', road_id: 'R-P1-1', task_id: 'T-P1-1', key: 'P1',
    files: ['STATE.md', 'plans/P1.json', 'roads/P1/R-P1-1.json', 'state.json', 'tasks/T-P1-1.md', 'verifications/P1/contract.json'],
  });
  const validated = await validate(repo);
  assert.equal(validated.data.coverage.skipped, 0);
  assert.deepEqual(validated.findings.map(({ code }) => code), ['AKRS-S006']);
});

test('same inputs, same bytes: two scaffolds are identical', async (t) => {
  const left = await emptyRepo(t);
  const right = await emptyRepo(t);
  await scaffold(left);
  await scaffold(right);
  assert.deepEqual(await treeOf(left.path('akrs')), await treeOf(right.path('akrs')));
});

test('an existing target is refused without --force; --force replaces exactly the scaffold files and nothing else', async (t) => {
  const repo = await emptyRepo(t);
  await scaffold(repo);
  const original = await treeOf(repo.path('akrs'));
  await mkdir(dirname(repo.path('akrs/memory/keep.md')), { recursive: true });
  await writeFile(repo.path('akrs/memory/keep.md'), 'mine\n');
  await writeFile(repo.path('akrs/roads/R9.json'), '{"mine":true}\n');
  await writeFile(repo.path('akrs/roads/R1.json'), '{"edited":true}\n');
  const refused = await scaffold(repo);
  assert.equal(refused.exitCode, 1);
  assert.equal(refused.packet.status, 'error');
  assert.equal(refused.packet.findings[0].code, 'AKRS-S010');
  assert.equal(refused.packet.findings[0].detail.reason, 'target_exists');
  assert.equal(await repo.read('akrs/roads/R1.json'), '{"edited":true}\n', 'nothing was written');
  const forced = await scaffold(repo, ['--force']);
  assert.equal(forced.exitCode, 0, JSON.stringify(forced.packet.findings));
  const after = await treeOf(repo.path('akrs'));
  for (const file of FILES) assert.equal(after[file], original[file], file);
  assert.equal(after['memory/keep.md'], 'mine\n');
  assert.equal(after['roads/R9.json'], '{"mine":true}\n');
});

test('dry run writes nothing, not even the workflow folder or .gitignore', async (t) => {
  const repo = await emptyRepo(t);
  const { packet } = await scaffold(repo, ['--dry-run']);
  assert.equal(packet.status, 'ok');
  assert.equal(packet.data.dry_run, true);
  assert.deepEqual(packet.data.would_change, FILES);
  assert.equal(await exists(repo.path('akrs')), false);
  assert.equal(await exists(repo.path('.gitignore')), false);
});

test('.gitignore: a managed block is added next to the user lines, kept idempotent and never overwrites an edited block', async (t) => {
  const repo = await emptyRepo(t);
  await writeFile(repo.path('.gitignore'), 'node_modules/\n');
  await scaffold(repo);
  const first = await repo.read('.gitignore');
  assert.ok(first.startsWith('node_modules/\n'));
  const again = await scaffold(repo, ['--force']);
  assert.equal(again.packet.data.gitignore.outcome, 'unchanged');
  assert.equal(await repo.read('.gitignore'), first);
  await writeFile(repo.path('.gitignore'), first.replace('akrs/.cache/', 'akrs/.cache/\n# my edit'));
  const edited = await scaffold(repo, ['--force', '--road', 'R1']);
  assert.equal(edited.packet.data.gitignore.outcome, 'conflict');
  assert.match(await repo.read('.gitignore'), /# my edit/);
});

test('init --scaffold is a manifest command beside init, selected by its --scaffold token', () => {
  const entry = commandManifest.commands.find(({ id }) => id === 'init-scaffold');
  assert.deepEqual(entry.tokens, ['init', '--scaffold']);
  assert.equal(entry.required_role, 'leader');
  assert.equal(entry.mutability, 'mutation');
  assert.equal(entry.flags.some(({ name }) => name === '--force'), true);
  assert.equal(commandManifest.commands.find(({ id }) => id === 'init').tokens.length, 1);
});

test('the packaged examples/minimal is exactly the scaffold plus two explicit executors (AKRS_REGENERATE_EXAMPLE=1 rewrites it)', async (t) => {
  const repo = await emptyRepo(t);
  await scaffold(repo);
  const options = authoringOptions({ ...repo, options: { repositoryRoot: repo.root, workflowRoot: repo.path('akrs') } }, { providers: repo.providers });
  for (const executor of [
    { id: 'leader', role: 'leader', class: 'frontier', label: 'Example leader model', user_answer: 'frontier' },
    { id: 'worker', role: 'worker', class: 'weak', label: 'Example worker model', user_answer: 'weak: needs small steps' },
  ]) assert.equal((await setExecutor({ ...options, executor, setOverrides: [], clearOverrides: [] })).outcome, 'committed');
  const generated = await treeOf(repo.path('akrs'));
  const example = new URL('../../examples/minimal/akrs/', import.meta.url);
  if (process.env.AKRS_REGENERATE_EXAMPLE === '1') {
    await rm(example, { recursive: true, force: true });
    for (const [path, content] of Object.entries(generated)) {
      await mkdir(dirname(new URL(path, example).pathname), { recursive: true });
      await writeFile(new URL(path, example), content);
    }
  }
  assert.deepEqual(await treeOf(example.pathname), generated, 'examples/minimal/akrs drifted from the scaffold; run with AKRS_REGENERATE_EXAMPLE=1');
  const readme = await readFile(new URL('../../examples/minimal/README.md', import.meta.url), 'utf8');
  assert.match(readme, /init --scaffold/);
});
