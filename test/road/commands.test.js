import assert from 'node:assert/strict';
import { readFile, readdir, symlink } from 'node:fs/promises';
import { test } from 'node:test';
import { ROAD_KEYS } from '../../lib/schemas/road.js';
import { buildTemplate, findMissingInputs } from '../../lib/schemas/templates.js';
import { validateMutationChanges, validateReadOnlyPacket } from '../../lib/schemas/packet.js';
import { commandSnapshot } from '../../lib/store/snapshots/index.js';
import { createRoad, readRoad } from '../../lib/store/roads/index.js';
import {
  assertFindingsMatchCatalog, authoringOptions, codesOf, createRepo, draftDocument, fakeProviders, pointersOf, roadInput,
  roadText, seedPlan, seedRoad, storedRoad, treeDigest,
} from './support.js';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const stdin = (document) => ({ stdin: Buffer.from(typeof document === 'string' ? document : JSON.stringify(document)) });
const submit = (repo, document, extra = {}) => createRoad({ ...authoringOptions(repo, extra), channel: stdin(document) });
const fromFile = (repo, inputPath, extra = {}) => createRoad({ ...authoringOptions(repo, extra), channel: { inputPath } });
// `.ops` is CLI housekeeping that no snapshot reads; `strict` also covers it (nothing at all was touched).
const everything = (repo) => treeDigest(repo);
const strict = (repo) => treeDigest(repo, { exclude: [] });
const fixture = async (group, name) => JSON.parse(await readFile(new URL(`../fixtures/${group}/${name}.json`, import.meta.url), 'utf8'));

async function listFiles(root, base = root) {
  const names = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) names.push(...await listFiles(path, base));
    else names.push(path.slice(base.length + 1));
  }
  return names.sort();
}

test('road new from stdin creates exactly one canonical Road file in the plan folder', async (t) => {
  const repo = await createRepo(t);
  const before = await listFiles(repo.root);
  const input = roadInput();
  const result = await submit(repo, input);
  assert.equal(result.outcome, 'committed');
  const { packet } = result;
  assert.equal(packet.status, 'ok');
  assert.equal(packet.command, 'road-new');
  assert.match(packet.request_id, ULID);
  assert.deepEqual(packet.changed, ['roads/P6/R-P6-1.json']);
  assert.deepEqual(packet.findings, []);
  assert.equal(await repo.read('akrs/roads/P6/R-P6-1.json'), roadText(storedRoad(input)));
  assert.deepEqual(data(packet).road, {
    id: 'R-P6-1', plan: 'P6', task: 'T-P6-1', status: 'QUEUED', path: 'akrs/roads/P6/R-P6-1.json', meta_state: 'declared',
  });
  const after = (await listFiles(repo.root)).filter((name) => !name.startsWith('akrs/.ops/'));
  assert.deepEqual(after, [...before, 'akrs/roads/P6/R-P6-1.json'].sort());
  assert.equal(validateMutationChanges(packet, ['roads/P6/R-P6-1.json']).ok, true);
  assert.notEqual(packet.snapshot.before, packet.snapshot.after);
});

const data = (packet) => packet.data;

test('a Road without a Plan is written flat; every field of every valid fixture round-trips without loss or invention', async (t) => {
  for (const name of ['full', 'minimal', 'unicode-text']) {
    const repo = await createRepo(t);
    const { status, meta, ...input } = await fixture('schemas/road/valid', name);
    for (const dep of input.deps) await seedRoad(repo, { id: dep });
    const result = await submit(repo, input);
    assert.equal(result.outcome, 'committed', name);
    const location = input.plan === null ? `roads/${input.id}.json` : `roads/${input.plan}/${input.id}.json`;
    assert.deepEqual(result.packet.changed, [location], name);
    const found = await readRoad({ ...repo.options, id: input.id });
    assert.equal(found.meta_state, 'declared', name);
    const { status: storedStatus, meta: storedMeta, ...rest } = found.road;
    assert.equal(storedStatus, 'QUEUED', name);
    assert.deepEqual(Object.keys(found.road), ROAD_KEYS, name);
    assert.deepEqual(rest, input, `${name}: nothing lost, nothing invented`);
    assert.equal(storedMeta.generator, 'akrs/2.0.0-alpha.0');
  }
});

