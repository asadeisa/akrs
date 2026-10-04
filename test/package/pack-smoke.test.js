import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { byteTreeHash } from '../helpers/byte-tree.js';
import { runNode } from '../helpers/process.js';
import {
  createPackSandbox,
  describeFailure,
  gitStatus,
  installTarball,
  packTarball,
  repositoryTarballs,
} from './pack-harness.js';

const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const MISSING_MODULE = /ERR_MODULE_NOT_FOUND|Cannot find module/;

async function runInstalled(installed, sandbox, label, args, expectedExit = 0) {
  const result = await runNode([installed.binPath, ...args], {
    cwd: sandbox.projectDirectory,
    timeoutMs: 30_000,
  });
  assert.equal(
    MISSING_MODULE.test(`${result.stdout}${result.stderr}`),
    false,
    describeFailure(`${label} hit a missing module`, result),
  );
  assert.equal(result.exitCode, expectedExit, describeFailure(label, result));
  return result;
}

// EXECUTION-RULES §6 tarball procedure. Later phase gates reuse pack-harness.js instead of
// writing their own shell cleanup.
test('packed tarball installs into a temp project and runs from the installed copy', async (t) => {
  const statusBefore = await gitStatus();
  const tarballsBefore = await repositoryTarballs();
  const sandbox = await createPackSandbox(t);

  const tarball = await packTarball(sandbox);
  t.diagnostic(`tarball ${tarball.path}`);
  t.diagnostic(`sha256 ${tarball.sha256}`);
  assert.match(tarball.sha256, /^[0-9a-f]{64}$/);
  assert.equal(tarball.version, packageJson.version);
  assert.equal(tarball.filename, `akrs-framework-${packageJson.version}.tgz`);

  const installed = await installTarball(sandbox, tarball);
  assert.equal(installed.install.exitCode, 0, describeFailure('npm install <tarball>', installed.install));
  assert.equal(
    MISSING_MODULE.test(`${installed.install.stdout}${installed.install.stderr}`),
    false,
    describeFailure('npm install hit a missing module', installed.install),
  );

  const help = await runInstalled(installed, sandbox, '--help', ['--help']);
  assert.match(help.stdout, /validate/);

  const version = await runInstalled(installed, sandbox, '--version', ['--version', '--json']);
  const versionPacket = JSON.parse(version.stdout);
  assert.equal(versionPacket.command, 'version');
  assert.equal(versionPacket.status, 'ok');
  assert.equal(versionPacket.data.kind, 'version');
  assert.equal(versionPacket.data.cli_version, packageJson.version);
  assert.equal(versionPacket.data.packet_schema, 'akrs.packet/v2');

  const explain = await runInstalled(installed, sandbox, 'explain', ['explain', 'AKRS-R001', '--json']);
  const explainPacket = JSON.parse(explain.stdout);
  assert.equal(explainPacket.command, 'explain');
  assert.equal(explainPacket.status, 'ok');

  const validate = await runInstalled(installed, sandbox, 'validate', [
    'validate',
    '--root', installed.exampleRoot,
    '--workflow-root', join(installed.exampleRoot, 'akrs'),
    '--json',
  ]);
  const validatePacket = JSON.parse(validate.stdout);
  assert.equal(validatePacket.command, 'validate');
  assert.equal(validatePacket.status, 'ok');
  assert.deepEqual(validatePacket.findings, []);

  // init --scaffold from the installed package: machine fields name the tier, Road and Plan; the result validates honestly.
  const scaffold = await runInstalled(installed, sandbox, 'init-scaffold', [
    'init', '--scaffold', '--root', sandbox.projectDirectory, '--json',
  ]);
  const scaffoldPacket = JSON.parse(scaffold.stdout);
  assert.equal(scaffoldPacket.command, 'init-scaffold');
  assert.equal(scaffoldPacket.status, 'ok');
  assert.deepEqual(
    { tier: scaffoldPacket.data.scaffold.tier, plan_id: scaffoldPacket.data.scaffold.plan_id, road_id: scaffoldPacket.data.scaffold.road_id },
    { tier: 'no_plan', plan_id: null, road_id: 'R1' },
  );
  const scaffolded = await runInstalled(installed, sandbox, 'validate-scaffold', ['validate', '--root', sandbox.projectDirectory, '--json'], 1);
  const scaffoldValidation = JSON.parse(scaffolded.stdout);
  assert.equal(scaffoldValidation.data.coverage.skipped, 0);
  assert.deepEqual(scaffoldValidation.findings.map(({ code }) => code), ['AKRS-S006']);

  // postinstall layout contract shared with the init/sync implementation.
  const docsRoot = sandbox.inside(join(sandbox.projectDirectory, 'docs', 'akrs'));
  assert.equal((await stat(join(docsRoot, 'GETTING_STARTED.md'))).isFile(), true);
  assert.equal((await stat(join(docsRoot, 'framework'))).isDirectory(), true);
  const record = JSON.parse(await readFile(join(docsRoot, '.akrs-install.json'), 'utf8'));
  assert.equal(record.files.some(({ path }) => path === 'GETTING_STARTED.md'), true,
    'the install record must list GETTING_STARTED.md');

  // an explicit sync right after postinstall is a byte-identical noop
  const docsHashBefore = await byteTreeHash(docsRoot);
  const sync = await runInstalled(installed, sandbox, 'sync', [
    'sync', '--root', sandbox.projectDirectory, '--json',
  ]);
  const syncPacket = JSON.parse(sync.stdout);
  assert.equal(syncPacket.command, 'sync');
  assert.equal(syncPacket.status, 'noop');
  assert.deepEqual(syncPacket.changed, []);
  assert.equal(await byteTreeHash(docsRoot), docsHashBefore, 'sync after postinstall changed docs/akrs');

  sandbox.assertAllInside();
  await sandbox.cleanup();
  await assert.rejects(stat(sandbox.root), { code: 'ENOENT' });
  assert.deepEqual(await repositoryTarballs(), tarballsBefore, 'no .tgz may be left in the repository');
  const statusAfter = await gitStatus();
  if (statusBefore === null || statusAfter === null) {
    t.diagnostic('repository is not a git work tree: skipping the git status --short comparison');
  } else {
    assert.equal(statusAfter, statusBefore, 'git status --short changed during the smoke test');
  }
});
