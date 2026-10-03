import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCliAdapter } from '../../bin/cli-adapter.js';
import { commandHandlers, commandManifest, normalizeAbsolutePath } from '../../lib/core/index.js';
import { getFindingDefinition } from '../../lib/findings/catalog.js';
import { validateCommandManifest } from '../../lib/schemas/command-manifest.js';
import { validateMutationChanges } from '../../lib/schemas/packet.js';
import { byteTreeHash } from '../helpers/byte-tree.js';
import { runCli } from '../helpers/process.js';
import { createTempRepository } from '../helpers/temp-repository.js';
import { listFiles, makeRepo, makeSource, providers, writeTree } from './support.js';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function adapter(argv, repository, context = {}) {
  return runCliAdapter({
    argv,
    cwd: repository.root,
    manifest: commandManifest,
    handlers: commandHandlers,
    providers,
    resolveContext: async () => ({ repository_root: normalizeAbsolutePath(repository.root), ...context }),
  });
}

async function runJson(argv, repository, context) {
  const result = await adapter([...argv, '--json'], repository, context);
  return { ...result, packet: JSON.parse(result.stdout) };
}

async function diff(repository, action) {
  const before = await listFiles(repository.root);
  const result = await action();
  const after = await listFiles(repository.root);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path]).sort();
  return { result, changed };
}

test('manifest exposes init, sync, and postinstall as writers with the required capabilities', () => {
  assert.equal(validateCommandManifest(commandManifest).ok, true);
  const byId = Object.fromEntries(commandManifest.commands.map((entry) => [entry.id, entry]));
  for (const id of ['init', 'sync', 'postinstall']) {
    const entry = byId[id];
    assert.equal(entry.mutability, 'mutation', id);
    assert.equal(entry.dry_run, true, id);
    assert.equal(entry.idempotency, id === 'postinstall' ? 'none' : 'journal', id);
    assert.deepEqual(entry.tokens, [id]);
    assert.equal(typeof commandHandlers[id], 'function', id);
  }
  const flagNames = (id) => byId[id].flags.map(({ name }) => name);
  assert.deepEqual(flagNames('init'), [
    '--root', '--dry-run', '--force', '--json', '--jsonl', '--prompt',
  ]);
  assert.deepEqual(flagNames('sync'), [
    '--root', '--dry-run', '--json', '--jsonl', '--prompt',
  ]);
  assert.deepEqual(flagNames('postinstall'), ['--json', '--jsonl', '--prompt']);
  assert.deepEqual(byId.postinstall.exit_codes, [0]);
  assert.equal(byId.init.flags.find(({ name }) => name === '--force').value_type, 'boolean');
});

test('every new finding code explains itself from the catalog', async () => {
  const definition = getFindingDefinition('AKRS-C007');
  assert.equal(definition.category, 'command');
  assert.equal(definition.severity, 'warning');
  assert.match(definition.remediation, /unowned_differs/);
  assert.match(definition.remediation, /v1/);
  assert.match(definition.remediation, /keep the local file/i);
  assert.match(definition.remediation, /init --force/);
  assert.match(definition.remediation, /discards every local edit/);
  const result = await runCliAdapter({
    argv: ['explain', 'AKRS-C007', '--json'],
    cwd: 'E:/project',
    manifest: commandManifest,
    handlers: commandHandlers,
    providers,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout).data.finding, definition);
});

test('init works in a project with no akrs workflow and reports exactly what it changed', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t, { 'package.json': '{}\n' });
  const { result, changed } = await diff(repository, () => runJson(
    ['init', '--root', repository.root], repository, { source_root: source.root },
  ));
  assert.equal(result.exitCode, 0);
  const { packet } = result;
  assert.equal(packet.command, 'init');
  assert.equal(packet.status, 'ok');
  assert.match(packet.request_id, ULID);
  assert.equal(packet.root, normalizeAbsolutePath(repository.root));
  assert.deepEqual(packet.changed, changed);
  assert.equal(validateMutationChanges(packet, changed).ok, true);
  assert.equal(packet.data.kind, 'install');
  assert.equal(packet.data.action, 'init');
  assert.equal(packet.data.dry_run, false);
  assert.equal(packet.data.applied, true);
  assert.deepEqual(packet.data.changes.map(({ path }) => path), packet.changed);
  assert.notEqual(packet.snapshot.before, packet.snapshot.after);
  assert.deepEqual(packet.findings, []);
  await assert.rejects(() => readFile(join(repository.root, 'akrs')));
});