test('a submitted status or meta is refused: the CLI fills them', async (t) => {
  const repo = await createRepo(t);
  const before = await everything(repo);
  const result = await submit(repo, { ...roadInput(), status: 'ACTIVE' });
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(pointersOf(result.packet), ['/status']);
  assert.equal(await everything(repo), before);
});

// ---- schema failures: usage errors, pointers, nothing written --------------------------------------------------
const invalidNames = (await readdir(new URL('../fixtures/road-schema-invalid/', import.meta.url)))
  .filter((name) => name.endsWith('.json') && name !== 'provenance.json' && name !== 'package.json')
  .map((name) => name.slice(0, -'.json'.length));

test('there are enough invalid fixtures to mean something', () => {
  assert.equal(invalidNames.length >= 20, true);
});

for (const name of invalidNames) {
  test(`invalid fixture ${name}: rejected with JSON pointers, usage kind, nothing written`, async (t) => {
    const repo = await createRepo(t);
    const { document, expect } = await fixture('road-schema-invalid', name);
    const before = await strict(repo);
    const result = await submit(repo, document);
    assert.equal(result.outcome, 'rejected');
    const { packet } = result;
    assert.equal(packet.status, 'error');
    assert.equal(packet.data.kind, 'usage');
    assert.equal(packet.data.reason, 'invalid_input');
    assert.deepEqual(codesOf(packet), ['AKRS-R011']);
    assert.deepEqual(pointersOf(packet), [...expect.map(({ pointer }) => pointer)].sort());
    assert.equal(packet.changed.length, 0);
    assertFindingsMatchCatalog(packet);
    assert.equal(await strict(repo), before, 'the byte tree is unchanged, .ops included');
  });
}

test('an unfilled template is rejected and the packet names the exact missing inputs', async (t) => {
  const repo = await createRepo(t);
  const skeleton = buildTemplate('road', { class: 'weak' }).skeleton;
  const result = await submit(repo, skeleton);
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(result.packet.data.missing_inputs, findMissingInputs('road', skeleton));
  assert.deepEqual(result.packet.data.missing_inputs.map(({ pointer }) => pointer), ['/acceptance/0', '/id']);
  assert.equal(result.packet.next_commands.some(({ command, args }) => command === 'template' && args.join(' ') === 'road'), true);
});

test('findings of a file input point at that file; stdin findings carry no file', async (t) => {
  const repo = await createRepo(t);
  await draftDocument(repo, 'road-a', { ...roadInput(), approach: 'prose' });
  const fromDraft = await fromFile(repo, 'akrs/drafts/road-a.json');
  assert.equal(fromDraft.packet.findings.every(({ file }) => file === 'akrs/drafts/road-a.json'), true);
  const viaStdin = await submit(repo, { ...roadInput(), approach: 'prose' });
  assert.equal(viaStdin.packet.findings.every(({ file }) => file === null), true);
});

// ---- cross-Road graph and collisions ---------------------------------------------------------------------------
test('a duplicate ID is refused in any folder, case-folded, and against Plans', async (t) => {
  const repo = await createRepo(t);
  await seedRoad(repo, { id: 'R-old' }, { folder: 'roads/legacy/sub' });
  await seedPlan(repo, 'P9');
  const before = await everything(repo);
  const expectations = [
    [{ id: 'R-old', plan: null }, ['akrs/roads/R-old.json', 'akrs/roads/legacy/sub/R-old.json']],
    [{ id: 'R-old', plan: 'P7' }, ['akrs/roads/P7/R-old.json', 'akrs/roads/legacy/sub/R-old.json']],
    [{ id: 'r-OLD', plan: null }, ['akrs/roads/legacy/sub/R-old.json', 'akrs/roads/r-OLD.json']],
    [{ id: 'P9', plan: null }, ['akrs/plans/P9.json', 'akrs/roads/P9.json']],
    [{ id: 'p9', plan: null }, ['akrs/plans/P9.json', 'akrs/roads/p9.json']],
  ];
  for (const [overrides, files] of expectations) {
    const result = await submit(repo, roadInput({ ...overrides, task: null }));
    assert.equal(result.outcome, 'rejected', JSON.stringify(overrides));
    assert.equal(result.packet.status, 'error');
    assert.equal(result.packet.data.kind, 'findings');
    assert.deepEqual(codesOf(result.packet), ['AKRS-R001']);
    assert.deepEqual(result.packet.findings[0].detail.conflicting_files, files.sort(), JSON.stringify(overrides));
    assert.match(result.packet.findings[0].message, /\(at \/id\)/);
    assertFindingsMatchCatalog(result.packet);
  }
  assert.equal(await everything(repo), before);
});

