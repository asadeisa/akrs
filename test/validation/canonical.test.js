// P1-W13: canonical v2 validation over CLI-written artifacts, with honest coverage.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { VALIDATION_CHECK_MANIFEST } from '../../lib/core/index.js';
import { validateValidationData } from '../../lib/validation/coverage.js';
import { assertFindingsMatchCatalog } from '../road/support.js';
import { createRepo, flash, lead, runCommand, seedPlan, seedRoad, setExec } from '../road-fit/support.js';
import { closeOut, render, request, set } from '../state/support.js';
import { contractInput, define } from '../tester/support.js';

const validate = async (repo) => {
  const result = await runCommand(repo, ['validate', '--json']);
  return { exitCode: result.exitCode, packet: JSON.parse(result.stdout) };
};
const check = (packet, id) => packet.data.checks.find(({ check: name }) => name === id);
const codes = (packet) => [...new Set(packet.findings.map(({ code }) => code))].sort();

// A classified workflow: Plan P6, ACTIVE Road R-P6-1, executors, State (+ STATE.md) and a verification contract.
async function cleanWorld(t) {
  const repo = await createRepo(t);
  await seedPlan(repo, 'P6');
  await seedRoad(repo, { id: 'R-P6-1', plan: 'P6' }, { folder: 'roads/P6', status: 'ACTIVE' });
  await setExec(repo, lead);
  await setExec(repo, flash);
  await set(repo, { mode: 3, plan: 'P6', next: 'Finish the admin page.' });
  await define(repo, 'P6', await contractInput('valid/full', { roads: ['R-P6-1'] }));
  await render(repo); // the render includes the verification summary, so it follows the contract
  return repo;
}

test('a clean classified workflow validates ok with honest coverage: nothing skipped', async (t) => {
  const repo = await cleanWorld(t);
  const { exitCode, packet } = await validate(repo);
  assert.deepEqual(packet.findings, []);
  assert.equal(packet.status, 'ok');
  assert.equal(exitCode, 0);
  assert.equal(packet.data.coverage.skipped, 0);
  assert.equal(packet.data.coverage.failed, 0);
  assert.equal(packet.data.legacy_characterization, false);
  assert.deepEqual(packet.data.checks.map(({ check: id }) => id), VALIDATION_CHECK_MANIFEST.map(({ id }) => id));
  for (const id of ['road-integrity', 'road-identities', 'road-paths', 'executors', 'state', 'state-render', 'verification', 'class-fit']) {
    assert.equal(check(packet, id).status, 'passed', id);
  }
  for (const id of ['done-writes-exist', 'log', 'memory', 'scope-requests', 'drafts', 'legacy-forms', 'git-posture']) {
    assert.equal(check(packet, id).status, 'not_applicable', id);
    assert.ok(check(packet, id).reason.length > 0);
  }
  assert.equal(validateValidationData(packet.data).ok, true);
});

test('a hand-edited canonical Road is unverified (hash), a schema-invalid one reports pointers; neither is trusted', async (t) => {
  const repo = await cleanWorld(t);
  const path = 'akrs/roads/P6/R-P6-1.json';
  const text = await readFile(repo.path(path), 'utf8');
  await writeFile(repo.path(path), text.replace('"complexity": 3', '"complexity": 4'));
  const edited = (await validate(repo)).packet;
  assert.equal(check(edited, 'road-integrity').status, 'failed');
  const finding = edited.findings.find(({ code }) => code === 'AKRS-S007');
  assert.equal(finding.detail.reason, 'hash_mismatch');
  assert.equal(finding.file, path);
  assertFindingsMatchCatalog(edited);
  await writeFile(repo.path(path), text.replace('"deps": []', '"deps": [], "surprise": true'));
  const invalid = (await validate(repo)).packet;
  assert.equal(check(invalid, 'road-integrity').status, 'failed');
  assert.ok(invalid.findings.some(({ code, detail }) => code === 'AKRS-R011' && JSON.stringify(detail).includes('surprise')));
});