test('init over an existing target is a usage error and changes nothing; --force replaces it', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  const context = { source_root: source.root };
  await runJson(['init', '--root', repository.root], repository, context);
  await writeFile(repository.path('docs/akrs/framework/01-Constitution.md'), 'LOCAL\n');
  await writeFile(repository.path('docs/akrs/ghost.md'), 'ghost\n');
  const before = await byteTreeHash(repository.root);

  const refused = await runJson(['init', '--root', repository.root], repository, context);
  assert.equal(refused.exitCode, 2);
  assert.equal(refused.packet.findings[0].code, 'AKRS-C001');
  assert.equal(await byteTreeHash(repository.root), before);

  const dry = await runJson(['init', '--force', '--dry-run', '--root', repository.root], repository, context);
  assert.equal(dry.exitCode, 0);
  assert.equal(dry.packet.status, 'ok');
  assert.deepEqual(dry.packet.changed, []);
  assert.equal(dry.packet.data.dry_run, true);
  assert.equal(dry.packet.data.applied, false);
  assert.deepEqual(dry.packet.data.changes.map(({ action }) => action).sort(), ['remove', 'update']);
  assert.equal(dry.packet.snapshot.before, dry.packet.snapshot.after);
  assert.equal(validateMutationChanges(dry.packet, []).ok, true);
  assert.equal(await byteTreeHash(repository.root), before);

  const forced = await diff(repository, () => runJson(
    ['init', '--force', '--root', repository.root], repository, context,
  ));
  assert.equal(forced.result.exitCode, 0);
  assert.deepEqual(forced.result.packet.changed, forced.changed);
  assert.deepEqual(forced.result.packet.data.changes, dry.packet.data.changes);
  assert.equal(await readFile(repository.path('docs/akrs/framework/01-Constitution.md'), 'utf8'), 'constitution v1\n');
  await assert.rejects(() => readFile(repository.path('docs/akrs/ghost.md')));

  const hash = await byteTreeHash(repository.root);
  const again = await runJson(['init', '--force', '--root', repository.root], repository, context);
  assert.equal(again.exitCode, 0);
  assert.equal(again.packet.status, 'noop');
  assert.deepEqual(again.packet.changed, []);
  assert.equal(await byteTreeHash(repository.root), hash);
});

test('sync is the explicit refresh: dry-run reports, apply changes, repeat is a noop', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  const context = { source_root: source.root };
  await runJson(['init', '--root', repository.root], repository, context);
  await writeTree(source.root, {
    'docs/framework/02-Spec.md': 'spec v2\n',
    'docs/framework/09-New.md': 'new\n',
  });
  await rm(join(source.root, 'docs/framework/skills/akrs-close-out.md'));

  const before = await byteTreeHash(repository.root);
  const dry = await runJson(['sync', '--dry-run', '--root', repository.root], repository, context);
  assert.equal(dry.exitCode, 0);
  assert.equal(dry.packet.status, 'ok');
  assert.deepEqual(dry.packet.changed, []);
  assert.deepEqual(dry.packet.data.changes, [
    { path: 'docs/akrs/.akrs-install.json', action: 'update' },
    { path: 'docs/akrs/framework/02-Spec.md', action: 'update' },
    { path: 'docs/akrs/framework/09-New.md', action: 'create' },
    { path: 'docs/akrs/framework/skills/akrs-close-out.md', action: 'remove' },
  ]);
  assert.equal(await byteTreeHash(repository.root), before);

  const applied = await diff(repository, () => runJson(['sync', '--root', repository.root], repository, context));
  assert.equal(applied.result.exitCode, 0);
  assert.equal(applied.result.packet.status, 'ok');
  assert.deepEqual(applied.result.packet.changed, applied.changed);
  assert.deepEqual(applied.result.packet.data.changes, dry.packet.data.changes);
  assert.equal(validateMutationChanges(applied.result.packet, applied.changed).ok, true);

  const after = await byteTreeHash(repository.root);
  const repeat = await runJson(['sync', '--root', repository.root], repository, context);
  assert.equal(repeat.exitCode, 0);
  assert.equal(repeat.packet.status, 'noop');
  assert.deepEqual(repeat.packet.changed, []);
  assert.equal(await byteTreeHash(repository.root), after);
});

