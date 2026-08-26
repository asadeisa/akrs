import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readBase64Fixture } from '../helpers/fixtures.js';
import { assertNormalizedRepoPath, normalizeRepoPath } from '../helpers/paths.js';

const fixtureRoot = new URL('../fixtures/legacy/', import.meta.url);
const fixtureRootPath = fileURLToPath(fixtureRoot);

const expectedFixtures = [
  'cli-usage',
  'features-plan-prefix',
  'log-archived',
  'log-crlf',
  'log-duplicate-closure',
  'memory-unknown',
  'road-nested-plans',
  'road-prose-bullets',
  'road-table-expected-files',
  'sot-index-table',
  'state-override-trap',
  'state-substring-trap',
];

test('legacy fixture corpus is complete', async () => {
  const entries = await readdir(fixtureRoot, { withFileTypes: true });
  const fixtureNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(fixtureNames, expectedFixtures);
});

async function runtimeFiles(fixtureName) {
  const root = join(fixtureRootPath, fixtureName);
  const files = [];

  async function walk(directory, relativeDirectory = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = normalizeRepoPath(join(relativeDirectory, entry.name));
      if (entry.isDirectory()) await walk(join(directory, entry.name), relativePath);
      else if (relativePath !== 'provenance.json') files.push(relativePath);
    }
  }

  await walk(root);
  return files.sort();
}

async function readFixture(fixtureName, relativePath, encoding = 'utf8') {
  return readFile(join(fixtureRootPath, fixtureName, relativePath), encoding);
}

test('every fixture has complete, self-contained provenance', async () => {
  for (const fixtureName of expectedFixtures) {
    const provenance = JSON.parse(await readFixture(fixtureName, 'provenance.json'));
    assert.equal(provenance.fixture, fixtureName);
    assert.match(provenance.capturedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(provenance.evidenceMeasuredOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(provenance.bugIds.length > 0, true);
    assert.equal(provenance.sources.length > 0, true);
    assert.equal(provenance.runtimeFiles.length > 0, true);

    for (const bugId of provenance.bugIds) assert.match(bugId, /^B(?:[1-9]|1\d|2[0-6])$/);
    for (const source of provenance.sources) {
      assert.equal(typeof source.kind, 'string');
      assert.equal(typeof source.project, 'string');
      assertNormalizedRepoPath(source.path);
    }
    for (const relativePath of provenance.runtimeFiles) assertNormalizedRepoPath(relativePath);

    assert.deepEqual(await runtimeFiles(fixtureName), [...provenance.runtimeFiles].sort());
    for (const relativePath of provenance.runtimeFiles) {
      const bytes = await readFixture(fixtureName, relativePath, null);
      const text = bytes.toString('utf8').toLowerCase();
      assert.equal(text.includes('e:\\colleg'), false, `${fixtureName}/${relativePath} leaks its source path`);
      assert.equal(text.includes('e:/colleg'), false, `${fixtureName}/${relativePath} leaks its source path`);
    }
  }
});

test('byte-sensitive and structural baseline characteristics remain intact', async () => {
  const crlfBytes = await readBase64Fixture(
    new URL('log-crlf/akrs/LOG.md.base64', fixtureRoot),
  );
  const lineFeeds = [...crlfBytes].filter((byte) => byte === 0x0a).length;
  const crlfPairs = crlfBytes.reduce(
    (count, byte, index) => count + Number(byte === 0x0a && crlfBytes[index - 1] === 0x0d),
    0,
  );
  assert.equal(lineFeeds > 0, true);
  assert.equal(crlfPairs, lineFeeds);

  const tableRoad = await readFixture(
    'road-table-expected-files',
    'akrs/roads/R37-frontend-farmer-experience.md',
  );
  assert.match(tableRoad, /^\| Path \| Result \|$/m);

  const proseRoad = await readFixture('road-prose-bullets', 'akrs/roads/R-P7-5.md');
  assert.match(proseRoad, /^- Raw measurements/m);
  assert.match(proseRoad, /^- The existing/m);
  assert.match(proseRoad, /^- AKRS close-out/m);

  const nestedFiles = await runtimeFiles('road-nested-plans');
  assert.equal(nestedFiles.includes('akrs/roads/P1/R1.md'), true);
  assert.equal(nestedFiles.includes('akrs/roads/P2/R1.md'), true);

  const archivedLog = await readFixture('log-archived', 'akrs/LOG-001.md');
  const archivedRoad = await readFixture('log-archived', 'akrs/roads/R1.md');
  assert.match(archivedLog, /read-only; never rewritten/);
  assert.match(archivedLog, /\| R1 \| ACTIVE \|/);
  assert.match(archivedRoad, /^Status: DONE$/m);

  const duplicateLog = await readFixture('log-duplicate-closure', 'akrs/LOG.md');
  assert.equal(duplicateLog.match(/R-P6-9/g)?.length, 2);
  assert.equal(duplicateLog.match(/R-P6-14/g)?.length, 2);

  const stateTrap = await readFixture('state-substring-trap', 'akrs/STATE.md');
  assert.match(stateTrap, /^- Model:/m);
  assert.doesNotMatch(stateTrap, /^- Mode:/m);

  const featureIndex = await readFixture('features-plan-prefix', 'akrs/FEATURES.md');
  const p1Handoff = await readFixture('features-plan-prefix', 'akrs/handoffs/P1-handoff.md');
  assert.match(featureIndex, /\bP10\b/);
  assert.match(p1Handoff, /\bP1\b/);

  const overrideState = await readFixture('state-override-trap', 'akrs/STATE.md');
  assert.match(overrideState, /\bR2\b/);
  assert.match(overrideState, /\boverride\b/i);

  const unknownModel = await readFixture('memory-unknown', 'akrs/memory/model.md');
  const unknownDocs = await readFixture('memory-unknown', 'akrs/memory/docs-assets.md');
  assert.match(unknownModel, /\*\*Unknown\*\*/);
  assert.match(unknownDocs, /\| Unknown \|/);

  const aiIndex = await readFixture('sot-index-table', 'ai-farmer/akrs/SOT-INDEX.md');
  const medIndex = await readFixture('sot-index-table', 'medecation/akrs/SOT-INDEX.md');
  assert.match(aiIndex, /^\| Window \| Purpose \| Domain \|$/m);
  assert.match(medIndex, /^\| Source \| Section \| Answers \| Domain \|$/m);

  const cliObservations = JSON.parse(await readFixture('cli-usage', 'observations.json'));
  const validationFinding = cliObservations.find((entry) => entry.name === 'validation-finding');
  assert.equal(validationFinding.observedFindingsStream, 'stdout');
  assert.equal(validationFinding.observedOrdering, 'filesystem');
  assert.equal(validationFinding.observedSeverityEncoding, 'emoji-only');
});