test('IDs are explicit and independent of folders: the same ID cannot be reused just because the folder differs', async (t) => {
  const repo = await createRepo(t);
  assert.equal((await submit(repo, roadInput({ id: 'R-a', plan: 'P6', task: null }))).outcome, 'committed');
  assert.equal((await submit(repo, roadInput({ id: 'R-b', plan: 'P7', task: null }))).outcome, 'committed');
  const clash = await submit(repo, roadInput({ id: 'R-a', plan: 'P7', task: null }));
  assert.equal(clash.outcome, 'rejected');
  assert.deepEqual(await listFiles(repo.path('akrs/roads')), ['P6/R-a.json', 'P7/R-b.json']);
});

test('a plan that names an existing Road is refused (one namespace for Plans and Roads)', async (t) => {
  const repo = await createRepo(t);
  await seedRoad(repo, { id: 'R-first' });
  const before = await everything(repo);
  const result = await submit(repo, roadInput({ id: 'R-second', plan: 'R-first', task: null }));
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(codesOf(result.packet), ['AKRS-R013']);
  assert.deepEqual(pointersOf(result.packet), ['/plan']);
  assert.equal(result.packet.findings[0].detail.reason, 'plan_names_a_road');
  assertFindingsMatchCatalog(result.packet);
  assert.equal(await everything(repo), before);
});

test('an unknown dependency is refused with its pointer; known ones in any folder are accepted', async (t) => {
  const repo = await createRepo(t);
  await seedRoad(repo, { id: 'R-known' }, { folder: 'roads/P5' });
  const before = await everything(repo);
  const bad = await submit(repo, roadInput({ id: 'R-new', plan: null, task: null, deps: ['R-known', 'R-ghost', 'R-phantom'] }));
  assert.equal(bad.outcome, 'rejected');
  assert.equal(bad.packet.data.kind, 'findings');
  assert.deepEqual(codesOf(bad.packet), ['AKRS-R005']);
  assert.deepEqual(bad.packet.findings.map(({ detail }) => detail), [
    { road_id: 'R-new', dependency: 'R-ghost', status: 'QUEUED' },
    { road_id: 'R-new', dependency: 'R-phantom', status: 'QUEUED' },
  ]);
  assert.match(bad.packet.findings[0].message, /\(at \/deps\/1\)/);
  assert.match(bad.packet.findings[1].message, /\(at \/deps\/2\)/);
  assertFindingsMatchCatalog(bad.packet);
  assert.equal(await everything(repo), before);
  const good = await submit(repo, roadInput({ id: 'R-new', plan: null, task: null, deps: ['R-known'] }));
  assert.equal(good.outcome, 'committed');
});

test('a dependency on a Plan ID is an unknown dependency: dependencies are Roads', async (t) => {
  const repo = await createRepo(t);
  await seedPlan(repo, 'P9');
  const result = await submit(repo, roadInput({ id: 'R-new', plan: null, task: null, deps: ['P9'] }));
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(codesOf(result.packet), ['AKRS-R005']);
});

