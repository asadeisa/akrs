import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLASS_PROFILES, estimateTokens, evaluateFit, resolveProfile, roadFit } from '../../lib/store/executors/index.js';
import { assertFindingsMatchCatalog, codesOf } from '../road/support.js';
import {
  bigRoad, createRepo, everything, flash, lead, newRoad, roadInput, runCommand, seedRoad, setExec, strict, writes,
} from './support.js';

const knobs = (fit) => fit.violations.map(({ knob }) => knob).sort();

test('the shipped class profiles are exactly the A1 2.2 numbers; overrides merge over them, numbers only', () => {
  assert.deepEqual(CLASS_PROFILES.weak, {
    max_writes: 3, max_write_dirs: 1, read_budget_tokens: 6000, done_failures_before_yield: 2, envelope_grant_cap: 3,
    write_classes: ['file'], steps_required: true, check_required: true,
  });
  assert.equal(CLASS_PROFILES.medium.max_writes, 8);
  assert.equal(CLASS_PROFILES.frontier.read_budget_tokens, 60000);
  assert.deepEqual(CLASS_PROFILES.frontier.write_classes, ['file', 'dir', 'glob']);
  assert.equal(CLASS_PROFILES.frontier.check_required, false);
  const merged = resolveProfile('weak', { weak: { max_writes: 2 }, medium: { max_writes: 9 } });
  assert.equal(merged.max_writes, 2);
  assert.equal(merged.max_write_dirs, 1);
  assert.equal(resolveProfile('weak', {}).max_writes, 3);
});

test('the read-token estimator is deterministic and does not under-count CJK or Arabic', () => {
  const ascii = 'abcd'.repeat(100);
  const arabic = 'مرحبا بالعالم '.repeat(50);
  const cjk = '你好世界'.repeat(100);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(ascii), 100);
  assert.equal(estimateTokens(ascii), estimateTokens(ascii));
  assert.equal(estimateTokens(cjk), 400);
  assert.ok(estimateTokens(arabic) > Array.from(arabic).length / 4, 'Arabic costs more than ASCII per character');
  assert.ok(estimateTokens(cjk) > estimateTokens('a'.repeat(400)));
  assert.equal(estimateTokens(arabic), estimateTokens(`${arabic}`));
});

test('evaluateFit: verdicts, violated knobs, advisory complexity', () => {
  const base = { writes: writes(2), reads: [], checks: [{ name: 'c', argv: ['x'], timeout_ms: 1 }], steps: ['one'], complexity: 0, executor_class: 'weak' };
  const load = { read_tokens: 0, depth: 0 };
  const fits = evaluateFit({ road: base, profile: CLASS_PROFILES.weak, ...load });
  assert.equal(fits.verdict, 'fits');
  const four = evaluateFit({ road: { ...base, writes: writes(4) }, profile: CLASS_PROFILES.weak, ...load });
  assert.equal(four.verdict, 'split_required');
  assert.deepEqual(knobs(four), ['max_writes']);
  const dirs = evaluateFit({ road: { ...base, writes: writes(3, { dirs: 3 }) }, profile: CLASS_PROFILES.weak, ...load });
  assert.deepEqual(knobs(dirs), ['max_write_dirs']);
  const reads = evaluateFit({ road: base, profile: CLASS_PROFILES.weak, read_tokens: 6001, depth: 0 });
  assert.equal(reads.verdict, 'reads_over_budget');
  assert.deepEqual(knobs(reads), ['read_budget_tokens']);
  const both = evaluateFit({ road: { ...base, writes: writes(4) }, profile: CLASS_PROFILES.weak, read_tokens: 99999, depth: 0 });
  assert.equal(both.verdict, 'split_required');
  const weakBad = evaluateFit({ road: { ...base, steps: [], checks: [], writes: [{ path: 'src', class: 'dir', action: 'modify' }] }, profile: CLASS_PROFILES.weak, ...load });
  assert.deepEqual(knobs(weakBad), ['check_required', 'steps_required', 'write_classes']);
  const advisory = evaluateFit({ road: { ...base, complexity: 10 }, profile: CLASS_PROFILES.weak, ...load });
  assert.equal(advisory.verdict, 'fits');
  assert.equal(advisory.complexity, 10);
  assert.equal(evaluateFit({ road: { ...base, steps: [], checks: [] }, profile: CLASS_PROFILES.frontier, ...load }).verdict, 'fits');
});

test('road fit reads a stored Road: load, verdict, deterministic split suggestions that respect the limits', async (t) => {
  const repo = await createRepo(t);
  await seedRoad(repo, bigRoad({ writes: writes(7, { dirs: 4 }) }), { folder: 'roads' });
  const run = async () => JSON.parse((await runCommand(repo, ['road', 'fit', 'R-BIG', '--json'])).stdout);
  const first = await run();
  assert.equal(first.status, 'ok');
  assert.equal(first.data.fit.verdict, 'split_required');
  assert.equal(first.data.fit.class, 'weak');
  assert.equal(first.data.fit.load.writes, 7);
  const groups = first.data.fit.suggestions;
  assert.ok(groups.length >= 3);
  assert.deepEqual(groups.flatMap((group) => group.writes.map(({ path }) => path)).sort(), writes(7, { dirs: 4 }).map(({ path }) => path).sort());
  for (const group of groups) {
    assert.ok(group.writes.length <= 3);
    assert.ok(new Set(group.writes.map(({ path }) => path.split('/').slice(0, -1).join('/'))).size <= 1);
  }
  assert.deepEqual((await run()).data.fit, first.data.fit, 'same input, same groups');
});

