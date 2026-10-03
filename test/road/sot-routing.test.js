// SOT routing (12-v2 section 5.4): `road new` keeps declared read windows exactly (order, lines, why) and never
// copies a fact body into the Road; windows that cannot be satisfied are refused.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRoad, projectReadWindows, readRoad } from '../../lib/store/roads/index.js';
import { createTempRepository } from '../helpers/temp-repository.js';
import { assertFindingsMatchCatalog, authoringOptions, codesOf, pointersOf, treeDigest } from './support.js';

const fixtureRoot = fileURLToPath(new URL('../fixtures/sot-routing/', import.meta.url));
const expected = JSON.parse(await readFile(`${fixtureRoot}expected.json`, 'utf8'));
const roadDocument = async (name) => JSON.parse(await readFile(`${fixtureRoot}roads/${name}`, 'utf8'));

async function repoFromFixture(t) {
  const repository = await createTempRepository(t, { fixture: `${fixtureRoot}repo`, prefix: 'akrs-sot-' });
  return {
    ...repository,
    options: { repositoryRoot: repository.root, workflowRoot: repository.path('akrs') },
    read: (path) => readFile(repository.path(path), 'utf8'),
    digest: () => treeDigest(repository),
  };
}

const submit = (repo, document) => createRoad({ ...authoringOptions(repo), channel: { stdin: Buffer.from(JSON.stringify(document)) } });

test('SOT windows are preserved in order with their line ranges and why, and the stored Road copies no fact body', async (t) => {
  const repo = await repoFromFixture(t);
  const document = await roadDocument(expected.valid.file);
  const result = await submit(repo, document);
  assert.equal(result.outcome, 'committed');
  const stored = await readRoad({ ...repo.options, id: document.id });
  assert.deepEqual(stored.road.reads, document.reads, 'order, lines and why exactly as authored (not sorted)');
  assert.deepEqual(stored.road.reads.map(({ path, lines }) => `${path}:${lines?.join('-') ?? 'all'}`), [
    'SOT/10-refunds.md:3-5', 'SOT/09-use-cases.md:4-8', 'SOT/09-use-cases.md:1-3', 'app/config/payment-status.ts:4-9', 'akrs/memory/ui.md:all',
  ]);
  const bytes = await repo.read(`akrs/roads/P6/${document.id}.json`);
  for (const sentinel of expected.valid.sentinels) assert.equal(bytes.includes(sentinel), false, `${sentinel} was not copied`);
  for (const source of ['SOT/09-use-cases.md', 'SOT/10-refunds.md']) {
    const lines = (await repo.read(source)).split('\n').filter((line) => line.length > 20 && !line.startsWith('#'));
    for (const line of lines) assert.equal(bytes.includes(line), false, `a source line was copied: ${line}`);
  }
});

test('the projection returns the windows in declared order with resolution, and the body only on request', async (t) => {
  const repo = await repoFromFixture(t);
  const document = await roadDocument(expected.valid.file);
  const windows = await projectReadWindows({ ...repo.options, road: document });
  assert.deepEqual(windows.map(({ path, lines, why }) => ({ path, lines, why })), document.reads);
  assert.deepEqual(windows.map(({ status }) => status), ['ok', 'ok', 'ok', 'ok', 'missing']);
  assert.deepEqual(windows.map(({ line_count: count }) => count), [12, 30, 30, 20, null]);
  assert.equal(JSON.stringify(windows).includes('FACT-SENTINEL'), false);
  const withText = await projectReadWindows({ ...repo.options, road: document, includeText: true });
  assert.equal(withText[1].text.includes('FACT-SENTINEL-PAID-STATE'), true, 'the canonical owner is read from SOT, not from the Road');
  assert.equal(withText[0].text.includes('FACT-SENTINEL-REFUND-REVERSES'), true);
});

for (const { file, pointer, reason } of expected.invalid) {
  test(`${file}: refused with reason ${reason} at ${pointer}, nothing written`, async (t) => {
    const repo = await repoFromFixture(t);
    const before = await repo.digest();
    const result = await submit(repo, await roadDocument(file));
    assert.equal(result.outcome, 'rejected');
    assert.deepEqual(codesOf(result.packet), ['AKRS-R012']);
    const finding = result.packet.findings[0];
    assert.equal(finding.detail.reason, reason);
    assert.equal(finding.detail.pointer.startsWith(pointer), true);
    assertFindingsMatchCatalog(result.packet);
    assert.deepEqual(pointersOf(result.packet).length, 1);
    assert.equal(await repo.digest(), before);
  });
}