test('a dependency cycle through the new Road is refused; an unrelated existing cycle does not block creation', async (t) => {
  const repo = await createRepo(t);
  await seedRoad(repo, { id: 'R-a', deps: ['R-new'] });
  const before = await everything(repo);
  const cyc = await submit(repo, roadInput({ id: 'R-new', plan: null, task: null, deps: ['R-a'] }));
  assert.equal(cyc.outcome, 'rejected');
  assert.deepEqual(codesOf(cyc.packet), ['AKRS-R006']);
  assert.deepEqual(cyc.packet.findings[0].detail.cycle, ['R-a', 'R-new', 'R-a']);
  assertFindingsMatchCatalog(cyc.packet);
  assert.equal(await everything(repo), before);

  // R-x <-> R-y already form a cycle; a new Road that does not touch it is still created
  const other = await createRepo(t);
  await seedRoad(other, { id: 'R-x', deps: ['R-y'] });
  await seedRoad(other, { id: 'R-y', deps: ['R-x'] });
  const fine = await submit(other, roadInput({ id: 'R-free', plan: null, task: null }));
  assert.equal(fine.outcome, 'committed');
});

test('every problem is reported at once, in one deterministic order', async (t) => {
  const repo = await createRepo(t);
  await seedRoad(repo, { id: 'R-dup' });
  const result = await submit(repo, roadInput({
    id: 'R-dup', plan: null, task: null, deps: ['R-ghost'],
    reads: [{ path: 'SOT/09-use-cases.md', lines: [28, 99], why: null }],
  }));
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(codesOf(result.packet), ['AKRS-R001', 'AKRS-R005', 'AKRS-R012']);
  assertFindingsMatchCatalog(result.packet);
  const again = await submit(repo, roadInput({
    id: 'R-dup', plan: null, task: null, deps: ['R-ghost'],
    reads: [{ path: 'SOT/09-use-cases.md', lines: [28, 99], why: null }],
  }));
  assert.deepEqual(again.packet.findings, result.packet.findings);
});

test('an existing Road that cannot be read is a warning, not a blocker: the graph is reported as incomplete', async (t) => {
  const repo = await createRepo(t);
  await repo.write('akrs/roads/R-garbage.json', '{ not json');
  const result = await submit(repo, roadInput({ id: 'R-new', plan: null, task: null }));
  assert.equal(result.outcome, 'committed');
  assert.equal(result.packet.status, 'warning');
  assert.deepEqual(codesOf(result.packet), ['AKRS-C005']);
  assert.equal(result.packet.findings[0].detail.check, 'road-graph');
  assert.equal(result.packet.findings[0].file, 'akrs/roads/R-garbage.json');
  assertFindingsMatchCatalog(result.packet);
});

test('declared paths are judged against the repository: escapes through links and case mismatches are refused', async (t) => {
  const repo = await createRepo(t);
  const outside = await createRepo(t);
  let linked = true;
  try {
    await symlink(outside.root, repo.path('escape'), 'dir');
  } catch {
    linked = false;
  }
  const before = await everything(repo);
  const cases = [
    ['/writes/0/path', { writes: [{ path: 'App/pages/admin.vue', class: 'file', action: 'create' }] }, 'case_mismatch'],
    ['/forbidden/0', { forbidden: ['SoT/**'] }, 'case_mismatch'],
    ['/on_landing', { on_landing: 'Src/own.js' }, 'case_mismatch'],
    ...(linked ? [
      ['/writes/0/path', { writes: [{ path: 'escape/new.js', class: 'file', action: 'create' }] }, 'unsafe'],
      ['/reads/0/path', { reads: [{ path: 'escape/secret.txt', lines: null, why: null }] }, 'unsafe'],
    ] : []),
  ];
  for (const [pointer, overrides, reason] of cases) {
    const result = await submit(repo, roadInput({ id: `R-${reason.replace('_', '-')}`, plan: null, task: null, ...overrides }));
    assert.equal(result.outcome, 'rejected', pointer);
    assert.equal(result.packet.data.kind, 'findings');
    assert.deepEqual(codesOf(result.packet), ['AKRS-R012'], pointer);
    assert.deepEqual(pointersOf(result.packet), [pointer], pointer);
    assert.equal(result.packet.findings[0].detail.reason, reason, pointer);
    assertFindingsMatchCatalog(result.packet);
  }
  assert.equal(await everything(repo), before);
});

