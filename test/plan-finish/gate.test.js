// P2-W08: the close gate. Every condition that fails is reported (not the first one only), the refusal is blocked (exit 1) and
// writes nothing, and no pass is ever carried forward.
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { treeDigest } from '../road/support.js';
import { seedResult } from '../test-details/support.js';
import { PLAN_PATH, T007, blockersOf, closableWorld, closures, details, finish, flat, full, ledger, ranWorld, redefine, removeEvidenceFiles, seedRoad, snapshotOf, testRun, worldOptions, writePlan } from './support.js';

const refused = async (repo, reasons, args = []) => {
  const digest = await treeDigest(repo);
  const out = await finish(repo, args);
  assert.equal(out.packet.status, 'blocked', out.text);
  assert.equal(out.exitCode, 1);
  for (const reason of reasons) assert.ok(blockersOf(out.packet).includes(reason), `${reason} in ${JSON.stringify(blockersOf(out.packet))}`);
  assert.deepEqual(T007(out.packet).sort(), [...blockersOf(out.packet)].sort(), 'one finding per blocker');
  assert.deepEqual(await treeDigest(repo), digest, 'nothing was written');
  return out;
};

test('a Plan with every gate satisfied closes (the baseline of every refusal below)', async (t) => {
  const repo = await closableWorld(t);
  const out = await finish(repo);
  assert.equal(out.exitCode, 0, out.text);
  assert.equal(out.packet.status, 'ok');
});

// ---- Roads ----------------------------------------------------------------------------------------------------------
test('every Road of the Plan must be DONE and verify; a Plan with no Road cannot close', async (t) => {
  const repo = await closableWorld(t);
  await seedRoad(repo, { id: 'R-P6-3', plan: 'P6' }, { folder: 'roads/P6', status: 'QUEUED' });
  const out = await refused(repo, ['road_not_done']);
  assert.deepEqual(out.packet.data.blockers.find(({ reason }) => reason === 'road_not_done'), { reason: 'road_not_done', subject: 'R-P6-3' });
  const edited = await repo.read('akrs/roads/P6/R-P6-1.json');
  await repo.write('akrs/roads/P6/R-P6-1.json', edited.replace('"status": "DONE"', '"status": "QUEUED"'));
  await refused(repo, ['road_unverified']);
});

// ---- the Tester pass ------------------------------------------------------------------------------------------------
test('a Plan with no Tester result, a fail, a blocked result or no contract is refused', async (t) => {
  const none = await ranWorld(t);
  await writePlan(none);
  await refused(none, ['tester_missing']);
  const failed = await ranWorld(t);
  await writePlan(failed);
  await flat(failed, 'fail', 'It broke.');
  await refused(failed, ['tester_failed']);
  const blocked = await ranWorld(t);
  await writePlan(blocked);
  await flat(blocked, 'blocked', 'Could not start.');
  await refused(blocked, ['tester_failed']);
  const bare = await ranWorld(t);
  await writePlan(bare);
  await rm(bare.path('akrs/verifications/P6/contract.json'));
  await refused(bare, ['tester_unverified']);
});

test('no stale pass is carried forward: a later product, SOT or contract change makes the pass stale and refuses the close', async (t) => {
  const sot = await closableWorld(t);
  await sot.write('SOT/10-budgets.md', 'frame budget 8ms\n');
  const out = await refused(sot, ['tester_stale']);
  assert.equal(out.packet.data.blockers.find(({ reason }) => reason === 'tester_stale').subject, (await ledger(sot))[0].id);
  const changed = await closableWorld(t);
  await redefine(changed, { acceptance: ['The flow is reachable end to end.', 'One more line.'] });
  await refused(changed, ['tester_stale']);
});

test('after the change a new run and a new pass close the Plan again; the old pass never does', async (t) => {
  const repo = await closableWorld(t);
  await repo.write('SOT/10-budgets.md', 'frame budget 8ms\n');
  await refused(repo, ['tester_stale']);
  assert.equal((await testRun(repo)).packet.data.run.status, 'passed');
  repo.run = (await details(repo)).packet.data.runs[0];
  const again = await flat(repo, 'pass', 'Still works after the budget change.');
  assert.equal(again.exitCode, 0, again.text);
  const out = await finish(repo);
  assert.equal(out.exitCode, 0, out.text);
});

test('an unrelated change does not stale the pass', async (t) => {
  const repo = await closableWorld(t);
  await repo.write('SOT/unrelated-notes.md', 'nothing the Plan depends on\n');
  const out = await finish(repo);
  assert.equal(out.exitCode, 0, out.text);
});