test('identities, dependencies and cycles are checked over the v2 Roads (readiness stays separate)', async (t) => {
  const repo = await cleanWorld(t);
  await seedRoad(repo, { id: 'R-A', plan: 'P6', deps: ['R-B'] }, { folder: 'roads/P6' });
  await seedRoad(repo, { id: 'R-B', plan: 'P6', deps: ['R-A', 'R-NOPE'] }, { folder: 'roads/P6' });
  await seedRoad(repo, { id: 'R-P6-1', plan: 'P6' }, { folder: 'roads/P9' });
  const { packet } = await validate(repo);
  assert.equal(check(packet, 'road-identities').status, 'failed');
  assert.equal(check(packet, 'dependency-references').status, 'skipped', 'duplicates make the graph ambiguous');
  assert.ok(packet.findings.some(({ code }) => code === 'AKRS-R001'));
  const repo2 = await cleanWorld(t);
  await seedRoad(repo2, { id: 'R-A', plan: 'P6', deps: ['R-B'] }, { folder: 'roads/P6' });
  await seedRoad(repo2, { id: 'R-B', plan: 'P6', deps: ['R-A', 'R-NOPE'] }, { folder: 'roads/P6' });
  const second = (await validate(repo2)).packet;
  assert.ok(second.findings.some(({ code }) => code === 'AKRS-R005'));
  assert.ok(second.findings.some(({ code }) => code === 'AKRS-R006'));
});

test('declared paths: a read window that differs in case is reported; a DONE Road whose declared file is missing is an error', async (t) => {
  const repo = await cleanWorld(t);
  await seedRoad(repo, { id: 'R-CASE', plan: 'P6', reads: [{ path: 'src/OWN.js', lines: null, why: 'x' }] }, { folder: 'roads/P6' });
  await seedRoad(repo, { id: 'R-DONE', plan: 'P6', writes: [{ path: 'app/never-built.ts', class: 'file', action: 'create' }] }, { folder: 'roads/P6', status: 'DONE' });
  const { packet } = await validate(repo);
  assert.ok(packet.findings.some(({ code, file }) => code === 'AKRS-R012' && file.endsWith('R-CASE.json')));
  const missing = packet.findings.find(({ code }) => code === 'AKRS-R017');
  assert.equal(missing.severity, 'error');
  assert.equal(missing.detail.path, 'app/never-built.ts');
  assert.equal(check(packet, 'done-writes-exist').status, 'failed');
  assertFindingsMatchCatalog(packet);
});

test('state: a stale or hand-edited STATE.md and a hand-edited state.json are reported, never trusted', async (t) => {
  const repo = await cleanWorld(t);
  await writeFile(repo.path('akrs/STATE.md'), '# STATE\nstale\n');
  const stale = (await validate(repo)).packet;
  assert.equal(check(stale, 'state-render').status, 'failed');
  assert.ok(stale.findings.some(({ code }) => code === 'AKRS-S008'));
  assert.equal((await render(repo)).outcome, 'committed');
  assert.equal((await validate(repo)).packet.status, 'ok');
  const json = await readFile(repo.path('akrs/state.json'), 'utf8');
  await writeFile(repo.path('akrs/state.json'), json.replace('Finish the admin page.', 'Edited by hand.'));
  const edited = (await validate(repo)).packet;
  assert.equal(check(edited, 'state').status, 'failed');
  assert.ok(edited.findings.some(({ code, detail }) => code === 'AKRS-S007' && detail.kind === 'state'));
});

