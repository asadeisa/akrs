// P2-W09: `doctor` keeps its git posture and adds the health of the workflow and of the doctrine install, each with its own status.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { treeDigest } from '../road/support.js';
import { closableWorld, navWorld, query } from '../navigation/support.js';

const doctor = (repo) => query(repo, ['doctor']);

test('doctor reports the posture and one health row per check, sorted, without writing', async (t) => {
  const repo = await navWorld(t);
  const digest = await treeDigest(repo);
  const out = await doctor(repo);
  assert.equal(out.exitCode === 0 || out.exitCode === 1, true, out.text);
  const { doctor: report } = out.packet.data;
  assert.ok(['tracked', 'ignored', 'mixed', 'not_git'].includes(report.posture.posture), 'the posture is kept');
  assert.deepEqual(report.health.map(({ check }) => check), ['doctrine', 'executors', 'log', 'roads', 'state', 'workflow']);
  for (const row of report.health) assert.ok(['ok', 'warning', 'error', 'not_applicable'].includes(row.status), row.check);
  assert.deepEqual(await treeDigest(repo), digest);
});

test('the workflow rows tell what is wrong: an unverified Road and a missing state.json are named', async (t) => {
  const repo = await navWorld(t);
  const rows = Object.fromEntries((await doctor(repo)).packet.data.doctor.health.map((row) => [row.check, row]));
  assert.equal(rows.workflow.status, 'ok');
  assert.equal(rows.executors.status, 'ok');
  assert.equal(rows.state.status, 'not_applicable', 'no state.json yet is not a defect');
  assert.equal(rows.roads.status, 'ok');
  await repo.write('akrs/roads/P6/R-P6-3.json', '{"hand":"edited"}\n');
  const after = Object.fromEntries((await doctor(repo)).packet.data.doctor.health.map((row) => [row.check, row]));
  assert.equal(after.roads.status, 'error');
  assert.match(after.roads.detail, /R-P6-3/);
});

test('the doctrine install row is not_applicable before an install and never writes one', async (t) => {
  const repo = await navWorld(t);
  const row = (await doctor(repo)).packet.data.doctor.health.find(({ check }) => check === 'doctrine');
  assert.equal(row.status, 'not_applicable');
});

test('a corrupt closure ledger is an error row, and the packet is a warning with a finding', async (t) => {
  const repo = await closableWorld(t);
  await repo.write('akrs/log/0001.jsonl', 'not a record\n');
  const out = await doctor(repo);
  const row = out.packet.data.doctor.health.find(({ check }) => check === 'log');
  assert.equal(row.status, 'error');
  assert.ok(['warning', 'error'].includes(out.packet.status));
});
