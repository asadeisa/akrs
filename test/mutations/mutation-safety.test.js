import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyChangeSet,
  createChangeSet,
  prepareTextChange,
  readTextDocument,
  replaceMarkdownTableCell,
  selectOwnedTargets,
} from '../../lib/store/mutations.js';
import { createPathService } from '../../lib/store/path-service.js';
import { byteTreeHash } from '../helpers/byte-tree.js';
import { readBase64Fixture } from '../helpers/fixtures.js';
import { runCli } from '../helpers/process.js';
import { createTempRepository } from '../helpers/temp-repository.js';

const legacyFixtures = new URL('../fixtures/legacy/', import.meta.url);

async function serviceFor(temporary) {
  return createPathService({
    repositoryRoot: temporary.root,
    workflowRoot: temporary.path('akrs'),
  });
}

test('B8 an unchanged CRLF document remains byte-identical under explicit newline policy', async (t) => {
  const temporary = await createTempRepository(t, { prefix: 'akrs-crlf-safe-' });
  const bytes = await readBase64Fixture(new URL('log-crlf/akrs/LOG.md.base64', legacyFixtures));
  await temporary.write('akrs/LOG.md', bytes);
  const paths = await serviceFor(temporary);
  const before = await readFile(temporary.path('akrs/LOG.md'));
  const document = await readTextDocument(paths, 'akrs/LOG.md');

  assert.equal(document.newline_policy, 'crlf');
  const change = await prepareTextChange(paths, document, document.text, {
    newlinePolicy: document.newline_policy,
  });
  const changeSet = createChangeSet(paths, [change]);
  assert.equal(changeSet.changes.length, 0);
  await applyChangeSet(changeSet, { dryRun: false });
  assert.deepEqual(await readFile(temporary.path('akrs/LOG.md')), before);
});

test('B9 archived ledgers can never enter a writable target set', async (t) => {
  const fixture = fileURLToPath(new URL('log-archived/', legacyFixtures));
  const temporary = await createTempRepository(t, {
    prefix: 'akrs-archive-safe-',
    fixture,
  });
  const paths = await serviceFor(temporary);
  const document = await readTextDocument(paths, 'akrs/LOG-001.md');
  const change = await prepareTextChange(paths, document, `${document.text}\nchanged`, {
    newlinePolicy: document.newline_policy,
  });

  assert.throws(() => createChangeSet(paths, [change]), /archived ledger is read-only/);
});

test('B10 a table field mutation changes only the selected status cell', () => {
  const source = [
    '| Road | Note | Status |',
    '|---|---|---|',
    '| R1 | ACTIVE belongs to this note | QUEUED |',
    '| R2 | untouched | DONE |',
    '',
  ].join('\n');

  assert.equal(replaceMarkdownTableCell(source, {
    keyColumn: 'Road',
    key: 'R1',
    column: 'Status',
    value: 'DONE',
  }), [
    '| Road | Note | Status |',
    '|---|---|---|',
    '| R1 | ACTIVE belongs to this note | DONE |',
    '| R2 | untouched | DONE |',
    '',
  ].join('\n'));
});

test('B11 owner selection is exact and dry-run changes no byte', async (t) => {
  const temporary = await createTempRepository(t, { prefix: 'akrs-dry-run-' });
  await temporary.write('akrs/handoffs/P1.md', 'P1\n');
  await temporary.write('akrs/handoffs/P10.md', 'P10\n');
  const paths = await serviceFor(temporary);
  const selected = selectOwnedTargets([
    { owner_id: 'P10', path: 'akrs/handoffs/P10.md' },
    { owner_id: 'P1', path: 'akrs/handoffs/P1.md' },
  ], 'P1');
  assert.deepEqual(selected, [{ owner_id: 'P1', path: 'akrs/handoffs/P1.md' }]);

  const document = await readTextDocument(paths, selected[0].path);
  const change = await prepareTextChange(paths, document, 'changed\n', { newlinePolicy: 'lf' });
  const changeSet = createChangeSet(paths, [change]);
  const serialized = JSON.stringify(changeSet);
  assert.equal(serialized.includes(temporary.root), false);
  assert.deepEqual(JSON.parse(serialized), {
    schema_version: 'akrs.change-set/v1',
    changes: [{
      kind: 'write',
      path: 'akrs/handoffs/P1.md',
      before_snapshot: document.snapshot,
      after_snapshot: change.after_snapshot,
      newline_policy: 'lf',
    }],
  });
  const before = await byteTreeHash(temporary.root);
  const result = await applyChangeSet(changeSet, { dryRun: true });
  assert.equal(result.applied, false);
  assert.deepEqual(result.changes, changeSet.changes);
  assert.equal(await byteTreeHash(temporary.root), before);
  assert.equal(await readFile(temporary.path('akrs/handoffs/P10.md'), 'utf8'), 'P10\n');
});

test('legacy validate --fix and --clean fail before core and write nothing', async (t) => {
  const fixture = fileURLToPath(new URL('features-plan-prefix/', legacyFixtures));
  const temporary = await createTempRepository(t, {
    prefix: 'akrs-legacy-flags-',
    fixture,
  });

  for (const flag of ['--fix', '--clean']) {
    const before = await byteTreeHash(temporary.root);
    const result = await runCli([
      'validate',
      flag,
      '--root',
      temporary.root,
      '--workflow-root',
      temporary.path('akrs'),
      '--json',
    ], { cwd: temporary.root });
    assert.equal(result.exitCode, 2, flag);
    assert.equal(result.stderr, '', flag);
    assert.equal(JSON.parse(result.stdout).findings[0].code, 'AKRS-C001', flag);
    assert.equal(await byteTreeHash(temporary.root), before, flag);
  }
});
