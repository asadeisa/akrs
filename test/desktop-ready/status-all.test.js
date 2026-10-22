// P2-W17: `status --all-projects` reads the registered roots read-only and never writes to them, whatever state they are in.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateStatusAllProjects } from '../../lib/schemas/desktop.js';
import { claimRoad } from '../navigation/support.js';
import { codesOf, desktopWorld, plainDirectory, treeDigest } from './support.js';

async function registered(world, ...repos) {
  for (const repo of repos) {
    const out = await world.json(['projects', 'add', repo.root]);
    assert.equal(out.exitCode, 0, out.text);
  }
}

test('every registered project appears with exactly the status its own `status --json` returns', async (t) => {
  const world = await desktopWorld(t);
  const first = await world.project();
  const second = await world.project();
  await claimRoad(second, 'R-P6-1', 'flash');
  await registered(world, first, second);
  const all = await world.json(['status', '--all-projects']);
  assert.equal(all.exitCode, 0, all.text);
  assert.deepEqual([all.packet.command, all.packet.status, all.packet.data.kind, all.packet.data.packet_version], ['status', 'ok', 'status_all_projects', 'akrs.status-all/v1']);
  assert.equal(validateStatusAllProjects(all.packet.data).ok, true, JSON.stringify(validateStatusAllProjects(all.packet.data).issues));
  assert.equal(all.packet.data.projects.length, 2);
  // the registry stores the physical root (Windows 8.3 short names expanded), so compare against it
  const physical = new Map(await Promise.all([first, second].map(async (repo) => [repo, (await realpath(repo.root)).replaceAll('\\', '/').toLowerCase()])));
  for (const entry of all.packet.data.projects) {
    const repo = [first, second].find((candidate) => entry.root.toLowerCase() === physical.get(candidate));
    assert.ok(repo !== undefined, entry.root);
    const own = await world.json(['status'], { cwd: repo.root, extraContext: {} });
    const direct = (await world.json(['status', '--root', repo.root])).packet;
    assert.equal(entry.state, 'ok');
    assert.deepEqual(entry.status, direct.data, 'the embedded status is the project\'s own status');
    assert.equal(own.packet.data.kind, 'status');
  }
  const leased = all.packet.data.projects.find(({ status }) => status.leases.length > 0);
  assert.equal(leased.status.leases[0].holder, 'flash');
});

test('it reads only: no byte of any registered project changes and nothing is created in it', async (t) => {
  const world = await desktopWorld(t);
  const repos = [await world.project(), await world.project()];
  await registered(world, ...repos);
  const before = await Promise.all(repos.map((repo) => treeDigest(repo)));
  const registryBefore = await readFile(join(world.config, 'projects.json'), 'utf8');
  for (let round = 0; round < 2; round += 1) {
    const out = await world.json(['status', '--all-projects']);
    assert.equal(out.exitCode, 0, out.text);
  }
  const prompt = await world.run(['status', '--all-projects', '--prompt']);
  assert.equal(prompt.exitCode, 0, prompt.stderr);
  const human = await world.run(['status', '--all-projects']);
  assert.equal(human.exitCode, 0, human.stderr);
  assert.match(human.stdout, /Roads \d+: ACTIVE/);
  const after = await Promise.all(repos.map((repo) => treeDigest(repo)));
  assert.deepEqual(after, before);
  assert.equal(await readFile(join(world.config, 'projects.json'), 'utf8'), registryBefore, 'the registry is read, not rewritten');
  assert.deepEqual(await readdir(join(world.config, '.ops')), [], 'a read takes no lock');
});

test('it works from a directory that is not a project, and an empty registry is an ok answer', async (t) => {
  const world = await desktopWorld(t);
  const elsewhere = await plainDirectory(t);
  const empty = await world.json(['status', '--all-projects'], { cwd: elsewhere.root });
  assert.deepEqual([empty.exitCode, empty.packet.status, empty.packet.data.registry, empty.packet.data.projects], [0, 'ok', 'absent', []]);
  const repo = await world.project();
  await registered(world, repo);
  const out = await world.json(['status', '--all-projects'], { cwd: elsewhere.root });
  assert.equal(out.packet.data.projects.length, 1);
  assert.deepEqual(await readdir(elsewhere.root), [], 'nothing is written where it runs');
});

test('a project that is gone, no longer an AKRS workflow or unreadable is reported (AKRS-C023) and skipped, never repaired or removed', async (t) => {
  const world = await desktopWorld(t);
  const good = await world.project();
  const gone = await world.project();
  const emptied = await world.project();
  await registered(world, good, gone, emptied);
  await rm(gone.root, { recursive: true, force: true });
  await rm(join(emptied.root, 'akrs'), { recursive: true, force: true });
  await mkdir(join(emptied.root, 'akrs'));
  const registryBefore = await readFile(join(world.config, 'projects.json'), 'utf8');
  const out = await world.json(['status', '--all-projects']);
  assert.deepEqual([out.exitCode, out.packet.status], [1, 'warning'], out.text);
  assert.deepEqual(codesOf(out.packet), ['AKRS-C023']);
  assert.equal(out.packet.findings.length, 2);
  const states = Object.fromEntries(out.packet.data.projects.map(({ root, state }) => [root.split('/').at(-1), state]));
  assert.deepEqual(Object.values(states).sort(), ['missing', 'not_akrs', 'ok']);
  const goodEntry = out.packet.data.projects.find(({ state }) => state === 'ok');
  assert.notEqual(goodEntry.status, null);
  for (const entry of out.packet.data.projects.filter(({ state }) => state !== 'ok')) assert.equal(entry.status, null);
  assert.equal(await readFile(join(world.config, 'projects.json'), 'utf8'), registryBefore, 'nothing is removed from the registry');
  assert.deepEqual(await readdir(join(emptied.root, 'akrs')), [], 'the emptied project was not repaired');
  assert.equal(out.packet.findings[0].detail.project.includes('\\'), false);
});

test('an invalid registry answers AKRS-C022 and an error status, with no project read', async (t) => {
  const world = await desktopWorld(t);
  await mkdir(world.config, { recursive: true });
  await writeFile(join(world.config, 'projects.json'), '{ nope');
  const out = await world.json(['status', '--all-projects']);
  assert.deepEqual([out.exitCode, out.packet.status, codesOf(out.packet), out.packet.data.projects], [1, 'error', ['AKRS-C022'], []]);
});

test('without the flag, status is the project status exactly as before', async (t) => {
  const world = await desktopWorld(t);
  const repo = await world.project();
  const out = await world.json(['status', '--root', repo.root]);
  assert.equal(out.packet.data.kind, 'status');
  assert.equal(out.packet.data.packet_version, 'akrs.status/v1');
});

test('the snapshot of the cross-project packet is the registry snapshot', async (t) => {
  const world = await desktopWorld(t);
  const repo = await world.project();
  await registered(world, repo);
  const list = await world.json(['projects', 'list']);
  const all = await world.json(['status', '--all-projects']);
  assert.equal(all.packet.snapshot.before, list.packet.snapshot.before);
  assert.equal(all.packet.snapshot.before, all.packet.snapshot.after);
});