test('road fit is a pure query: no byte changes; the class comes from the Road, --class, or is a usage error', async (t) => {
  const repo = await createRepo(t);
  await seedRoad(repo, bigRoad({ executor_class: null }), { folder: 'roads' });
  const before = await strict(repo);
  const none = await runCommand(repo, ['road', 'fit', 'R-BIG', '--json']);
  assert.equal(none.exitCode, 2);
  const given = JSON.parse((await runCommand(repo, ['road', 'fit', 'R-BIG', '--class', 'frontier', '--json'])).stdout);
  assert.equal(given.data.fit.verdict, 'fits');
  assert.equal((await runCommand(repo, ['road', 'fit', 'R-NOPE', '--class', 'weak', '--json'])).exitCode, 2);
  assert.equal((await runCommand(repo, ['road', 'fit', 'R-BIG', '--class', 'tiny', '--json'])).exitCode, 2);
  assert.deepEqual(await strict(repo), before);
});

test('road fit --input judges a draft; --write-drafts writes the split suggestions as drafts (the one declared write)', async (t) => {
  const repo = await createRepo(t);
  await repo.write('akrs/drafts/big.json', `${JSON.stringify(bigRoad({ writes: writes(7, { dirs: 1 }) }), null, 2)}\n`);
  const query = JSON.parse((await runCommand(repo, ['road', 'fit', '--input', 'akrs/drafts/big.json', '--json'])).stdout);
  assert.equal(query.data.fit.verdict, 'split_required');
  assert.deepEqual(query.changed, []);
  const before = await strict(repo);
  await roadFit({ ...repo.options, document: bigRoad() });
  assert.deepEqual(await strict(repo), before, 'the core query writes nothing');
  const wrote = JSON.parse((await runCommand(repo, ['road', 'fit', '--input', 'akrs/drafts/big.json', '--write-drafts', '--json'])).stdout);
  assert.equal(wrote.changed.length, query.data.fit.suggestions.length);
  for (const path of wrote.changed) assert.match(path, /^drafts\/R-BIG-split-\d+\.json$/);
  const first = JSON.parse(await repo.read(`akrs/${wrote.changed[0]}`));
  assert.equal(first.id, 'R-BIG-split-1');
  assert.equal(first.status, undefined);
  assert.ok(first.writes.length <= 3);
  const fits = JSON.parse((await runCommand(repo, ['road', 'fit', 'R-NOPE', '--write-drafts', '--json'])).stdout);
  assert.equal(fits.status, 'error');
});

test('changing class_overrides changes the road fit verdict', async (t) => {
  const repo = await createRepo(t);
  await seedRoad(repo, bigRoad({ writes: writes(4) }), { folder: 'roads' });
  const verdict = async () => JSON.parse((await runCommand(repo, ['road', 'fit', 'R-BIG', '--json'])).stdout).data.fit.verdict;
  assert.equal(await verdict(), 'split_required');
  await setExec(repo, null, { setOverrides: [{ class: 'weak', knob: 'max_writes', value: 4 }] });
  assert.equal(await verdict(), 'fits');
});

test('road new with an over-limit Road still writes it and reports a failed class finding; oversize_reason makes it a warning', async (t) => {
  const repo = await createRepo(t);
  await setExec(repo, lead);
  const over = await newRoad(repo, bigRoad({ id: 'R-OVER' }));
  assert.equal(over.outcome, 'committed');
  assert.equal(over.packet.status, 'warning');
  const finding = over.packet.findings.find(({ code }) => code === 'AKRS-R015');
  assert.equal(finding.severity, 'error');
  assert.equal(finding.detail.knob, 'max_writes');
  assert.equal(finding.detail.limit, 3);
  assert.equal(finding.detail.actual, 4);
  assertFindingsMatchCatalog(over.packet);
  const reasoned = await newRoad(repo, bigRoad({ id: 'R-REASON', oversize_reason: 'One mechanical rename across four files.' }));
  assert.equal(reasoned.outcome, 'committed');
  const reported = reasoned.packet.findings.find(({ code }) => code === 'AKRS-R015');
  assert.equal(reported.severity, 'warning');
  const fine = await newRoad(repo, roadInput({ plan: null, task: null, id: 'R-FINE' }));
  assert.equal(fine.packet.status, 'ok');
  assert.deepEqual(codesOf(fine.packet), []);
});

test('oversize_reason is refused (nothing written) when the Leader class is weak or medium', async (t) => {
  for (const cls of ['weak', 'medium']) {
    const repo = await createRepo(t);
    await setExec(repo, { ...lead, class: cls, user_answer: cls });
    const before = await everything(repo);
    const refused = await newRoad(repo, bigRoad({ oversize_reason: 'I need it big.' }));
    assert.equal(refused.outcome, 'rejected', cls);
    assert.ok(refused.packet.findings.some(({ code }) => code === 'AKRS-R016'), cls);
    assertFindingsMatchCatalog(refused.packet);
    assert.deepEqual(await everything(repo), before, cls);
  }
});

test('a weak Road without steps, without a check, or with a dir write gets failed class findings', async (t) => {
  const repo = await createRepo(t);
  await setExec(repo, flash);
  const bad = await newRoad(repo, roadInput({ plan: null, task: null, id: 'R-WEAK', steps: [], checks: [], writes: [{ path: 'src/area', class: 'dir', action: 'modify' }] }));
  assert.equal(bad.outcome, 'committed');
  const found = bad.packet.findings.filter(({ code }) => code === 'AKRS-R015').map(({ detail }) => detail.knob).sort();
  assert.deepEqual(found, ['check_required', 'steps_required', 'write_classes']);
});
