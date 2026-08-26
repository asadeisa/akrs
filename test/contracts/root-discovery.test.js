import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import {
  ROOT_OVERRIDE_FLAGS,
  ROOT_DISCOVERY_POLICY,
  discoverRoots,
  normalizeAbsolutePath,
  validateWorkflowPath,
} from '../../lib/core/roots.js';
import { createTempRepository } from '../helpers/temp-repository.js';

test('F1 discovers a git repository ancestor and its default workflow root', async (t) => {
  const temporary = await createTempRepository(t, { prefix: 'akrs-roots-git-' });
  await temporary.write('.git/HEAD', 'ref: refs/heads/test\n');
  const cwd = temporary.path('packages', 'tool');
  await mkdir(cwd, { recursive: true });

  assert.deepEqual(discoverRoots({ cwd }), {
    repository_root: normalizeAbsolutePath(temporary.root),
    workflow_root: normalizeAbsolutePath(temporary.path('akrs')),
    repository_source: 'git',
    workflow_source: 'default',
  });
});

test('F1 explicit overrides resolve from cwd and win over discovery', async (t) => {
  const temporary = await createTempRepository(t, { prefix: 'akrs-roots-override-' });
  await temporary.write('.git/HEAD', 'ref: refs/heads/test\n');
  const cwd = temporary.path('nested');
  const repositoryRoot = temporary.path('nested', 'chosen-repository');
  const workflowRoot = temporary.path('nested', 'chosen-workflow');
  await mkdir(repositoryRoot, { recursive: true });
  await mkdir(workflowRoot, { recursive: true });

  assert.deepEqual(
    discoverRoots({ cwd, repositoryRoot: 'chosen-repository', workflowRoot: 'chosen-workflow' }),
    {
      repository_root: normalizeAbsolutePath(repositoryRoot),
      workflow_root: normalizeAbsolutePath(workflowRoot),
      repository_source: 'override',
      workflow_source: 'override',
    },
  );
});

test('F1 falls back deterministically in a non-git directory', async (t) => {
  const temporary = await createTempRepository(t, { prefix: 'akrs-roots-nongit-' });

  assert.deepEqual(discoverRoots({ cwd: temporary.root }), {
    repository_root: normalizeAbsolutePath(temporary.root),
    workflow_root: normalizeAbsolutePath(temporary.path('akrs')),
    repository_source: 'cwd',
    workflow_source: 'default',
  });
});

test('F1 recognizes an enclosing non-git akrs workflow', async (t) => {
  const temporary = await createTempRepository(t, { prefix: 'akrs-roots-workflow-' });
  const cwd = temporary.path('akrs', 'roads', 'nested');
  await mkdir(cwd, { recursive: true });

  assert.deepEqual(discoverRoots({ cwd }), {
    repository_root: normalizeAbsolutePath(temporary.root),
    workflow_root: normalizeAbsolutePath(temporary.path('akrs')),
    repository_source: 'workflow',
    workflow_source: 'discovered',
  });
});

test('F1 freezes the two explicit root flag spellings', () => {
  assert.deepEqual(ROOT_OVERRIDE_FLAGS, [
    { name: '--root', value_type: 'path', required: false, repeatable: false },
    { name: '--workflow-root', value_type: 'path', required: false, repeatable: false },
  ]);
  assert.deepEqual(ROOT_DISCOVERY_POLICY, {
    override_base: 'cwd',
    repository_precedence: ['override', 'git', 'enclosing_workflow', 'cwd'],
    workflow_precedence: ['override', 'enclosing_workflow', 'repository_default'],
    default_workflow_directory: 'akrs',
  });
});

test('workflow paths accept only normalized repository-relative slash form', () => {
  for (const value of ['akrs/state.json', 'SOT/03-architecture.md']) {
    assert.equal(validateWorkflowPath(value).ok, true, value);
  }

  for (const value of [
    'akrs\\state.json',
    '/akrs/state.json',
    'E:/project/akrs/state.json',
    '../akrs/state.json',
    'akrs/../state.json',
    './akrs/state.json',
    'akrs//state.json',
  ]) {
    assert.equal(validateWorkflowPath(value).ok, false, value);
  }
});

test('absolute roots normalize independently of the host operating system', () => {
  assert.equal(normalizeAbsolutePath('E:\\project\\akrs\\'), 'E:/project/akrs');
  assert.equal(normalizeAbsolutePath('/srv/project/akrs/'), '/srv/project/akrs');
  assert.equal(normalizeAbsolutePath('\\\\server\\share\\akrs\\'), '//server/share/akrs');
});