test('invalid read windows are refused: missing file, directory, past the end, binary, wrong case', async (t) => {
  const repo = await createRepo(t, { files: { 'bin/data.bin': Buffer.from([0, 1, 2]) } });
  const before = await everything(repo);
  const cases = [
    [{ path: 'SOT/99-missing.md', lines: [1, 2], why: null }, 'missing', '/reads/1/path'],
    [{ path: 'SOT', lines: [1, 2], why: null }, 'not_file', '/reads/1/path'],
    [{ path: 'SOT/09-use-cases.md', lines: [48, 51], why: null }, 'out_of_range', '/reads/1/lines'],
    [{ path: 'SOT/09-use-cases.md', lines: [51, 52], why: null }, 'out_of_range', '/reads/1/lines'],
    [{ path: 'bin/data.bin', lines: [1, 1], why: null }, 'not_text', '/reads/1/path'],
    [{ path: 'sot/09-use-cases.md', lines: [1, 2], why: null }, 'case_mismatch', '/reads/1/path'],
  ];
  for (const [read, reason, pointer] of cases) {
    const result = await submit(repo, roadInput({ id: 'R-w', plan: null, task: null, reads: [{ path: 'SOT/02-rules.md', lines: [1, 2], why: null }, read] }));
    assert.equal(result.outcome, 'rejected', reason);
    assert.deepEqual(codesOf(result.packet), ['AKRS-R012'], reason);
    assert.deepEqual(pointersOf(result.packet), [pointer], reason);
    const { detail } = result.packet.findings[0];
    assert.equal(detail.reason, reason);
    assert.equal(detail.path, read.path);
    assertFindingsMatchCatalog(result.packet);
  }
  assert.equal(await everything(repo), before);
});

test('a whole-file read may name a file that does not exist yet; a read of an own write is not required to exist', async (t) => {
  const repo = await createRepo(t);
  const result = await submit(repo, roadInput({
    id: 'R-soft', plan: null, task: null,
    reads: [
      { path: 'akrs/memory/ui.md', lines: null, why: 'landed later' },
      { path: 'app/pages/admin.vue', lines: [1, 5], why: 'own write, created by this Road' },
    ],
  }));
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(result.packet.findings, []);
});

// ---- drafts ----------------------------------------------------------------------------------------------------
test('success from a draft removes the draft in the same transaction and lists both paths in changed', async (t) => {
  const repo = await createRepo(t);
  const input = roadInput();
  await draftDocument(repo, 'road-a', input);
  const result = await fromFile(repo, 'akrs/drafts/road-a.json');
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(result.packet.changed, ['drafts/road-a.json', 'roads/P6/R-P6-1.json']);
  assert.equal(result.packet.data.draft, 'akrs/drafts/road-a.json');
  await assert.rejects(() => readFile(repo.path('akrs/drafts/road-a.json')), { code: 'ENOENT' });
  assert.equal(await repo.read('akrs/roads/P6/R-P6-1.json'), roadText(storedRoad(input)));
  assert.equal(validateMutationChanges(result.packet, ['drafts/road-a.json', 'roads/P6/R-P6-1.json']).ok, true);
});

test('--input accepts backslashes, a leading ./, and an absolute path inside the repository; the draft is still consumed', async (t) => {
  for (const [name, spelling] of [
    ['a', (repo) => 'akrs\\drafts\\road-a.json'],
    ['b', () => './akrs/drafts/road-a.json'],
    ['c', (repo) => repo.path('akrs/drafts/road-a.json')],
  ]) {
    const repo = await createRepo(t);
    await draftDocument(repo, 'road-a', roadInput());
    const result = await fromFile(repo, spelling(repo));
    assert.equal(result.outcome, 'committed', name);
    assert.deepEqual(result.packet.changed, ['drafts/road-a.json', 'roads/P6/R-P6-1.json'], name);
    await assert.rejects(() => readFile(repo.path('akrs/drafts/road-a.json')), { code: 'ENOENT' }, name);
  }
});

test('a file that is not under drafts/ is read but never deleted', async (t) => {
  const repo = await createRepo(t);
  await repo.write('docs/road.json', `${JSON.stringify(roadInput(), null, 2)}\n`);
  const result = await fromFile(repo, 'docs/road.json');
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(result.packet.changed, ['roads/P6/R-P6-1.json']);
  assert.equal(result.packet.data.draft, null);
  assert.equal((await repo.read('docs/road.json')).includes('R-P6-1'), true);
});

