import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPathService } from '../../lib/store/path-service.js';
import { loadLegacyRoads } from '../../lib/validation/legacy-roads.js';

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

test('Phase-0 gate: retired parser defects defer to P1-W13 with a baseline reproduction', async () => {
  const ledger = await readLedger();
  const retired = ledger.filter(({ status }) => status === 'retired');
  assert.deepEqual(retired.map(({ bugId }) => bugId), DEFERRED_PARSER_DEFECTS);
  for (const entry of retired) assert.equal(entry.finalClosurePacket, 'P1-W13', entry.bugId);
});

async function legacyRoads(fixture) {
  const repositoryRoot = join(legacyRoot, fixture);
  const pathService = await createPathService({
    repositoryRoot,
    workflowRoot: join(repositoryRoot, 'akrs'),
  });
  return loadLegacyRoads({ pathService });
}

test('B2 baseline: legacy expected-files extraction still turns prose bullets into fake paths', async () => {
  const [road] = await legacyRoads('road-prose-bullets');
  assert.deepEqual(road.expected, ['Raw', 'The', 'AKRS']);
});

test('B17 baseline: the v1 override predicate fires on unrelated prose naming the Road', async () => {
  const state = await readFile(join(legacyRoot, 'state-override-trap', 'akrs', 'STATE.md'), 'utf8');
  // Verbatim v1.3.1 predicate (bin/akrs.js:258 at 674ce97), kept only as a reproduction.
  const overridden = (id) => /override/i.test(state)
    && new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(state);
  assert.equal(overridden('R2'), true);
});

test('B18 baseline: v1 substring STATE field checks accept unrelated words', async () => {
  const state = await readFile(join(legacyRoot, 'state-substring-trap', 'akrs', 'STATE.md'), 'utf8');
  // Verbatim v1.3.1 field check (bin/akrs.js:311 at 674ce97), kept only as a reproduction.
  const present = (field) => new RegExp(field.replace(' ', '\\s*'), 'i').test(state);
  assert.equal(['Mode', 'Done', 'Next'].every(present), true);
  assert.equal(/^\s*-\s*Mode:/im.test(state), false);
});

test('B20 baseline: the v1 SOT-INDEX source extraction strips hyphens from paths', () => {
  // Verbatim v1.3.1 extraction (bin/akrs.js:358 at 674ce97), kept only as a reproduction.
  const extract = (line) => line.split('·')[0].replace(/[`*\-]/g, '').trim();
  assert.equal(extract('- `src/use-auth.ts` · auth hook'), 'src/useauth.ts');
});

test('B21 baseline: legacy dependency extraction still yields phantom IDs from prose', async (t) => {
  const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'akrs-b21-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'akrs', 'roads'), { recursive: true });
  await writeFile(join(root, 'akrs', 'roads', 'R2.md'), '# Road R2\n\nStatus: QUEUED\nDeps: R1 (blocked by X)\n');
  const pathService = await createPathService({ repositoryRoot: root, workflowRoot: join(root, 'akrs') });
  const [road] = await loadLegacyRoads({ pathService });
  assert.deepEqual(road.deps, ['R1', '(blocked', 'by', 'X)']);
});