// ---- evidence, measurements and the run -----------------------------------------------------------------------------
test('the evidence of the pass must still be there and unchanged', async (t) => {
  const missing = await closableWorld(t);
  const [record] = await ledger(missing);
  await removeEvidenceFiles(missing, record.run);
  await refused(missing, ['evidence_missing']);
  const changed = await closableWorld(t);
  const [kept] = await ledger(changed);
  await writeFile(changed.path(kept.evidence[0].path), 'rewritten after the pass\n');
  await refused(changed, ['evidence_changed']);
});

test('the run the pass references must still exist and have passed', async (t) => {
  const repo = await closableWorld(t);
  const [record] = await ledger(repo);
  await rm(repo.path(`akrs/verifications/P6/evidence/${record.run}/run.json`));
  await refused(repo, ['run_missing']);
});

test('a stored pass that lacks a declared measurement, evidence type or is over budget is refused', async (t) => {
  const repo = await ranWorld(t, { contract: { policy: 'measured', evidence_types: ['log', 'screenshot'], measurements: [{ name: 'frame_time', unit: 'ms', budget: 16, direction: 'max' }] } });
  await writePlan(repo);
  const packet = (await details(repo)).packet;
  const base = { tested_snapshot: packet.data.tested_snapshot, contract_hash: packet.data.contract.hash, verdict: 'pass', user_acceptance: { answer: 'yes', because: 'Seeded.' }, run: repo.run.id };
  await seedResult(repo, 'P6', { ...base, n: 1, measurements: [], evidence: [] });
  await refused(repo, ['measurement_missing', 'evidence_type_missing']);
  await seedResult(repo, 'P6', { ...base, n: 2, measurements: [{ name: 'frame_time', value: 40, unit: 'ms', within_budget: false }], evidence: [] });
  await refused(repo, ['measurement_over_budget']);
});

// ---- findings, seams, questions -------------------------------------------------------------------------------------
test('an open Tester finding blocks the close until a later result resolves it', async (t) => {
  const repo = await ranWorld(t);
  await writePlan(repo);
  const evidence = { path: repo.run.path.replace(/run\.json$/, 'app.log'), type: 'log' };
  const fail = await full(repo, { verdict: 'fail', checks: [], measurements: [], evidence: [], findings: [{ id: 'F1', text: 'Save does nothing.', status: 'open' }], user_acceptance: { answer: 'no', because: 'Broken.' } });
  assert.equal(fail.exitCode, 0, fail.text);
  await refused(repo, ['finding_open', 'tester_failed']);
  const fixed = await full(repo, { verdict: 'pass', checks: [], measurements: [], evidence: [evidence], findings: [{ id: 'F1', text: 'Save does nothing.', status: 'resolved' }], user_acceptance: { answer: 'yes', because: 'Fixed.' } });
  assert.equal(fixed.exitCode, 0, fixed.text);
  const out = await finish(repo);
  assert.equal(out.exitCode, 0, out.text);
});

test('an open finding pointer written in the Plan file also blocks', async (t) => {
  const repo = await closableWorld(t, { plan: { findings: [{ result: '01ARZ3NDEKTSV4RRFFQ6000001', finding: 'F9', status: 'open' }] } });
  const out = await refused(repo, ['finding_open']);
  assert.equal(out.packet.data.blockers.find(({ reason }) => reason === 'finding_open').subject, '01ARZ3NDEKTSV4RRFFQ6000001:F9');
});

test('an unowned seam, a seam owned by a missing or unfinished Road, and an open question block; an owned seam and a wiring intent do not', async (t) => {
  const repo = await closableWorld(t, {
    plan: {
      seams: [
        { id: 'S1', text: 'Nobody owns this.', owner: null },
        { id: 'S2', text: 'Owned by a Road that does not exist.', owner: { road: 'R-GHOST', intent: null } },
        { id: 'S3', text: 'Owned by a DONE Road.', owner: { road: 'R-P6-1', intent: null } },
        { id: 'S4', text: 'Wired by a stated intent.', owner: { road: null, intent: 'wire the list in the page' } },
      ],
      questions: [{ id: 'Q1', text: 'Which currency?', status: 'open', resolution: null, decision: null }],
    },
  });
  const out = await refused(repo, ['seam_unowned', 'seam_owner_missing', 'question_open']);
  assert.deepEqual(out.packet.data.blockers.filter(({ reason }) => reason.startsWith('seam')).map(({ subject }) => subject).sort(), ['S1', 'S2']);
  assert.deepEqual(out.packet.data.blockers.find(({ reason }) => reason === 'question_open').subject, 'Q1');
  const unfinished = await closableWorld(t, { plan: { seams: [{ id: 'S5', text: 'Owned by a Road outside the Plan.', owner: { road: 'R-OTHER', intent: null } }] } });
  await seedRoad(unfinished, { id: 'R-OTHER', plan: null }, { folder: 'roads', status: 'ACTIVE' });
  const again = await refused(unfinished, ['seam_owner_not_done']);
  assert.equal(again.packet.data.blockers.find(({ reason }) => reason === 'seam_owner_not_done').subject, 'S5');
});