test('sync reports a preserved local edit as an AKRS-C007 finding with exit 1', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  const context = { source_root: source.root };
  await runJson(['init', '--root', repository.root], repository, context);
  await writeFile(repository.path('docs/akrs/GETTING_STARTED.md'), 'my notes\n');
  await writeTree(source.root, { 'GETTING_STARTED.md': 'getting started v2\n' });
  const before = await byteTreeHash(repository.root);
  const result = await runJson(['sync', '--root', repository.root], repository, context);
  assert.equal(result.exitCode, 1);
  assert.equal(result.packet.status, 'warning');
  assert.deepEqual(result.packet.changed, []);
  assert.equal(result.packet.findings.length, 1);
  const [finding] = result.packet.findings;
  assert.equal(finding.code, 'AKRS-C007');
  assert.equal(finding.severity, 'warning');
  assert.equal(finding.file, 'docs/akrs/GETTING_STARTED.md');
  assert.deepEqual(finding.detail, { path: 'docs/akrs/GETTING_STARTED.md', reason: 'locally_modified' });
  assert.equal(await byteTreeHash(repository.root), before);
  assert.notEqual(result.stderr, undefined);
  const human = await adapter(['sync', '--root', repository.root], repository, context);
  assert.equal(human.exitCode, 1);
  assert.match(human.stderr, /AKRS-C007/);
});

test('dry-run mutation packets still carry a request id', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  const context = { source_root: source.root };
  const [init, sync] = [
    await runJson(['init', '--dry-run', '--root', repository.root], repository, context),
    await runJson(['sync', '--dry-run', '--root', repository.root], repository, context),
  ];
  assert.match(init.packet.request_id, ULID);
  assert.match(sync.packet.request_id, ULID);
});

