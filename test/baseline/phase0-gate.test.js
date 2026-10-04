import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCli } from '../helpers/process.js';
import { createTempRepository } from '../helpers/temp-repository.js';

const testRoot = fileURLToPath(new URL('../', import.meta.url));
const legacyRoot = fileURLToPath(new URL('../fixtures/legacy/', import.meta.url));
const ledgerUrl = new URL('./bug-disposition.json', import.meta.url);

// Phase-0 gate item 1: every active Phase-0 defect is pinned to a named regression test.
const PHASE_0_REGRESSIONS = Object.freeze({
  B1: [['validation/coverage.test.js', 'required checks with zero readable inputs are skipped, never passed']],
  B3: [['cli/adapter.test.js', 'human finding output is written to stderr, not stdout']],
  B4: [
    ['cli/process.test.js', 'bare CLI and --help render manifest-backed help with exit 0'],
    ['cli/process.test.js', '--version reports CLI, schema, and doctrine versions with exit 0'],
  ],
  B5: [['cli/process.test.js', 'unknown commands, flags, and abbreviated flags exit 2']],
  B6: [['cli/adapter.test.js', 'missing option values fail before context resolution or core invocation']],
  B7: [
    ['cli/adapter.test.js', 'workflow absence maps to exit 3 and a clean JSON packet'],
    ['cli/adapter.test.js', 'failed, blocked, and finding-bearing packets map to exit 1'],
  ],
  B8: [['mutations/mutation-safety.test.js', 'B8 an unchanged CRLF document remains byte-identical under explicit newline policy']],
  B9: [['mutations/mutation-safety.test.js', 'B9 archived ledgers can never enter a writable target set']],
  B10: [['mutations/mutation-safety.test.js', 'B10 a table field mutation changes only the selected status cell']],
  B11: [['mutations/mutation-safety.test.js', 'B11 owner selection is exact and dry-run changes no byte']],
  B12: [['paths/path-service.test.js', 'B12 every repository and workflow resolver shares one canonical repository root']],
  B13: [
    ['paths/path-service.test.js', 'B13 restricted paths reject lexical escape and Windows-specific ambiguous forms on every OS'],
    ['paths/path-service.test.js', 'B13 existing symlinks and nearest existing ancestors cannot escape the repository'],
  ],
  B14: [
    ['install/install-commands.test.js', 'B14 postinstall installs, preserves local edits, and stays deterministic'],
    ['install/doctrine-install.test.js', 'B14 sync follows ownership: update, remove, recreate, preserve, never touch user files'],
  ],
  B15: [['install/doctrine-install.test.js', 'B15 forced init replaces the exact generated target; ghosts and local edits do not survive']],
  B16: [['validation/identity-graph.test.js', 'duplicate nested Road identities fail before a lossy lookup map exists']],
  B19: [['validation/identity-graph.test.js', 'references and cycles inspect every Road status while readiness is separate']],
  B22: [['validation/identity-graph.test.js', 'finding bytes are independent of filesystem creation order']],
  B23: [['paths/path-service.test.js', 'B23 case mismatches produce the same stable finding on case-sensitive and insensitive hosts']],
  B24: [
    ['contracts/packet-event.test.js', 'F3 rejects malformed IDs, timestamps, statuses, paths, and terminal identity bytes'],
    ['cli/process.test.js', '--json writes one parseable packet and no diagnostic bytes'],
  ],
});

const DEFERRED_PARSER_DEFECTS = Object.freeze(['B2', 'B17', 'B18', 'B20', 'B21']);

async function readLedger() {
  return JSON.parse(await readFile(ledgerUrl, 'utf8'));
}

test('Phase-0 gate: every active Phase-0 defect names an existing regression test', async () => {
  const ledger = await readLedger();
  const active = ledger.filter(({ status }) => status === 'active').map(({ bugId }) => bugId);
  assert.deepEqual(Object.keys(PHASE_0_REGRESSIONS), active);
  for (const [bugId, regressions] of Object.entries(PHASE_0_REGRESSIONS)) {
    assert.ok(regressions.length > 0, `${bugId} has no named regression test`);
    for (const [file, title] of regressions) {
      const source = await readFile(join(testRoot, file), 'utf8');
      assert.ok(source.includes(`test('${title}'`), `${bugId}: ${file} lacks test '${title}'`);
    }
  }
});

