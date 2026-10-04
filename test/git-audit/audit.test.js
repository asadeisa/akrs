import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyChanges, parseStatusZ } from '../../lib/store/git/index.js';
import { assertFindingsMatchCatalog, runCommand } from '../road/support.js';
import { auditPacket, auditWorld, git, put, treeDigest } from './support.js';

const names = (list) => list.map(({ path }) => path);

async function dirty(repo) {
  await put(repo, 'src/own.js', 'changed\n'); // declared, unstaged
  await put(repo, 'src/extra.js', 'extra\n'); // undeclared, untracked
  await put(repo, 'src/other.js', 'staged change\n'); // undeclared, staged
  git(repo, 'add', 'src/other.js');
  await put(repo, 'src/secret.js', 'tampered\n'); // forbidden
  await put(repo, 'test/foo.test.js', 'test changed\n'); // test artifact
  await put(repo, 'akrs/state.json', '{}\n'); // generated workflow
  await put(repo, 'akrs/drafts/x.json', '{}\n'); // draft: excluded
  await put(repo, 'akrs/.cache/c', 'c\n'); // cache: excluded
  await put(repo, 'akrs/.ops/o', 'o\n'); // cache: excluded
  await put(repo, 'akrs/verifications/P6/evidence/a.png', 'png\n'); // evidence
  await put(repo, 'AGENTS.md', 'adapter\n'); // agent adapter
  await put(repo, 'README.md', 'dirty before the Road\n'); // pre-existing
  await put(repo, 'src/gen/a.js', 'generated\n'); // declared by glob
}

test('audit separates every category and is deterministic', async (t) => {
  const repo = await auditWorld(t);
  await dirty(repo);
  const first = await auditPacket(repo, ['--pre-existing', 'README.md']);
  const { audit } = first.data;
  assert.equal(first.status, 'warning');
  assert.equal(audit.status, 'findings');
  assert.deepEqual(names(audit.categories.undeclared), ['src/extra.js', 'src/other.js', 'src/secret.js']);
  assert.deepEqual(audit.categories.undeclared.find(({ path }) => path === 'src/secret.js').forbidden, true);
  assert.deepEqual(names(audit.categories.declared), ['src/gen/a.js', 'src/own.js']);
  assert.deepEqual(names(audit.categories.missing_declared), ['src/new.js']);
  assert.deepEqual(names(audit.categories.pre_existing), ['README.md']);
  assert.deepEqual(names(audit.categories.test), ['test/foo.test.js']);
  assert.deepEqual(names(audit.categories.workflow), ['akrs/state.json']);
  assert.deepEqual(names(audit.categories.evidence), ['akrs/verifications/P6/evidence/a.png']);
  assert.deepEqual(names(audit.categories.agent_adapter), ['AGENTS.md']);
  assert.deepEqual(names(audit.categories.workflow_draft), ['akrs/drafts/x.json']);
  assert.deepEqual(names(audit.categories.workflow_cache), ['akrs/.cache/c', 'akrs/.ops/o']);
  const states = Object.fromEntries(audit.categories.undeclared.map(({ path, staged, unstaged, untracked }) => [path, { staged, unstaged, untracked }]));
  assert.deepEqual(states['src/extra.js'], { staged: false, unstaged: false, untracked: true });
  assert.deepEqual(states['src/other.js'], { staged: true, unstaged: false, untracked: false });
  assert.deepEqual(states['src/secret.js'], { staged: false, unstaged: true, untracked: false });
  assertFindingsMatchCatalog(first);
  const reasons = first.findings.map(({ code, detail }) => `${code}:${detail.reason}`).sort();
  assert.deepEqual(reasons, ['AKRS-G001:forbidden', 'AKRS-G001:undeclared', 'AKRS-G001:undeclared', 'AKRS-G002:declared_absent']);
  const second = await auditPacket(repo, ['--pre-existing', 'README.md']);
  assert.deepEqual(second.data, first.data, 'the same repository state gives the same report');
});

test('draft, cache and adapter changes alone never count as undeclared product changes', async (t) => {
  const repo = await auditWorld(t);
  await put(repo, 'src/new.js', 'created\n');
  await put(repo, 'src/own.js', 'changed\n');
  await put(repo, 'akrs/drafts/x.json', '{}\n');
  await put(repo, 'akrs/.ops/o', 'o\n');
  await put(repo, 'AGENTS.md', 'adapter\n');
  const packet = await auditPacket(repo);
  assert.equal(packet.status, 'ok');
  assert.equal(packet.data.audit.status, 'clean');
  assert.deepEqual(packet.findings, []);
});

test('audit is report-only: no byte of the working tree changes and git status stays the same', async (t) => {
  const repo = await auditWorld(t);
  await dirty(repo);
  const before = await treeDigest(repo);
  const status = git(repo, 'status', '--porcelain=v1');
  await auditPacket(repo);
  assert.equal(await treeDigest(repo), before);
  assert.equal(git(repo, 'status', '--porcelain=v1'), status);
});

test('unknown Road, missing --git/--road and a bad Road ID are usage errors (exit 2)', async (t) => {
  const repo = await auditWorld(t);
  assert.equal((await runCommand(repo, ['audit', '--git', '--road', 'R-NOPE', '--json'])).exitCode, 2);
  assert.equal((await runCommand(repo, ['audit', '--road', 'R-A', '--json'])).exitCode, 2);
  assert.equal((await runCommand(repo, ['audit', '--git', '--json'])).exitCode, 2);
  assert.equal((await runCommand(repo, ['audit', '--git', '--road', 'not an id', '--json'])).exitCode, 2);
});

test('parseStatusZ: porcelain -z entries, renames, prefix stripping and states are exact', () => {
  const raw = Buffer.from(['M  staged.js', ' M both.js', 'MM both2.js', '?? new file.js', 'R  renamed.js', 'old.js', 'D  gone.js', ' M outside/skip.js', ''].join('\0'));
  const entries = parseStatusZ(raw, { prefix: '' });
  assert.deepEqual(entries.map(({ path }) => path), ['both.js', 'both2.js', 'gone.js', 'new file.js', 'outside/skip.js', 'renamed.js', 'staged.js'], 'sorted by path');
  const renamed = entries.find(({ path }) => path === 'renamed.js');
  assert.equal(renamed.renamed_from, 'old.js');
  assert.deepEqual(entries.find(({ path }) => path === 'both2.js'), { path: 'both2.js', staged: true, unstaged: true, untracked: false });
  const inSub = parseStatusZ(Buffer.from(['M  sub/a.js', ' M other/b.js', ''].join('\0')), { prefix: 'sub/' });
  assert.deepEqual(inSub.map(({ path }) => path), ['a.js']);
});

test('classifyChanges: case mismatches stay visible and paths are matched as declared', () => {
  const road = { writes: [{ path: 'src/Case.js', class: 'file', action: 'modify' }, { path: 'lib/**', class: 'glob', action: 'modify' }], forbidden: [] };
  const entry = (path) => ({ path, staged: false, unstaged: true, untracked: false });
  const result = classifyChanges({ changes: [entry('src/case.js'), entry('src/Case.js'), entry('lib/a/b.js')], road, workflowRelative: 'akrs', preExisting: [] });
  assert.deepEqual(names(result.categories.declared), ['lib/a/b.js', 'src/Case.js']);
  assert.deepEqual(result.categories.undeclared.map(({ path, case_mismatch: mismatch, declared_as: declaredAs }) => [path, mismatch, declaredAs]), [['src/case.js', true, 'src/Case.js']]);
});
