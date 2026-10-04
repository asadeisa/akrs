import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPosture } from '../../lib/store/git/index.js';
import { assertFindingsMatchCatalog } from '../road/support.js';
import { auditPacket, auditWorld, doctorPacket, dropGit, git, put, treeDigest } from './support.js';

test('tracked: a committed workflow is `tracked`, doctor is ok and names no problem', async (t) => {
  const repo = await auditWorld(t);
  const posture = await readPosture(repo.options);
  assert.equal(posture.posture, 'tracked');
  assert.equal(posture.git, true);
  assert.deepEqual(posture.ignored, []);
  assert.equal(posture.tracked.includes('akrs/roads/P6/R-A.json'), true);
  const packet = await doctorPacket(repo);
  assert.equal(packet.status, 'ok');
  assert.equal(packet.data.doctor.posture.posture, 'tracked');
});

test('new, not-yet-added workflow files do not make the posture ignored', async (t) => {
  const repo = await auditWorld(t);
  await put(repo, 'akrs/memory/new.md', 'new\n');
  const posture = await readPosture(repo.options);
  assert.equal(posture.posture, 'tracked');
  assert.deepEqual(posture.untracked, ['akrs/memory/new.md']);
});

test('ignored: nothing tracked and everything ignored; files are named; doctor warns with remediation; audit is skipped, never a pass', async (t) => {
  const repo = await auditWorld(t);
  git(repo, 'rm', '-r', '-q', '--cached', 'akrs');
  await put(repo, '.gitignore', 'akrs/\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-q', '-m', 'ignore akrs');
  const posture = await readPosture(repo.options);
  assert.equal(posture.posture, 'ignored');
  assert.equal(posture.ignored.includes('akrs/roads/P6/R-A.json'), true);
  assert.deepEqual(posture.tracked, []);
  const doctor = await doctorPacket(repo);
  assert.equal(doctor.status, 'warning');
  const finding = doctor.findings.find(({ code }) => code === 'AKRS-G003');
  assert.equal(finding.detail.posture, 'ignored');
  assert.match(finding.message, /akrs/);
  assertFindingsMatchCatalog(doctor);
  const audit = await auditPacket(repo);
  assert.equal(audit.status, 'warning');
  assert.equal(audit.data.audit.status, 'skipped');
  assert.equal(audit.data.audit.reason, 'posture_ignored');
  assert.notEqual(audit.data.audit.status, 'pass');
});

test('mixed: some workflow files tracked, some ignored; both sets are named', async (t) => {
  const repo = await auditWorld(t);
  await put(repo, '.gitignore', 'akrs/memory/\n');
  await put(repo, 'akrs/memory/ignored.md', 'i\n');
  const posture = await readPosture(repo.options);
  assert.equal(posture.posture, 'mixed');
  assert.deepEqual(posture.ignored, ['akrs/memory/ignored.md']);
  assert.equal(posture.tracked.length > 0, true);
  const doctor = await doctorPacket(repo);
  assert.equal(doctor.findings.find(({ code }) => code === 'AKRS-G003').detail.posture, 'mixed');
  assertFindingsMatchCatalog(doctor);
});

test('not a git repository: posture not_git, doctor warns, audit is skipped, nothing fails (F1 root contract)', async (t) => {
  const repo = await auditWorld(t);
  await dropGit(repo);
  const posture = await readPosture(repo.options);
  assert.equal(posture.posture, 'not_git');
  assert.equal(posture.git, false);
  const doctor = await doctorPacket(repo);
  assert.equal(doctor.status, 'warning');
  assert.equal(doctor.findings.find(({ code }) => code === 'AKRS-G003').detail.posture, 'not_git');
  const audit = await auditPacket(repo);
  assert.equal(audit.data.audit.status, 'skipped');
  assert.equal(audit.data.audit.reason, 'not_git');
});

test('posture and doctor are report-only: no byte of the working tree changes', async (t) => {
  const repo = await auditWorld(t);
  await put(repo, 'src/own.js', 'changed\n');
  const before = await treeDigest(repo);
  const status = git(repo, 'status', '--porcelain=v1');
  await readPosture(repo.options);
  await doctorPacket(repo);
  assert.equal(await treeDigest(repo), before);
  assert.equal(git(repo, 'status', '--porcelain=v1'), status);
});
