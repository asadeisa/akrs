// P2-W17: `projects add|list|remove` and the registry beneath them. Every test uses a temporary user-config root (AKRS_CONFIG_HOME), never
// the real profile, and checks that removing or listing never touches a registered project.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireRepositoryLock } from '../../lib/store/lock/index.js';
import { validateProjectsAdd, validateProjectsList, validateProjectsRemove } from '../../lib/schemas/desktop.js';
import { validateRegistry } from '../../lib/userconfig/registry.js';
import { runCli } from '../helpers/process.js';
import { codesOf, desktopWorld, plainDirectory, treeDigest } from './support.js';

const normalized = (path) => path.replaceAll('\\', '/');
const registryFile = (world) => join(world.config, 'projects.json');
const registryText = (world) => readFile(registryFile(world), 'utf8');
const exists = (path) => readdir(path).then(() => true, () => false);

async function add(world, ...args) {
  const out = await world.json(['projects', 'add', ...args]);
  assert.ok(out.packet !== null, out.text);
  return out;
}

test('projects add stores the normalized absolute root, the workflow, a name and the add time; nothing else changes', async (t) => {
  const world = await desktopWorld(t);
  const repo = await world.project();
  const before = await treeDigest(repo);
  const out = await add(world, repo.root);
  assert.equal(out.exitCode, 0, out.text);
  const { packet } = out;
  assert.deepEqual([packet.command, packet.status, packet.data.kind, packet.data.outcome], ['projects-add', 'ok', 'projects_add', 'added']);
  assert.equal(validateProjectsAdd(packet.data).ok, true, JSON.stringify(validateProjectsAdd(packet.data).issues));
  assert.match(packet.request_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.deepEqual(packet.changed, []);
  const entry = packet.data.project;
  assert.equal(entry.root.includes('\\'), false);
  assert.equal(entry.root.endsWith('/'), false);
  assert.equal(entry.workflow, 'akrs');
  assert.equal(entry.name, normalized(repo.root).split('/').at(-1));
  assert.match(entry.added_at, /^2026-10-03T10:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(packet.data.count, 1);
  assert.deepEqual(await treeDigest(repo), before, 'registering reads the project and writes nothing in it');
  const stored = JSON.parse(await registryText(world));
  assert.equal(validateRegistry(stored).ok, true);
  assert.deepEqual(stored.projects, [entry]);
  assert.equal(await exists(join(repo.root, 'akrs', '.ops', 'lock')), false, 'the project lock is never taken');
});

test('the registry lives only in the injected config root, with its own lock folder, and leaves no temporary file', async (t) => {
  const world = await desktopWorld(t);
  const repo = await world.project();
  await add(world, repo.root);
  assert.deepEqual((await readdir(world.config)).sort(), ['.ops', 'projects.json']);
  assert.deepEqual(await readdir(join(world.config, '.ops')), [], 'the lock is released');
});

test('the same project through different spellings is listed once, as a noop', async (t) => {
  const world = await desktopWorld(t);
  const repo = await world.project();
  await add(world, repo.root);
  const first = await registryText(world);
  for (const spelling of [`${repo.root}/`, `${repo.root}/akrs/..`, repo.root.replaceAll('/', '\\')]) {
    const again = await add(world, spelling);
    assert.deepEqual([again.packet.status, again.packet.data.outcome], ['noop', 'noop'], spelling);
  }
  assert.equal(await registryText(world), first, 'a noop rewrites nothing');
});

test('the project is found from the working directory or --root when no path is given', async (t) => {
  const world = await desktopWorld(t);
  const repo = await world.project();
  const viaCwd = await world.json(['projects', 'add'], { cwd: repo.root });
  assert.equal(viaCwd.packet.data.outcome, 'added', viaCwd.text);
  const viaRoot = await world.json(['projects', 'add', '--root', repo.root]);
  assert.equal(viaRoot.packet.data.outcome, 'noop');
  const both = await world.json(['projects', 'add', repo.root, '--root', repo.root]);
  assert.equal(both.exitCode, 2, both.text);
});

test('--name sets the label and a changed label updates the entry in place', async (t) => {
  const world = await desktopWorld(t);
  const repo = await world.project();
  const first = await add(world, repo.root, '--name', 'Booking site');
  assert.equal(first.packet.data.project.name, 'Booking site');
  const second = await add(world, repo.root, '--name', 'Reservations');
  assert.deepEqual([second.packet.status, second.packet.data.outcome, second.packet.data.project.name], ['ok', 'updated', 'Reservations']);
  assert.equal(second.packet.data.project.added_at, first.packet.data.project.added_at, 'the add time is kept');
  assert.equal(JSON.parse(await registryText(world)).projects.length, 1);
  const bad = await world.json(['projects', 'add', repo.root, '--name', 'x'.repeat(81)]);
  assert.equal(bad.exitCode, 2);
});

test('a missing root is a finding AKRS-C022 and nothing is written, not even the config folder', async (t) => {
  const world = await desktopWorld(t);
  const gone = join((await plainDirectory(t)).root, 'no-such-project');
  const out = await add(world, gone);
  assert.deepEqual([out.exitCode, out.packet.status, out.packet.data.outcome, out.packet.data.reason, out.packet.data.project], [1, 'error', 'rejected', 'missing', null]);
  assert.deepEqual(codesOf(out.packet), ['AKRS-C022']);
  assert.equal(out.packet.findings[0].detail.reason, 'missing');
  assert.equal(await exists(world.config), false, 'the config folder was not created');
});

test('a directory that is not an AKRS project, a plain file and an empty workflow folder are findings', async (t) => {
  const world = await desktopWorld(t);
  const plain = await plainDirectory(t);
  const nothing = await add(world, plain.root);
  assert.deepEqual([nothing.packet.data.reason, nothing.packet.findings[0].detail.reason], ['not_akrs', 'not_akrs']);
  assert.deepEqual(nothing.packet.next_commands, [{ command: 'init-scaffold', args: ['--root', normalized(plain.root)] }], 'the next command creates the workflow');
  await mkdir(join(plain.root, 'akrs'));
  const empty = await add(world, plain.root);
  assert.equal(empty.packet.data.reason, 'not_akrs', 'an empty workflow folder has no AKRS marker');
  const file = await plain.write('a-file.txt', 'x');
  const notDirectory = await add(world, file);
  assert.equal(notDirectory.packet.data.reason, 'not_a_directory');
  assert.equal(await exists(world.config), false);
});

test('a workflow folder under another name is registered with --workflow-root', async (t) => {
  const world = await desktopWorld(t);
  const repo = await world.project();
  await rm(join(repo.root, 'other-flow'), { recursive: true, force: true });
  await mkdir(join(repo.root, 'other-flow', 'roads'), { recursive: true });
  const out = await add(world, repo.root, '--workflow-root', join(repo.root, 'other-flow'));
  assert.deepEqual([out.packet.data.outcome, out.packet.data.project.workflow], ['added', 'other-flow']);
  const outside = (await plainDirectory(t)).root;
  await mkdir(join(outside, 'roads'));
  const escaped = await add(world, repo.root, '--workflow-root', outside);
  assert.equal(escaped.packet.data.reason, 'unsafe');
});

test('list returns the registry in code point order of root, without opening any project', async (t) => {
  const world = await desktopWorld(t);
  const first = await world.project();
  const second = await world.project();
  await add(world, second.root);
  await add(world, first.root);
  const out = await world.json(['projects', 'list']);
  assert.equal(out.exitCode, 0, out.text);
  assert.equal(validateProjectsList(out.packet.data).ok, true, JSON.stringify(validateProjectsList(out.packet.data).issues));
  const roots = out.packet.data.projects.map(({ root }) => root);
  assert.deepEqual(roots, [...roots].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  assert.equal(roots.length, 2);
  assert.equal(out.packet.data.registry, 'valid');
  assert.equal(out.packet.snapshot.before, out.packet.snapshot.after);
  await rm(first.root, { recursive: true, force: true });
  const afterDelete = await world.json(['projects', 'list']);
  assert.equal(afterDelete.packet.data.projects.length, 2, 'list is the registry, not a scan');
});

test('list of a registry that does not exist yet is an empty ok answer and creates nothing', async (t) => {
  const world = await desktopWorld(t);
  const out = await world.json(['projects', 'list']);
  assert.deepEqual([out.exitCode, out.packet.status, out.packet.data.registry, out.packet.data.projects], [0, 'ok', 'absent', []]);
  assert.equal(await exists(world.config), false);
});

test('remove deletes the registry entry and nothing in the project, by root, by path or by name', async (t) => {
  const world = await desktopWorld(t);
  const repos = [await world.project(), await world.project(), await world.project()];
  for (const repo of repos) await add(world, repo.root);
  await add(world, repos[1].root, '--name', 'second');
  const digests = await Promise.all(repos.map((repo) => treeDigest(repo)));

  const byPath = await world.json(['projects', 'remove', repos[0].root]);
  assert.deepEqual([byPath.exitCode, byPath.packet.status, byPath.packet.data.outcome], [0, 'ok', 'removed'], byPath.text);
  assert.equal(validateProjectsRemove(byPath.packet.data).ok, true, JSON.stringify(validateProjectsRemove(byPath.packet.data).issues));
  const byName = await world.json(['projects', 'remove', 'second']);
  assert.equal(byName.packet.data.outcome, 'removed');
  const byRoot = await world.json(['projects', 'remove', normalized(repos[2].root)]);
  assert.equal(byRoot.packet.data.outcome, 'removed');
  assert.deepEqual(JSON.parse(await registryText(world)).projects, []);
  for (const [index, repo] of repos.entries()) assert.deepEqual(await treeDigest(repo), digests[index], `project ${index} is untouched`);
});

test('a project whose directory is gone can still be removed; an unknown or ambiguous one is a usage error that writes nothing', async (t) => {
  const world = await desktopWorld(t);
  const repo = await world.project();
  const twin = await world.project();
  await add(world, repo.root, '--name', 'same');
  await add(world, twin.root, '--name', 'same');
  const before = await registryText(world);
  const ambiguous = await world.json(['projects', 'remove', 'same']);
  assert.equal(ambiguous.exitCode, 2, ambiguous.text);
  assert.match(ambiguous.packet.findings[0].message, /more than one/);
  const unknown = await world.json(['projects', 'remove', 'nothing-like-this']);
  assert.equal(unknown.exitCode, 2);
  assert.equal(await registryText(world), before);
  await rm(repo.root, { recursive: true, force: true });
  const gone = await world.json(['projects', 'remove', repo.root]);
  assert.deepEqual([gone.exitCode, gone.packet.data.outcome], [0, 'removed'], gone.text);
});

test('a dry run proposes the result and changes no byte, not even the config folder', async (t) => {
  const world = await desktopWorld(t);
  const repo = await world.project();
  const dry = await add(world, repo.root, '--dry-run');
  assert.deepEqual([dry.packet.data.dry_run, dry.packet.data.outcome, dry.packet.data.project.root.length > 0], [true, 'added', true]);
  assert.notEqual(dry.packet.snapshot.before, dry.packet.snapshot.after, 'the proposed snapshot differs');
  assert.equal(await exists(world.config), false);
  await add(world, repo.root);
  const bytes = await registryText(world);
  const dryRemove = await world.json(['projects', 'remove', repo.root, '--dry-run']);
  assert.deepEqual([dryRemove.packet.data.dry_run, dryRemove.packet.data.outcome], [true, 'removed']);
  assert.equal(await registryText(world), bytes);
});

test('the snapshot of a projects packet moves exactly when the registry bytes move', async (t) => {
  const world = await desktopWorld(t);
  const repo = await world.project();
  const added = await add(world, repo.root);
  assert.notEqual(added.packet.snapshot.before, added.packet.snapshot.after);
  const noop = await add(world, repo.root);
  assert.equal(noop.packet.snapshot.before, noop.packet.snapshot.after);
  assert.equal(noop.packet.snapshot.before, added.packet.snapshot.after);
  const list = await world.json(['projects', 'list']);
  assert.equal(list.packet.snapshot.before, added.packet.snapshot.after);
});

test('the registry has its own lock: a held lock blocks the write with AKRS-C009 and the file stays as it was', async (t) => {
  const world = await desktopWorld(t);
  const repo = await world.project();
  await add(world, repo.root);
  const other = await world.project();
  const before = await registryText(world);
  const held = await acquireRepositoryLock({ lockRoot: world.config, command: 'projects-add' });
  assert.equal(held.status, 'acquired');
  try {
    const out = await world.json(['projects', 'add', other.root], { extraContext: { lock_options: { timeoutMs: 60, retryMs: 5 } } });
    assert.deepEqual([out.exitCode, out.packet.status, out.packet.data.outcome], [1, 'blocked', 'blocked'], out.text);
    assert.deepEqual(codesOf(out.packet), ['AKRS-C009']);
    const removal = await world.json(['projects', 'remove', repo.root], { extraContext: { lock_options: { timeoutMs: 60, retryMs: 5 } } });
    assert.equal(removal.packet.status, 'blocked');
    const reading = await world.json(['projects', 'list']);
    assert.equal(reading.packet.status, 'ok', 'a read never waits for the lock');
  } finally {
    await held.handle.release();
  }
  assert.equal(await registryText(world), before);
  assert.equal((await add(world, other.root)).packet.data.outcome, 'added');
});

test('four processes adding at once all land: the lock serializes read-modify-write', async (t) => {
  const world = await desktopWorld(t);
  const repos = [];
  for (let index = 0; index < 4; index += 1) repos.push(await world.project());
  const results = await Promise.all(repos.map((repo) => runCli(['projects', 'add', repo.root, '--json'], { env: { AKRS_CONFIG_HOME: world.config } })));
  for (const result of results) assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  const stored = JSON.parse(await registryText(world));
  assert.equal(validateRegistry(stored).ok, true);
  assert.equal(stored.projects.length, 4);
  assert.deepEqual((await readdir(world.config)).sort(), ['.ops', 'projects.json']);
});

test('the real CLI honours AKRS_CONFIG_HOME and rejects a relative one with exit 2', async (t) => {
  const world = await desktopWorld(t);
  const repo = await world.project();
  const ok = await runCli(['projects', 'add', repo.root, '--json'], { env: { AKRS_CONFIG_HOME: world.config } });
  assert.equal(ok.exitCode, 0, ok.stdout + ok.stderr);
  const relative = await runCli(['projects', 'list', '--json'], { env: { AKRS_CONFIG_HOME: 'relative/dir' } });
  assert.equal(relative.exitCode, 2, relative.stdout + relative.stderr);
});

test('an invalid registry is never overwritten: every command answers AKRS-C022 registry_invalid', async (t) => {
  const world = await desktopWorld(t);
  const repo = await world.project();
  await mkdir(world.config, { recursive: true });
  for (const garbage of ['not json at all', '{"schema":"akrs.projects/v1","projects":[{"root":"relative"}]}', '[]']) {
    await writeFile(registryFile(world), garbage);
    for (const argv of [['projects', 'add', repo.root], ['projects', 'remove', 'x'], ['projects', 'list']]) {
      const out = await world.json(argv);
      assert.deepEqual([out.exitCode, out.packet.status], [1, 'error'], `${argv.join(' ')}: ${out.text}`);
      assert.deepEqual(codesOf(out.packet), ['AKRS-C022']);
      assert.equal(out.packet.findings[0].detail.reason, 'registry_invalid');
    }
    assert.equal(await registryText(world), garbage, 'the invalid file is left for the user');
  }
});

test('a registry that is a directory is invalid, not read as empty', async (t) => {
  const world = await desktopWorld(t);
  await mkdir(registryFile(world), { recursive: true });
  const out = await world.json(['projects', 'list']);
  assert.equal(out.packet.findings[0].detail.reason, 'registry_invalid');
});

test('a leftover temporary file from a crashed writer is ignored by readers and by the next write', async (t) => {
  const world = await desktopWorld(t);
  const repo = await world.project();
  await mkdir(world.config, { recursive: true });
  await writeFile(join(world.config, 'projects.json.tmp-deadbeef0000'), '{ torn');
  const out = await add(world, repo.root);
  assert.equal(out.packet.data.outcome, 'added');
  assert.equal(validateRegistry(JSON.parse(await registryText(world))).ok, true);
});

test('the registry holds at most 500 projects', async (t) => {
  const world = await desktopWorld(t);
  const repo = await world.project();
  await mkdir(world.config, { recursive: true });
  const projects = Array.from({ length: 500 }, (_, index) => ({ root: `/p/${String(index).padStart(3, '0')}`, workflow: 'akrs', name: `p${index}`, added_at: '2026-10-22T08:00:00.000Z' }));
  await writeFile(registryFile(world), `${JSON.stringify({ schema: 'akrs.projects/v1', projects }, null, 2)}\n`);
  const out = await add(world, repo.root);
  assert.deepEqual([out.packet.status, out.packet.data.outcome, out.packet.data.reason], ['error', 'full', 'registry_full']);
  assert.deepEqual(codesOf(out.packet), ['AKRS-C022']);
});