test('Phase-0 gate: retired parser defects close in P1-W13 with tombstone tests', async () => {
  const ledger = await readLedger();
  const retired = ledger.filter(({ status }) => status === 'retired');
  assert.deepEqual(retired.map(({ bugId }) => bugId), DEFERRED_PARSER_DEFECTS);
  for (const entry of retired) assert.equal(entry.finalClosurePacket, 'P1-W13', entry.bugId);
});

// ---- P1-W13 tombstones: the v1 parser paths of B2/B17/B18/B20/B21 are deleted, not merely unused ------------------
const productionRoot = fileURLToPath(new URL('../../', import.meta.url));

async function productionSources() {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.js')) files.push(path);
    }
  }
  await walk(join(productionRoot, 'lib'));
  await walk(join(productionRoot, 'bin'));
  // the permanent finding catalog keeps the retired legacy codes (and their wording): codes are never deleted
  return Promise.all(files.filter((path) => !path.endsWith('catalog.js')).map(async (path) => ({ path, text: await readFile(path, 'utf8') })));
}

async function validateFixture(t, fixture) {
  const repository = await createTempRepository(t, { prefix: 'akrs-tombstone-', fixture: join(legacyRoot, fixture) });
  const result = await runCli(['validate', '--root', repository.root, '--workflow-root', repository.path('akrs'), '--json'], { cwd: repository.root });
  return { repository, packet: JSON.parse(result.stdout), exitCode: result.exitCode };
}

test('tombstone: the legacy Road parser module is gone from the tree and the package', async () => {
  await assert.rejects(() => access(join(productionRoot, 'lib', 'validation', 'legacy-roads.js')), { code: 'ENOENT' });
  for (const { path, text } of await productionSources()) {
    assert.equal(/legacy-roads|loadLegacyRoads|legacyExpectedFiles|legacyDependencyIds/.test(text), false, path);
  }
});

test('B2 tombstone: prose bullets under "Expected files" never become paths; the Markdown Road is reported as a legacy form', async (t) => {
  for (const { path, text } of await productionSources()) assert.equal(/expected files/i.test(text), false, path);
  const { packet, exitCode } = await validateFixture(t, 'road-prose-bullets');
  assert.equal(exitCode, 1);
  assert.equal(packet.findings.some(({ code, file }) => code === 'AKRS-R019' && file.endsWith('.md')), true);
  assert.equal(JSON.stringify(packet.findings).includes('"Raw"'), false);
  assert.equal(packet.data.checks.find(({ check }) => check === 'legacy-forms').status, 'failed');
});

test('B17 tombstone: nothing scans STATE prose for an override; a v1 STATE.md is never read as state', async (t) => {
  for (const { path, text } of await productionSources()) assert.equal(/overridden\s*\(/.test(text), false, path);
  const { packet } = await validateFixture(t, 'state-override-trap');
  assert.equal(packet.data.checks.find(({ check }) => check === 'state').status, 'not_applicable');
  assert.equal(JSON.stringify(packet.findings).toLowerCase().includes('override'), false);
});

test('B18 tombstone: no substring field check exists; state is the closed state.json schema, never STATE.md prose', async (t) => {
  const { validateState } = await import('../../lib/schemas/state.js');
  assert.equal(validateState({ schema: 'akrs.state/v1', Model: 'x', Rollback: 'y', Done: 'z', Next: 'w' }, { form: 'input' }).ok, false);
  const { packet } = await validateFixture(t, 'state-substring-trap');
  assert.equal(packet.data.checks.find(({ check }) => check === 'state').status, 'not_applicable');
});

test('B20 tombstone: there is no SOT-INDEX path extraction at all (so no hyphen stripping)', async () => {
  for (const { path, text } of await productionSources()) assert.equal(/SOT-INDEX/i.test(text), false, path);
});

test('B21 tombstone: a Markdown "Deps: R1 (blocked by X)" yields no phantom dependency IDs; the Road is a legacy form only', async (t) => {
  for (const { path, text } of await productionSources()) assert.equal(text.includes('split(/[,\\s]+/)'), false, path);
  const repository = await createTempRepository(t, { prefix: 'akrs-b21-' });
  await repository.write('akrs/roads/R2.md', '# Road R2\n\nStatus: QUEUED\nDeps: R1 (blocked by X)\n');
  const result = await runCli(['validate', '--root', repository.root, '--workflow-root', repository.path('akrs'), '--json'], { cwd: repository.root });
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.findings.some(({ code }) => code === 'AKRS-R019'), true);
  assert.equal(packet.findings.some(({ code }) => code === 'AKRS-R005'), false, 'no phantom dependency IDs from prose');
  assert.equal(JSON.stringify(packet.findings).includes('(blocked'), false);
});