test('on failure the draft stays byte for byte and the findings carry pointers', async (t) => {
  const repo = await createRepo(t);
  await draftDocument(repo, 'road-bad', { ...roadInput(), deps: ['R-ghost'], steps: undefined });
  const bytes = await repo.read('akrs/drafts/road-bad.json');
  const schemaFailure = await fromFile(repo, 'akrs/drafts/road-bad.json');
  assert.equal(schemaFailure.outcome, 'rejected');
  assert.deepEqual(pointersOf(schemaFailure.packet), ['/steps']);
  assert.equal(await repo.read('akrs/drafts/road-bad.json'), bytes);

  await draftDocument(repo, 'road-graph', roadInput({ deps: ['R-ghost'] }));
  const graphBytes = await repo.read('akrs/drafts/road-graph.json');
  const graphFailure = await fromFile(repo, 'akrs/drafts/road-graph.json');
  assert.equal(graphFailure.outcome, 'rejected');
  assert.equal(graphFailure.packet.findings.every(({ file }) => file === 'akrs/drafts/road-graph.json'), true);
  assert.equal(await repo.read('akrs/drafts/road-graph.json'), graphBytes);
  assert.equal(graphFailure.packet.next_commands.some(({ command, args }) => command === 'road-new'
    && args.join(' ') === '--input akrs/drafts/road-graph.json'), true, 'the retry command is runnable as is');
});

test('a write failure in the middle of the transaction restores everything, the draft included', async (t) => {
  const repo = await createRepo(t);
  await draftDocument(repo, 'road-a', roadInput());
  const before = await everything(repo);
  await assert.rejects(() => fromFile(repo, 'akrs/drafts/road-a.json', {
    boundary: ({ point, index }) => { if (point === 'operation_applied' && index === 1) throw new Error('disk full'); },
  }), /disk full/);
  assert.equal(await treeDigest(repo), before, 'tree restored (everything but .ops)');
  await assert.rejects(() => readFile(repo.path('akrs/roads/P6/R-P6-1.json')), { code: 'ENOENT' });
  assert.equal((await repo.read('akrs/drafts/road-a.json')).includes('R-P6-1'), true);
});

test('a draft edited between validation and the commit writes nothing', async (t) => {
  const repo = await createRepo(t);
  await draftDocument(repo, 'road-a', roadInput());
  const result = await fromFile(repo, 'akrs/drafts/road-a.json', {
    hooks: { afterInputRead: () => draftDocument(repo, 'road-a', roadInput({ acceptance: ['edited in the meantime'] })) },
  });
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.packet.data.kind, 'usage');
  assert.equal(result.packet.data.reason, 'input_changed');
  await assert.rejects(() => readFile(repo.path('akrs/roads/P6/R-P6-1.json')), { code: 'ENOENT' });
  assert.equal((await repo.read('akrs/drafts/road-a.json')).includes('edited in the meantime'), true);
});

// ---- input channel ---------------------------------------------------------------------------------------------
test('every channel failure is a C008 usage packet with a root pointer and writes nothing', async (t) => {
  const repo = await createRepo(t);
  await repo.write('docs/big.json', ' '.repeat(1024 * 1024 + 1));
  await repo.write('docs/utf16.json', Buffer.from('﻿{}', 'utf16le'));
  await repo.write('docs/dup.json', '{"schema":"akrs.road/v1","schema":"akrs.road/v1"}');
  await repo.write('docs/broken.json', '{ nope');
  await repo.write('docs/array.json', '[1,2]');
  const before = await strict(repo);
  const cases = [
    ['docs/missing.json', 'not_found'],
    ['docs/big.json', 'too_large'],
    ['docs/utf16.json', 'invalid_encoding'],
    ['docs/dup.json', 'duplicate_key'],
    ['docs/broken.json', 'invalid_json'],
    ['docs/array.json', 'invalid_type'],
    ['../outside.json', 'invalid_path'],
    ['/etc/passwd', 'invalid_path'],
    ['docs', 'not_file'],
  ];
  for (const [path, issue] of cases) {
    const result = await fromFile(repo, path);
    assert.equal(result.outcome, 'rejected', path);
    assert.equal(result.packet.status, 'error', path);
    assert.equal(result.packet.data.kind, 'usage', path);
    assert.deepEqual(codesOf(result.packet), ['AKRS-C008'], path);
    assert.match(result.packet.findings[0].detail.issue, new RegExp(`^${issue}`), path);
    assertFindingsMatchCatalog(result.packet);
  }
  const empty = await submit(repo, '');
  assert.equal(empty.outcome, 'rejected');
  assert.equal(await strict(repo), before);
});