test('init and sync resolve the repository root from --root rather than the workflow', async (t) => {
  const source = await makeSource(t);
  const repository = await makeRepo(t);
  const elsewhere = await createTempRepository(t, { prefix: 'akrs-install-cwd-' });
  const result = await runCliAdapter({
    argv: ['init', '--root', repository.root, '--json'],
    cwd: elsewhere.root,
    manifest: commandManifest,
    handlers: commandHandlers,
    providers,
    resolveContext: async () => ({ repository_root: 'unused', source_root: source.root }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).root, normalizeAbsolutePath(repository.root));
  assert.equal((await listFiles(elsewhere.root))['docs/akrs/GETTING_STARTED.md'], undefined);
  assert.equal((await listFiles(repository.root))['docs/akrs/GETTING_STARTED.md'], 'getting started v1\n');
});

async function installedPackage(t, files) {
  const project = await makeRepo(t, { 'package.json': '{"name":"host"}\n' });
  const packageRoot = project.path('node_modules/akrs-framework');
  await mkdir(packageRoot, { recursive: true });
  await writeTree(packageRoot, files);
  return { project, packageRoot };
}

const SRC = {
  'docs/framework/01-Constitution.md': 'constitution v1\n',
  'docs/framework/02-Spec.md': 'spec v1\n',
  'GETTING_STARTED.md': 'getting started v1\n',
};

function postinstall(project, packageRoot, env, extra = {}, format = '--json') {
  return adapter(['postinstall', format], project, {
    env,
    package_root: packageRoot,
    source_root: packageRoot,
    ...extra,
  });
}

test('B14 postinstall acts only when installed as a dependency and never fails the host', async (t) => {
  const { project, packageRoot } = await installedPackage(t, SRC);
  const own = await makeRepo(t, SRC);
  const before = await byteTreeHash(project.root);
  const skips = [
    ['no INIT_CWD', {}, packageRoot, 'no_init_cwd'],
    ['empty INIT_CWD', { INIT_CWD: '' }, packageRoot, 'no_init_cwd'],
    ['opt out', { INIT_CWD: project.root, AKRS_SKIP_POSTINSTALL: '1' }, packageRoot, 'skip_requested'],
    ['global install', { INIT_CWD: project.root, npm_config_global: 'true' }, packageRoot, 'global_install'],
    ['npx exec', { INIT_CWD: project.root, npm_command: 'exec' }, packageRoot, 'exec_install'],
    ['own repository', { INIT_CWD: own.root }, own.root, 'not_a_dependency'],
    ['package outside node_modules', { INIT_CWD: project.root }, project.root, 'not_a_dependency'],
    ['INIT_CWD is the package', { INIT_CWD: packageRoot }, packageRoot, 'init_cwd_is_package'],
  ];
  for (const [name, env, root, reason] of skips) {
    const result = await postinstall(project, root, env);
    assert.equal(result.exitCode, 0, name);
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.status, 'noop', name);
    assert.equal(packet.data.outcome, 'skipped', name);
    assert.equal(packet.data.reason, reason, name);
    assert.deepEqual(packet.changed, [], name);
    assert.deepEqual(packet.findings, [], name);
    assert.match(packet.request_id, ULID, name);
  }
  assert.equal(await byteTreeHash(project.root), before);
  assert.deepEqual(await listFiles(own.root), SRC);
});

test('B14 postinstall installs, preserves local edits, and stays deterministic', async (t) => {
  const { project, packageRoot } = await installedPackage(t, SRC);
  const env = { INIT_CWD: project.root };

  const first = await diff(project, async () => postinstall(project, packageRoot, env));
  assert.equal(first.result.exitCode, 0);
  const created = JSON.parse(first.result.stdout);
  assert.equal(created.status, 'ok');
  assert.equal(created.data.outcome, 'synced');
  assert.deepEqual(created.changed, first.changed.filter((path) => !path.startsWith('node_modules/')));
  assert.equal(await readFile(project.path('docs/akrs/framework/02-Spec.md'), 'utf8'), 'spec v1\n');

  const hash = await byteTreeHash(project.root);
  const second = JSON.parse((await postinstall(project, packageRoot, env)).stdout);
  assert.equal(second.status, 'noop');
  assert.equal(second.data.outcome, 'noop');
  assert.equal(await byteTreeHash(project.root), hash);

  await writeFile(project.path('docs/akrs/framework/02-Spec.md'), 'LOCAL EDIT\n');
  await writeTree(packageRoot, {
    'docs/framework/01-Constitution.md': 'constitution v2\n',
    'docs/framework/02-Spec.md': 'spec v2\n',
  });
  const run = () => postinstall(project, packageRoot, env, {}, '--json');
  const third = await run();
  assert.equal(third.exitCode, 0);
  const packet = JSON.parse(third.stdout);
  assert.equal(packet.status, 'warning');
  assert.equal(packet.data.outcome, 'conflicts');
  assert.equal(packet.findings.length, 1);
  assert.equal(packet.findings[0].code, 'AKRS-C007');
  assert.equal(packet.findings[0].file, 'docs/akrs/framework/02-Spec.md');
  assert.equal(await readFile(project.path('docs/akrs/framework/02-Spec.md'), 'utf8'), 'LOCAL EDIT\n');
  assert.equal(await readFile(project.path('docs/akrs/framework/01-Constitution.md'), 'utf8'), 'constitution v2\n');

  const settled = await byteTreeHash(project.root);
  const fourth = await run();
  assert.equal(fourth.exitCode, 0);
  assert.equal(JSON.parse(fourth.stdout).status, 'warning');
  assert.deepEqual(JSON.parse(fourth.stdout).changed, []);
  assert.deepEqual(JSON.parse(fourth.stdout).findings, packet.findings);
  assert.equal(await byteTreeHash(project.root), settled);

  const plain = await adapter(['postinstall'], project, {
    env, package_root: packageRoot, source_root: packageRoot,
  });
  assert.equal(plain.exitCode, 0);
  assert.equal(plain.stdout, '');
  assert.match(plain.stderr, /AKRS-C007/);
  assert.match(plain.stderr, /docs\/akrs\/framework\/02-Spec\.md/);
});

