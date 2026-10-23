// P2-W11 gate 6: a future adapter (the desktop app) drives the whole Worker loop through the PUBLIC core only: plain objects in, plain
// packets out. It imports lib/core/index.js and nothing else from lib/, never the command-line entry point, a renderer or a terminal parser. The static
// checks below apply to this adapter and to the P2-W17 desktop adapter; the run proves the loop is reachable without the binary.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandHandlers, commandManifest, createDefaultProviders } from '../../lib/core/index.js';
import { createTempRepository } from '../helpers/temp-repository.js';
import { git } from './support.js';

const REPOSITORY = fileURLToPath(new URL('../../', import.meta.url));
const ADAPTERS = [fileURLToPath(import.meta.url), resolve(REPOSITORY, 'test/desktop-ready/adapter.test.js')];
const providers = createDefaultProviders();
// spelled in pieces so that this file does not trip its own check
const FORBIDDEN_TEXT = [['bin/', 'akrs'], ['cli-', 'adapter'], ['child_', 'process'], ['.std', 'out'], ['render', 'Prompt'], ['render', 'Human'], ['run', 'Cli']].map((parts) => parts.join(''));

// the whole adapter: plain input in, plain packet out
function adapter(cwd) {
  return async function call(id, { positionals = {}, flags = {} } = {}) {
    const result = await commandHandlers[id]({
      command: commandManifest.commands.find((entry) => entry.id === id),
      context: { cwd, env: {}, platform: process.platform },
      input: { flags: { '--root': cwd, ...flags }, positionals, format: 'json', stdin: false },
      manifest: commandManifest,
      providers,
      readStdin: async () => Buffer.alloc(0),
    });
    return result?.packet ?? result;
  };
}

const importSpecifiers = (source) => [
  ...source.matchAll(/^\s*(?:import|export)\b[^;]*?\sfrom\s*'([^']+)'/gm),
  ...source.matchAll(/^\s*import\s*'([^']+)'/gm),
  ...source.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g),
].map((match) => match[1]);

test('gate 6: the adapters import the public core and nothing else from lib/, never the binary, a renderer or a terminal parser', async () => {
  for (const file of ADAPTERS) {
    const source = await readFile(file, 'utf8');
    const specifiers = importSpecifiers(source);
    assert.ok(specifiers.length > 0, `${file}: imports were found`);
    for (const specifier of specifiers) {
      if (specifier.startsWith('node:')) continue;
      const target = resolve(dirname(file), specifier).replaceAll('\\', '/');
      const relative = target.slice(REPOSITORY.replaceAll('\\', '/').length);
      assert.ok(!/^bin\//.test(relative), `${file} imports ${relative}`);
      assert.ok(!/renderers/.test(relative), `${file} imports a renderer: ${relative}`);
      if (relative.startsWith('lib/')) assert.equal(relative, 'lib/core/index.js', `${file} reaches past the public core: ${relative}`);
    }
    for (const forbidden of FORBIDDEN_TEXT) {
      assert.equal(source.includes(forbidden), false, `${file} mentions ${forbidden}`);
    }
  }
});

test('gate 6: scaffold, classify, assign, activate, work and done run through core handlers with plain objects', async (t) => {
  const repo = await createTempRepository(t, { prefix: 'akrs-gate-core-' });
  const call = adapter(repo.root);
  await repo.write('README.md', '# Demo\n');
  await git(repo.root, ['init', '-q']);
  for (const [key, value] of [['user.email', 'gate@example.test'], ['user.name', 'gate'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) await git(repo.root, ['config', key, value]);

  const scaffold = await call('init-scaffold');
  assert.deepEqual([scaffold.status, scaffold.data.scaffold.road_id, scaffold.data.scaffold.tier], ['ok', 'R1', 'no_plan']);
  for (const [id, role, klass] of [['lead', 'leader', 'frontier'], ['worker', 'worker', 'weak']]) {
    const set = await call('executor-set', { positionals: { id }, flags: { '--role': role, '--class': klass, '--label': id, '--answer': klass } });
    assert.equal(set.status, 'ok', JSON.stringify(set.findings));
  }
  await git(repo.root, ['add', '-A']);
  await git(repo.root, ['commit', '-q', '-m', 'baseline']);

  // the Leader gives the Road its class from a draft, with the snapshot its own dry run reports
  const { meta: _meta, ...stored } = JSON.parse(await readFile(repo.path('akrs/roads/R1.json'), 'utf8'));
  await mkdir(repo.path('akrs/drafts'), { recursive: true });
  await writeFile(repo.path('akrs/drafts/road.json'), `${JSON.stringify({ ...stored, executor_class: 'weak' }, null, 2)}\n`);
  const updateFlags = { '--input': 'akrs/drafts/road.json', '--reason': 'weak Worker' };
  const dry = await call('road-update', { positionals: { id: 'R1' }, flags: { ...updateFlags, '--dry-run': true } });
  const updated = await call('road-update', { positionals: { id: 'R1' }, flags: { ...updateFlags, '--if-snapshot': dry.snapshot.before } });
  assert.equal(updated.status, 'ok', JSON.stringify(updated.findings));
  const activateDry = await call('road-activate', { positionals: { id: 'R1' }, flags: { '--dry-run': true } });
  assert.equal((await call('road-activate', { positionals: { id: 'R1' }, flags: { '--if-snapshot': activateDry.snapshot.before } })).status, 'ok');

  // the Worker: work, edit, done
  const claimed = await call('work');
  assert.deepEqual([claimed.status, claimed.data.kind, claimed.data.road], ['ok', 'work', 'R1']);
  await repo.write('README.md', '# Demo\n\nThis project serves its README over HTTP.\n');
  const finished = await call('done', { positionals: { road: 'R1' }, flags: { '--result': 'README describes the project', '--reach': ['open README.md'], '--expect': 'the sentence about HTTP' } });
  assert.equal(finished.status, 'ok', JSON.stringify(finished.findings));
  assert.deepEqual(finished.next_commands.map(({ command }) => command), ['next']);

  // the packets are plain data: a status with the Road DONE, and a workflow that validates once State is derived
  assert.equal((await call('status')).data.roads.by_status.DONE, 1);
  assert.equal((await call('state-render')).status, 'ok');
  const validated = await call('validate');
  assert.deepEqual([validated.status, validated.findings], ['ok', []]);
  assert.equal(JSON.parse(JSON.stringify(validated)).command, 'validate', 'a packet survives a JSON round trip unchanged');
});