test('BOM and CRLF are tolerated and give identical stored bytes', async (t) => {
  const plain = await createRepo(t);
  const messy = await createRepo(t);
  const text = JSON.stringify(roadInput(), null, 2);
  await submit(plain, text);
  await submit(messy, `﻿${text.replaceAll('\n', '\r\n')}`);
  assert.equal(await messy.read('akrs/roads/P6/R-P6-1.json'), await plain.read('akrs/roads/P6/R-P6-1.json'));
});

// ---- idempotency, replay, snapshots, dry runs -------------------------------------------------------------------
test('the same request again is a noop replay of the original packet and writes nothing', async (t) => {
  const repo = await createRepo(t);
  const providers = fakeProviders();
  const first = await submit(repo, roadInput(), { providers });
  assert.equal(first.outcome, 'committed');
  const after = await everything(repo);
  const second = await submit(repo, roadInput(), { providers });
  assert.equal(second.outcome, 'replayed');
  assert.equal(second.packet.status, 'noop');
  assert.equal(second.packet.request_id, first.packet.request_id);
  assert.deepEqual(second.packet.changed, []);
  assert.equal(second.packet.data.road.id, 'R-P6-1');
  assert.equal(validateReadOnlyPacket(second.packet).ok, true);
  assert.equal(await everything(repo), after);
});

test('a deleted-draft retry is resolved through the journal before any usage error', async (t) => {
  const repo = await createRepo(t);
  const providers = fakeProviders();
  await draftDocument(repo, 'road-a', roadInput());
  const first = await fromFile(repo, 'akrs/drafts/road-a.json', { providers });
  assert.equal(first.outcome, 'committed');
  const after = await everything(repo);
  const retry = await fromFile(repo, 'akrs/drafts/road-a.json', { providers });
  assert.equal(retry.outcome, 'replayed');
  assert.equal(retry.packet.status, 'noop');
  assert.equal(retry.packet.request_id, first.packet.request_id);
  assert.equal(await everything(repo), after);

  const byId = await fromFile(repo, 'akrs/drafts/road-a.json', { providers, requestId: first.packet.request_id });
  assert.equal(byId.outcome, 'replayed', 'the caller-supplied ID of the committed op replays too');
  assert.equal(await everything(repo), after);
});

test('a missing draft that never ran, or whose projection moved on, is a usage error', async (t) => {
  const repo = await createRepo(t);
  const providers = fakeProviders();
  const never = await fromFile(repo, 'akrs/drafts/road-none.json', { providers });
  assert.equal(never.outcome, 'rejected');
  assert.match(never.packet.findings[0].detail.issue, /^not_found/);
  assert.equal(never.packet.next_commands.some(({ command }) => command === 'template'), true);

  await draftDocument(repo, 'road-a', roadInput());
  assert.equal((await fromFile(repo, 'akrs/drafts/road-a.json', { providers })).outcome, 'committed');
  await seedRoad(repo, { id: 'R-other' });
  const moved = await fromFile(repo, 'akrs/drafts/road-a.json', { providers });
  assert.equal(moved.outcome, 'rejected', 'the workflow changed after the original commit: no replay');
});

test('a stale expected snapshot writes nothing; a current one is accepted', async (t) => {
  const repo = await createRepo(t);
  const stale = (await commandSnapshot('road-new', repo.options)).snapshot;
  await seedRoad(repo, { id: 'R-moved-on' });
  const before = await everything(repo);
  const blocked = await submit(repo, roadInput(), { expectedSnapshot: stale });
  assert.equal(blocked.outcome, 'stale');
  assert.equal(blocked.packet.status, 'blocked');
  assert.deepEqual(codesOf(blocked.packet), ['AKRS-C013']);
  assert.equal(await everything(repo), before);
  const current = (await commandSnapshot('road-new', repo.options)).snapshot;
  assert.equal((await submit(repo, roadInput(), { expectedSnapshot: current })).outcome, 'committed');
});