test('every failing condition is reported at once, not the first only', async (t) => {
  const repo = await ranWorld(t);
  await writePlan(repo, { seams: [{ id: 'S1', text: 'Nobody owns this.', owner: null }], questions: [{ id: 'Q1', text: 'Open?', status: 'open', resolution: null, decision: null }] });
  await seedRoad(repo, { id: 'R-P6-3', plan: 'P6' }, { folder: 'roads/P6', status: 'ACTIVE' });
  const out = await refused(repo, ['road_not_done', 'tester_missing', 'seam_unowned', 'question_open']);
  assert.ok(out.packet.data.blockers.length >= 4);
});

// ---- the Plan file --------------------------------------------------------------------------------------------------
test('a Plan without its file, with a hand-edited file or already closed is refused; a Road without a Plan is not a Plan', async (t) => {
  const repo = await ranWorld(t);
  await flat(repo, 'pass');
  await refused(repo, ['plan_unverified']); // the seeded Plan file of the road helpers is an input form, not a stored Plan
  await rm(repo.path(PLAN_PATH));
  await refused(repo, ['plan_file_missing']);
  await writePlan(repo, { closure: { status: 'closed', at: '2026-10-03T12:00:00.000Z', operation: { request: '01ARZ3NDEKTSV4RRFFQ6000001', run: '01ARZ3NDEKTSV4RRFFQ6000002' } } });
  await refused(repo, ['already_closed']);
  const noPlan = await finish(repo, [], { key: 'R-P6-1', snapshot: await snapshotOf(repo, 'R-P6-1') });
  assert.deepEqual([noPlan.packet.status, blockersOf(noPlan.packet)], ['blocked', ['not_a_plan']]);
  const unknown = await finish(repo, [], { key: 'P99', snapshot: await snapshotOf(repo, 'P99') });
  assert.deepEqual([unknown.packet.status, blockersOf(unknown.packet)], ['blocked', ['unknown_plan']]);
});

test('a results ledger that cannot be read blocks the close', async (t) => {
  const repo = await closableWorld(t);
  await writeFile(repo.path('akrs/verifications/P6/results.jsonl'), 'not a record\n');
  await refused(repo, ['ledger_unusable']);
});

test('the policy none contract needs no Tester pass; the other gates still apply', async (t) => {
  const repo = await ranWorld(t, worldOptions());
  await redefine(repo, { policy: 'none', launch: null, scenario: [], measurements: [], setup: [], teardown: [], evidence_types: [] });
  await writePlan(repo);
  const out = await finish(repo);
  assert.equal(out.exitCode, 0, out.text);
  assert.equal(out.packet.data.gate.tester, 'not_required');
});

// ---- request, role, snapshot, idempotency ---------------------------------------------------------------------------
test('a close needs --if-snapshot; a stale snapshot is blocked and nothing is written; a dry run needs none', async (t) => {
  const repo = await closableWorld(t);
  const digest = await treeDigest(repo);
  const missing = await finish(repo, [], { snapshot: null });
  assert.equal(missing.exitCode, 2, missing.text);
  const stale = await finish(repo, [], { snapshot: `sha256:${'0'.repeat(64)}` });
  assert.equal(stale.packet.status, 'blocked');
  assert.ok(stale.packet.findings.some(({ code }) => code === 'AKRS-C013'));
  const dry = await finish(repo, ['--dry-run'], { snapshot: null });
  assert.equal(dry.exitCode, 0, dry.text);
  assert.equal(dry.packet.data.dry_run, true);
  assert.deepEqual(dry.packet.data.would_change.sort(), ['log/0001.jsonl', 'plans/P6.json'].sort());
  assert.ok(dry.packet.next_commands.some(({ command, args }) => command === 'plan-finish' && args.includes('--if-snapshot')));
  assert.deepEqual(await treeDigest(repo), digest);
});

test('a dry run on a Plan that cannot close lists the blockers and writes nothing', async (t) => {
  const repo = await ranWorld(t);
  await writePlan(repo);
  const digest = await treeDigest(repo);
  const dry = await finish(repo, ['--dry-run'], { snapshot: null });
  assert.equal(dry.packet.status, 'blocked');
  assert.ok(blockersOf(dry.packet).includes('tester_missing'));
  assert.deepEqual(await treeDigest(repo), digest);
  assert.equal((await snapshotOf(repo)).startsWith('sha256:'), true);
  assert.equal((await closures(repo)).length, 0);
});
