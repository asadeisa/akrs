// P1-W05: a target (or operation set) that is invalid is discovered BEFORE prepare. It is a usage error: no
// transaction directory, no journal record, nothing written, and the lock is released.
import assert from 'node:assert/strict';
import { stat, symlink } from 'node:fs/promises';
import { test } from 'node:test';
import { readLockOwner } from '../../lib/store/lock/index.js';
import {
  SCENARIOS,
  SCENARIO_REQUEST_ID,
  createTxWorkflow,
  journalStates,
  runScenario,
  treeDigest,
  txRoot,
} from './support.js';

const exists = async (path) => stat(path).then(() => true, () => false);
const op = (type, path, extra = {}) => ({ type, path, ...extra });

// [label, operations, reason fragment]
const CASES = [
  ['traversal', [op('create', '../outside.md', { content: 'x' })], 'normalized'],
  ['traversal in the middle', [op('create', 'memory/../../escape.md', { content: 'x' })], 'normalized'],
  ['absolute path', [op('create', '/tmp/escape.md', { content: 'x' })], 'absolute'],
  ['drive path', [op('create', 'C:/escape.md', { content: 'x' })], 'absolute'],
  ['backslash', [op('create', 'memory\\x.md', { content: 'x' })], 'backslash'],
  ['NUL byte', [op('create', 'memory/a\0b.md', { content: 'x' })], 'NUL'],
  ['alternate data stream', [op('create', 'memory/a.md:stream', { content: 'x' })], 'stream'],
  ['glob', [op('create', 'memory/*.md', { content: 'x' })], 'glob'],
  ['empty path', [op('create', '', { content: 'x' })], 'non-empty'],
  ['.ops create', [op('create', '.ops/journal/ops/x.jsonl', { content: 'x' })], 'reserved'],
  ['.ops itself', [op('replace', '.ops', { content: 'x' })], 'reserved'],
  ['.ops lock', [op('replace', '.ops/lock/owner.json', { content: 'x' })], 'reserved'],
  ['.ops tx', [op('create', '.ops/tx/x/manifest.json', { content: 'x' })], 'reserved'],
  ['.cache', [op('replace', '.cache/view/index.html', { content: 'x' })], 'reserved'],
  ['draft create', [op('create', 'drafts/new.json', { content: '{}' })], 'draft'],
  ['draft replace', [op('replace', 'drafts/road-R3.json', { content: '{}' })], 'draft'],
  ['draft append', [op('append', 'drafts/road-R3.json', { content: '\n' })], 'draft'],
  ['evidence', [op('replace', 'verifications/P1/evidence/run-1/run.json', { content: '{}' })], 'evidence'],
  ['archived ledger create', [op('create', 'log/LOG-0001.md', { content: 'x' })], 'archived ledger'],
  ['archived ledger replace', [op('replace', 'log/LOG-0002.md', { content: 'x' })], 'archived ledger'],
  ['move onto .ops', [op('move', 'roads/R9.json', { to: '.ops/x.json' })], 'reserved'],
  ['move out of the workflow', [op('move', 'roads/R9.json', { to: '../R9.json' })], 'normalized'],
  ['duplicate path', [op('create', 'memory/a.md', { content: 'x' }), op('create', 'memory/a.md', { content: 'y' })], 'more than once'],
  ['move destination reused', [
    op('move', 'roads/R9.json', { to: 'roads/archive/R9.json' }), op('create', 'roads/archive/R9.json', { content: 'x' }),
  ], 'more than once'],
  ['move source reused', [op('move', 'roads/R9.json', { to: 'roads/a.json' }), op('replace', 'roads/R9.json', { content: 'x' })], 'more than once'],
  ['parent is a file', [op('create', 'memory/decisions.md/child.md', { content: 'x' })], 'not a directory'],
  ['create over an existing file', [op('create', 'memory/decisions.md', { content: 'x' })], 'already exists'],
  ['replace a missing file', [op('replace', 'memory/missing.md', { content: 'x' })], 'does not exist'],
  ['append to a missing file', [op('append', 'log/0009.jsonl', { content: 'x\n' })], 'does not exist'],
  ['delete a missing file', [op('delete', 'memory/missing.md')], 'does not exist'],
  ['move a missing source', [op('move', 'roads/missing.json', { to: 'roads/x.json' })], 'does not exist'],
  ['move onto an existing file', [op('move', 'roads/R9.json', { to: 'roads/R2.json' })], 'already exists'],
  ['move needs a destination', [op('move', 'roads/R9.json')], 'destination'],
  ['move onto itself', [op('move', 'roads/R9.json', { to: 'roads/R9.json' })], 'itself'],
  ['move with content', [op('move', 'roads/R9.json', { to: 'roads/x.json', content: 'x' })], 'content'],
  ['destination on a non-move', [op('create', 'memory/a.md', { content: 'x', to: 'memory/b.md' })], 'destination'],
  ['delete with content', [op('delete', 'memory/decisions.md', { content: 'x' })], 'content'],
  ['unknown type', [op('rename', 'memory/a.md', { content: 'x' })], 'operation type'],
  ['missing content', [op('create', 'memory/a.md')], 'content'],
  ['content of the wrong type', [op('create', 'memory/a.md', { content: 42 })], 'content'],
  ['empty append', [op('append', 'log/0001.jsonl', { content: '' })], 'empty'],
  ['directory target', [op('replace', 'memory', { content: 'x' })], 'directory'],
  ['directory delete', [op('delete', 'roads')], 'directory'],
  ['operation that is not an object', ['create'], 'object'],
];