test('a request ID reused for different input is a conflict and writes nothing', async (t) => {
  const repo = await createRepo(t);
  const providers = fakeProviders();
  const requestId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  assert.equal((await submit(repo, roadInput(), { providers, requestId })).outcome, 'committed');
  const before = await everything(repo);
  const conflict = await submit(repo, roadInput({ id: 'R-other', task: null }), { providers, requestId });
  assert.equal(conflict.outcome, 'conflict');
  assert.equal(conflict.packet.data.kind, 'usage');
  assert.deepEqual(codesOf(conflict.packet), ['AKRS-C010']);
  assert.equal(await everything(repo), before);
  assert.equal((await submit(repo, roadInput(), { providers, requestId })).outcome, 'replayed');
});

test('an invalid request ID is a usage error before anything is read or written', async (t) => {
  const repo = await createRepo(t);
  const before = await everything(repo);
  const result = await submit(repo, roadInput(), { requestId: 'not-a-ulid' });
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.packet.data.kind, 'usage');
  assert.equal(await everything(repo), before);
});

test('--dry-run returns the exact proposed object and the files it would change, and touches nothing (.ops included)', async (t) => {
  const repo = await createRepo(t);
  await draftDocument(repo, 'road-a', roadInput());
  const before = await strict(repo);
  const result = await fromFile(repo, 'akrs/drafts/road-a.json', { dryRun: true });
  assert.equal(result.outcome, 'dry_run');
  const { packet } = result;
  assert.equal(packet.status, 'ok');
  assert.equal(packet.request_id, null);
  assert.deepEqual(packet.changed, []);
  assert.equal(packet.data.dry_run, true);
  assert.deepEqual(packet.data.would_change, ['drafts/road-a.json', 'roads/P6/R-P6-1.json']);
  assert.deepEqual(packet.data.proposed, storedRoad(roadInput()));
  assert.equal(validateReadOnlyPacket(packet).ok, true);
  assert.equal(await strict(repo), before);
  const invalid = await submit(repo, { ...roadInput(), steps: undefined }, { dryRun: true });
  assert.equal(invalid.outcome, 'rejected');
  assert.equal(await strict(repo), before);
});

test('two concurrent writers of the same ID: exactly one wins, the other is refused as a duplicate', async (t) => {
  const repo = await createRepo(t);
  const runs = [
    [roadInput({ acceptance: ['variant A'] }), {}],
    [roadInput({ acceptance: ['variant B'] }), { providers: fakeProviders({ firstId: 5000 }) }],
  ];
  const [a, b] = await Promise.all(runs.map(([input, extra]) => submit(repo, input, extra)));
  // A contender that outlives the lock wait budget on a loaded runner gets the documented `lock_blocked` packet and writes
  // nothing; the packet's own next step is "run it again", so it is retried once the lock is free, as an agent would.
  for (const [index, run] of [a, b].entries()) {
    if (run.outcome === 'lock_blocked') [a, b][index] = await submit(repo, ...runs[index]);
  }
  assert.deepEqual([a.outcome, b.outcome].sort(), ['committed', 'rejected']);
  const loser = a.outcome === 'rejected' ? a : b;
  assert.deepEqual(codesOf(loser.packet), ['AKRS-R001']);
  assert.deepEqual(await listFiles(repo.path('akrs/roads')), ['P6/R-P6-1.json']);
});

test('arguments are checked: a channel is required and exactly one of inputPath or stdin', async (t) => {
  const repo = await createRepo(t);
  await assert.rejects(() => createRoad({ ...authoringOptions(repo) }), TypeError);
  await assert.rejects(() => createRoad({ ...authoringOptions(repo), channel: { inputPath: 'a.json', stdin: Buffer.from('{}') } }), TypeError);
  await assert.rejects(() => createRoad({ ...authoringOptions(repo), channel: { stdin: 'text' } }), TypeError);
});