test('B14 postinstall reports an unusable source in the packet instead of swallowing it', async (t) => {
  const { project, packageRoot } = await installedPackage(t, { 'unrelated.txt': 'x\n' });
  const before = await byteTreeHash(project.root);
  const result = await postinstall(project, packageRoot, { INIT_CWD: project.root }, {}, '--json');
  assert.equal(result.exitCode, 0);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.status, 'error');
  assert.equal(packet.data.outcome, 'failed');
  assert.equal(packet.findings[0].code, 'AKRS-C004');
  assert.match(packet.findings[0].detail.reason, /packaged doctrine/);
  assert.equal(await byteTreeHash(project.root), before);

  const human = await adapter(['postinstall'], project, {
    env: { INIT_CWD: project.root }, package_root: packageRoot, source_root: packageRoot,
  });
  assert.equal(human.exitCode, 0);
  assert.match(human.stderr, /AKRS-C004/);

  const missing = await postinstall(project, packageRoot, { INIT_CWD: join(project.root, 'does-not-exist') }, {}, '--json');
  assert.equal(missing.exitCode, 0);
  assert.equal(JSON.parse(missing.stdout).status, 'error');
});

test('postinstall by real process never leaks the host environment into the decision', async (t) => {
  const repository = await makeRepo(t);
  const before = await byteTreeHash(repository.root);
  for (const env of [
    { INIT_CWD: '', AKRS_SKIP_POSTINSTALL: '' },
    { INIT_CWD: repository.root, AKRS_SKIP_POSTINSTALL: '1' },
    { INIT_CWD: repository.root, AKRS_SKIP_POSTINSTALL: '' },
  ]) {
    const result = await runCli(['postinstall', '--json'], { cwd: repository.root, env });
    assert.equal(result.exitCode, 0, JSON.stringify(env));
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.command, 'postinstall');
    assert.equal(packet.status, 'noop');
    assert.equal(packet.data.outcome, 'skipped');
  }
  assert.equal(await byteTreeHash(repository.root), before);
});

test('init and sync by real process install the packaged doctrine and stay idempotent', async (t) => {
  const repository = await makeRepo(t, { 'package.json': '{}\n' });
  const init = await runCli(['init', '--root', repository.root, '--json'], { cwd: repository.root });
  assert.equal(init.exitCode, 0, init.stderr);
  const created = JSON.parse(init.stdout);
  assert.equal(created.status, 'ok');
  assert.equal(created.changed.includes('docs/akrs/GETTING_STARTED.md'), true);
  assert.equal(created.changed.every((path) => path.startsWith('docs/akrs/')), true);

  const hash = await byteTreeHash(repository.root);
  const sync = await runCli(['sync', '--root', repository.root, '--json'], { cwd: repository.root });
  assert.equal(sync.exitCode, 0, sync.stderr);
  assert.equal(JSON.parse(sync.stdout).status, 'noop');
  const refused = await runCli(['init', '--root', repository.root, '--json'], { cwd: repository.root });
  assert.equal(refused.exitCode, 2);
  const forced = await runCli(['init', '--force', '--root', repository.root, '--json'], { cwd: repository.root });
  assert.equal(forced.exitCode, 0, forced.stderr);
  assert.equal(JSON.parse(forced.stdout).status, 'noop');
  assert.equal(await byteTreeHash(repository.root), hash);
});