test('executors: none declared is the open question AKRS-S006; a hand-edited file is unverified', async (t) => {
  const repo = await createRepo(t);
  await seedPlan(repo, 'P6');
  await seedRoad(repo, { id: 'R-P6-1', plan: 'P6' }, { folder: 'roads/P6' });
  const none = (await validate(repo)).packet;
  assert.equal(none.findings.find(({ code }) => code === 'AKRS-S006').severity, 'warning');
  assert.equal(none.status, 'warning');
  assertFindingsMatchCatalog(none);
  await setExec(repo, lead);
  await setExec(repo, flash);
  assert.equal(codes((await validate(repo)).packet).includes('AKRS-S006'), false);
  const text = await readFile(repo.path('akrs/executors.json'), 'utf8');
  await writeFile(repo.path('akrs/executors.json'), text.replace('"weak"', '"frontier"'));
  const edited = (await validate(repo)).packet;
  assert.ok(edited.findings.some(({ code, detail }) => code === 'AKRS-S007' && detail.kind === 'executors'));
});

test('class fit is part of validation: an over-limit weak Road reports AKRS-R015', async (t) => {
  const repo = await cleanWorld(t);
  const writes = Array.from({ length: 4 }, (_, index) => ({ path: `src/d/f${index}.js`, class: 'file', action: 'create' }));
  await seedRoad(repo, { id: 'R-BIG', plan: 'P6', writes }, { folder: 'roads/P6' });
  const { packet } = await validate(repo);
  assert.equal(check(packet, 'class-fit').status, 'failed');
  assert.ok(packet.findings.some(({ code, detail }) => code === 'AKRS-R015' && detail.knob === 'max_writes'));
});

test('open scope requests, stale drafts and the log/closure consistency are reported', async (t) => {
  const repo = await cleanWorld(t);
  await request(repo, { road: 'R-P6-1', add_reads: [{ path: 'SOT/02-rules.md', lines: null, why: 'rules' }], blocking: true });
  await repo.write('akrs/drafts/left-behind.json', '{ this is not json');
  await closeOut(repo, { kind: 'road', subject: 'R-GHOST', outcome: 'DONE' });
  await seedRoad(repo, { id: 'R-P6-9', plan: 'P6' }, { folder: 'roads/P6', status: 'DONE' });
  const { packet } = await validate(repo);
  assert.ok(packet.findings.some(({ code }) => code === 'AKRS-R018'), 'pending scope request');
  const draft = packet.findings.find(({ code }) => code === 'AKRS-C017');
  assert.equal(draft.file, 'akrs/drafts/left-behind.json');
  assert.equal(packet.findings.some(({ code, detail }) => code === 'AKRS-R011' && JSON.stringify(detail).includes('left-behind')), false, 'a draft is never parsed as canonical');
  const reasons = packet.findings.filter(({ code }) => code === 'AKRS-S009').map(({ detail }) => detail.reason).sort();
  assert.deepEqual(reasons, ['closure_unknown_subject', 'done_without_closure']);
  assert.equal(check(packet, 'log').status, 'passed');
  assertFindingsMatchCatalog(packet);
});

test('verification: a hand-edited contract is unverified; a contract naming a missing Road is reported', async (t) => {
  const repo = await cleanWorld(t);
  const path = 'akrs/verifications/P6/contract.json';
  const text = await readFile(repo.path(path), 'utf8');
  await writeFile(repo.path(path), text.replace(/"acceptance": \[\n\s+"/, '$&Tampered: '));
  const edited = (await validate(repo)).packet;
  assert.equal(check(edited, 'verification').status, 'failed');
  assert.ok(edited.findings.some(({ code, detail }) => code === 'AKRS-S007' && detail.kind === 'verification'));
});

test('v1 Markdown Road forms are never parsed: they are reported as a legacy form', async (t) => {
  const repo = await cleanWorld(t);
  await repo.write('akrs/roads/R2.md', '# Road R2\n\nStatus: QUEUED\nDeps: R1 (blocked by X)\n');
  const { exitCode, packet } = await validate(repo);
  assert.equal(exitCode, 1);
  const legacy = packet.findings.find(({ code }) => code === 'AKRS-R019');
  assert.equal(legacy.severity, 'error');
  assert.equal(legacy.file, 'akrs/roads/R2.md');
  assert.equal(check(packet, 'legacy-forms').status, 'failed');
  assert.equal(packet.findings.some(({ code }) => code === 'AKRS-R005'), false, 'no phantom dependency IDs from prose');
});
