// Phase-1 gate 13 and 14: the PACKED tarball is installed into a clean project and the Phase-1 command chain runs from the
// installed code (not from the checkout); the installed manifest, help and file list prove that no legacy, migration or
// prose-parser command or module shipped.
import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { runNode } from '../helpers/process.js';
import { createPackSandbox, describeFailure, installTarball, packTarball, repositoryRoot } from '../package/pack-harness.js';
import { memoryInput } from '../memory/support.js';
import { roadInput } from '../road/support.js';

const SLOW = { timeout: 300_000 };
const LEGACY = /legacy|migrat|prose|import-v1|upgrade-v1|convert|markdown-road/i;

test('gate 13: the packed tarball runs the Phase-1 command chain from installed code', SLOW, async (t) => {
  const sandbox = await createPackSandbox(t);
  const tarball = await packTarball(sandbox);
  const installed = await installTarball(sandbox, tarball);
  assert.equal(installed.install.exitCode, 0, describeFailure('npm install', installed.install));
  const project = sandbox.projectDirectory;
  const run = async (label, args, { stdin, expect = [0] } = {}) => {
    const result = await runNode([installed.binPath, ...args, '--root', project, ...(args.includes('--json') ? [] : ['--json'])], {
      cwd: project, timeoutMs: 60_000, ...(stdin === undefined ? {} : { stdin: typeof stdin === 'string' ? stdin : JSON.stringify(stdin) }),
    });
    assert.ok(expect.includes(result.exitCode), describeFailure(`${label} exit ${result.exitCode}`, result));
    assert.equal(result.stderr, '', `${label}: JSON mode keeps stderr empty`);
    return JSON.parse(result.stdout);
  };

  assert.equal((await run('init --scaffold', ['init', '--scaffold'])).status, 'ok');
  assert.equal((await run('executor set lead', ['executor', 'set', 'lead', '--role', 'leader', '--class', 'frontier', '--label', 'Opus', '--answer', 'frontier'])).status, 'ok');
  assert.equal((await run('executor set flash', ['executor', 'set', 'flash', '--role', 'worker', '--class', 'weak', '--label', 'Flash', '--answer', 'weak'])).status, 'ok');
  const clean = await run('validate', ['validate']);
  assert.equal(clean.status, 'ok');
  assert.deepEqual(clean.findings, []);
  assert.equal(clean.data.coverage.skipped, 0);

  const road = roadInput({ plan: null, task: 'T2', id: 'R2', reads: [{ path: 'package.json', lines: null, why: 'the manifest' }], writes: [{ path: 'src/two.js', class: 'file', action: 'create' }], forbidden: [], boundaries: ['x'], checks: [], executor_class: 'frontier' });
  assert.equal((await run('road new', ['road', 'new', '--json', '-'], { stdin: road })).status, 'ok');
  assert.equal((await run('task new', ['task', 'new', '--json', '-'], { stdin: { schema: 'akrs.task/v1', id: 'T2', plan: null, road: 'R2', objective: 'Do the second thing.', constraints: null, approach: null, notes: null } })).status, 'ok');
  assert.equal((await run('memory add', ['memory', 'add', '--json', '-'], { stdin: memoryInput({ label: 'Assumption High', decided_by: null, pointers: [{ path: 'package.json', lines: null }] }) })).status, 'ok');
  assert.equal((await run('road fit', ['road', 'fit', 'R2'])).command, 'road-fit');
  const requested = await run('scope request', ['scope', 'request', '--json', '-'], { stdin: { schema: 'akrs.scope-request/v1', road: 'R2', add_reads: [], add_writes: [{ path: 'src/three.js', class: 'file', action: 'create' }], reason: 'Needs one more file.', blocking: true }, expect: [0, 1] });
  assert.equal(requested.status, 'warning');
  assert.equal((await run('scope approve', ['scope', 'approve', 'R2', '--reason', 'Agreed'])).status, 'ok');
  assert.equal((await run('log append', ['log', 'append', '--kind', 'road', '--subject', 'R2', '--outcome', 'DONE'])).status, 'ok');
  assert.equal((await run('state set', ['state', 'set', '--mode', '3', '--role', 'leader', '--next', 'Ship R2'])).status, 'ok');
  const rendered = await readFile(join(project, 'akrs', 'STATE.md'), 'utf8');
  const refused = await run('state render of a current STATE.md', ['state', 'render'], { expect: [1] });
  assert.equal(refused.findings[0].detail.reason, 'no_change', 'rendering an already-current STATE.md changes nothing and says so');
  await writeFile(join(project, 'akrs', 'STATE.md'), 'hand edited\n');
  assert.equal((await run('state render', ['state', 'render'])).command, 'state-render');
  assert.equal(await readFile(join(project, 'akrs', 'STATE.md'), 'utf8'), rendered, 'the render restores the committed bytes exactly');
  const final = await run('validate (after the chain)', ['validate'], { expect: [0, 1] });
  assert.equal(final.data.coverage.skipped, 0, 'no check skipped for missing or unclear data');
  assert.equal((await run('test define', ['test', 'define', 'R2', '--json', '-'], { stdin: '{}', expect: [1, 2] })).status, 'error');
  sandbox.assertAllInside();
});

test('gate 14: the installed manifest, help and file list contain no legacy, migration or prose-parser command or module', SLOW, async (t) => {
  const sandbox = await createPackSandbox(t);
  const tarball = await packTarball(sandbox);
  const installed = await installTarball(sandbox, tarball);
  assert.equal(installed.install.exitCode, 0, describeFailure('npm install', installed.install));
  const help = await runNode([installed.binPath, '--help', '--json'], { cwd: sandbox.projectDirectory, timeoutMs: 60_000 });
  assert.equal(help.exitCode, 0, describeFailure('help', help));
  const commands = JSON.parse(help.stdout).data.commands;
  assert.ok(commands.length >= 25, 'the installed manifest lists the Phase-1 commands');
  for (const { id, invocation, summary } of commands) assert.equal(LEGACY.test(`${id} ${invocation} ${summary}`), false, `${id}: no legacy command in help`);
  const text = await runNode([installed.binPath, '--help'], { cwd: sandbox.projectDirectory, timeoutMs: 60_000 });
  assert.equal(LEGACY.test(text.stdout), false, 'human help names no legacy command');
  for (const path of tarball.files) assert.equal(LEGACY.test(path), false, `${path}: no legacy module in the package`);

  // the import graph of the installed entry point
  const seen = new Set();
  const queue = [installed.binPath];
  const importPattern = /(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|^import\s*['"](\.[^'"]+)['"]/gm;
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const target = match[1] ?? match[2] ?? match[3];
      if (target.endsWith('.json')) continue;
      queue.push(join(dirname(file), target));
    }
  }
  assert.ok(seen.size > 50, `the import graph was followed (${seen.size} modules)`);
  for (const file of seen) assert.equal(LEGACY.test(relative(installed.packageRoot, file)), false, `${file}: legacy module in the import graph`);
});

test('gate 14 (checkout): no file under lib/ or bin/ is a legacy, migration or prose-parser module', async () => {
  const offenders = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (LEGACY.test(entry.name)) offenders.push(relative(repositoryRoot, path));
    }
  }
  for (const directory of ['lib', 'bin']) await walk(join(repositoryRoot, directory));
  assert.deepEqual(offenders, []);
  assert.ok((await stat(join(repositoryRoot, 'lib'))).isDirectory());
});
