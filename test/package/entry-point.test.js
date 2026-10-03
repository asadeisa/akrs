import assert from 'node:assert/strict';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runNode } from '../helpers/process.js';
import { createTempRepository } from '../helpers/temp-repository.js';
import { describeFailure, repositoryRoot } from './pack-harness.js';

const NODE_REFUSAL = /^akrs requires Node\.js >=22\.17\.0; found v20\.1\.0\. Upgrade Node\.js and retry\.\n$/;
const INTERNAL_ERROR = /^akrs: internal error: [^\n]+\n$/;

async function fakeOldNode(t) {
  const directory = await createTempRepository(t, { prefix: 'akrs-entry-pre-' });
  const preload = await directory.write(
    'pre.cjs',
    "Object.defineProperty(process, 'versions', {"
    + " value: Object.assign({}, process.versions, { node: '20.1.0' }), configurable: true });\n",
  );
  return preload;
}

async function copyPackage(t) {
  const copy = await createTempRepository(t, { prefix: 'akrs-entry-pkg-' });
  for (const entry of ['bin', 'lib', 'package.json', 'docs/framework', 'GETTING_STARTED.md']) {
    await mkdir(join(copy.root, entry, '..'), { recursive: true });
    await cp(join(repositoryRoot, entry), join(copy.root, entry), { recursive: true });
  }
  return copy;
}

test('unsupported Node refuses with exit 2, stderr only, and empty stdout', async (t) => {
  const preload = await fakeOldNode(t);
  for (const args of [['--version', '--json'], ['--help'], ['validate', '--json'], []]) {
    const result = await runNode(['--require', preload, join(repositoryRoot, 'bin', 'akrs.js'), ...args]);
    assert.equal(result.exitCode, 2, describeFailure(args.join(' '), result));
    assert.equal(result.stdout, '', describeFailure(args.join(' '), result));
    assert.match(result.stderr, NODE_REFUSAL);
  }
});

test('unsupported Node never fails the host install: postinstall refuses with exit 0 and a message', async (t) => {
  const preload = await fakeOldNode(t);
  const host = await createTempRepository(t, { prefix: 'akrs-entry-host-' });
  for (const args of [['postinstall'], ['postinstall', '--json']]) {
    const result = await runNode(
      ['--require', preload, join(repositoryRoot, 'bin', 'akrs.js'), ...args],
      { cwd: host.root, env: { INIT_CWD: host.root, AKRS_SKIP_POSTINSTALL: '' } },
    );
    assert.equal(result.exitCode, 0, describeFailure(args.join(' '), result));
    assert.equal(result.stdout, '', describeFailure(args.join(' '), result));
    assert.match(result.stderr, NODE_REFUSAL);
  }
  assert.deepEqual(await readdir(host.root), []);
});

test('a module that fails to load is an internal error: exit 4, one stderr line, stdout empty', async (t) => {
  const copy = await copyPackage(t);
  await rm(join(copy.root, 'lib', 'commands', 'validation.js'));
  for (const args of [['--version', '--json'], ['--help'], ['validate', '--json']]) {
    const result = await runNode([join(copy.root, 'bin', 'akrs.js'), ...args], { cwd: copy.root });
    assert.equal(result.exitCode, 4, describeFailure(args.join(' '), result));
    assert.equal(result.stdout, '', describeFailure(args.join(' '), result));
    assert.match(result.stderr, INTERNAL_ERROR, describeFailure(args.join(' '), result));
    assert.equal(result.stderr.includes('    at '), false, 'no stack trace');
  }
});

test('a module that fails to load never fails the host install: postinstall exits 0 with a message', async (t) => {
  const copy = await copyPackage(t);
  await rm(join(copy.root, 'lib', 'commands', 'validation.js'));
  const host = await createTempRepository(t, { prefix: 'akrs-entry-host-' });
  for (const args of [['postinstall'], ['postinstall', '--json']]) {
    const result = await runNode([join(copy.root, 'bin', 'akrs.js'), ...args], {
      cwd: host.root,
      env: { INIT_CWD: host.root, AKRS_SKIP_POSTINSTALL: '' },
    });
    assert.equal(result.exitCode, 0, describeFailure(args.join(' '), result));
    assert.equal(result.stdout, '', describeFailure(args.join(' '), result));
    assert.match(result.stderr, INTERNAL_ERROR, describeFailure(args.join(' '), result));
  }
  assert.deepEqual(await readdir(host.root), []);
});

test('the copied package works until a module is removed (the failure test is not vacuous)', async (t) => {
  const copy = await copyPackage(t);
  const result = await runNode([join(copy.root, 'bin', 'akrs.js'), '--version', '--json'], { cwd: copy.root });
  assert.equal(result.exitCode, 0, describeFailure('copy --version', result));
  assert.equal(JSON.parse(result.stdout).data.kind, 'version');
  await writeFile(join(copy.root, 'lib', 'commands', 'validation.js'), 'export {};\n');
  const broken = await runNode([join(copy.root, 'bin', 'akrs.js'), '--version', '--json'], { cwd: copy.root });
  assert.equal(broken.exitCode, 4, describeFailure('stubbed validation module', broken));
});