async function assertRejectedBeforePrepare(workflow, operations, reason, label) {
  const tree = await treeDigest(workflow);
  const { result, calls } = await runScenario(workflow, SCENARIOS.create, {
    render: () => ({ operations, packet: { data: { kind: 'x' } } }),
  });
  assert.equal(calls.render, 1, label);
  assert.equal(result.outcome, 'rejected', label);
  assert.equal(result.packet.status, 'error', label);
  assert.equal(result.packet.data.kind, 'usage', label);
  const [finding] = result.packet.findings;
  assert.equal(finding.code, 'AKRS-C015', label);
  assert.match(finding.message + finding.detail.reason, new RegExp(reason, 'i'), `${label}: ${JSON.stringify(finding)}`);
  assert.deepEqual(Object.keys(finding.detail).sort(), ['path', 'reason'], label);
  assert.equal(await treeDigest(workflow), tree, `${label}: nothing written`);
  assert.equal(await exists(txRoot(workflow)), false, `${label}: no transaction directory was created`);
  assert.equal(await exists(workflow.path('akrs', '.ops', 'journal', 'ops')), false, `${label}: no journal record`);
  assert.equal(await journalStates(workflow, SCENARIO_REQUEST_ID), null, `${label}: no request ID consumed`);
  assert.equal((await readLockOwner(workflow.options)).status, 'absent', `${label}: lock released`);
}

test('an invalid target or operation set is a usage error before prepare', async (t) => {
  const workflow = await createTxWorkflow(t);
  for (const [label, operations, reason] of CASES) {
    await assertRejectedBeforePrepare(workflow, operations, reason, label);
  }
});

test('one bad operation rejects the whole set even when the others are fine', async (t) => {
  const workflow = await createTxWorkflow(t);
  await assertRejectedBeforePrepare(workflow, [
    op('create', 'memory/fine.md', { content: 'ok' }),
    op('replace', 'roads/R2.json', { content: '{}' }),
    op('create', '.ops/bad.json', { content: 'x' }),
  ], 'reserved', 'mixed set');
});

test('a symbolic link that leaves the workflow root is refused, as is a link target', async (t) => {
  const workflow = await createTxWorkflow(t);
  try {
    await symlink(workflow.path('src'), workflow.path('akrs', 'linked'), 'dir');
    await symlink(workflow.path('akrs', 'memory', 'decisions.md'), workflow.path('akrs', 'memory', 'alias.md'), 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN'].includes(error?.code)) {
      t.skip('symbolic links are not available here');
      return;
    }
    throw error;
  }
  // `src` is inside the repository but outside the workflow root: repository containment alone would accept it
  await assertRejectedBeforePrepare(workflow, [op('create', 'linked/new.js', { content: 'x' })], 'outside|symbolic', 'link out of the workflow');
  await assertRejectedBeforePrepare(workflow, [op('replace', 'linked/own.js', { content: 'x' })], 'outside|symbolic', 'replace through a link');
  await assertRejectedBeforePrepare(workflow, [op('replace', 'memory/alias.md', { content: 'x' })], 'symbolic', 'link as a target');
  await assertRejectedBeforePrepare(workflow, [op('delete', 'memory/alias.md')], 'symbolic', 'delete a link');
});

test('a draft may be deleted on success (A1), and only deleted', async (t) => {
  const workflow = await createTxWorkflow(t);
  const { result } = await runScenario(workflow, SCENARIOS.create, {
    render: () => ({
      operations: [
        op('create', 'roads/R3.json', { content: '{"id":"R3"}\n' }),
        op('delete', 'drafts/road-R3.json'),
      ],
      packet: { data: { kind: 'x' } },
    }),
  });
  assert.equal(result.outcome, 'committed');
  assert.equal(await exists(workflow.path('akrs', 'drafts', 'road-R3.json')), false);
  assert.deepEqual(result.packet.changed, ['drafts/road-R3.json', 'roads/R3.json']);
});
