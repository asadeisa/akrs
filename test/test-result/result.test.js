// P2-W07: `test result` records one structured result bound to the exact tested snapshot and contract hash. The CLI fills
// plan, tested snapshot, contract hash and run; the Tester never types a hash.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RESULT_SPEC, validateResult } from '../../lib/schemas/handoff-result.js';
import { decodeJsonl } from '../../lib/store/canonical/index.js';
import { treeDigest } from '../road/support.js';
import { RESULTS, acceptance, details, flat, full, ledger, ranWorld, reasonsOf, redefine, result, runWorld, worldOptions } from './support.js';

test('a flat pass after a passing run records the exact tested snapshot, contract hash, run and the run evidence', async (t) => {
  const repo = await ranWorld(t);
  const packet = (await details(repo)).packet;
  const done = await flat(repo, 'pass');
  assert.equal(done.exitCode, 0, done.text);
  assert.deepEqual(done.packet.findings, []);
  assert.deepEqual([done.packet.status, done.packet.data.kind, done.packet.data.plan], ['ok', 'test_result', 'P6']);
  const [record] = await ledger(repo);
  assert.equal(validateResult(record, { form: 'stored', workflowRoot: 'akrs' }).ok, true);
  assert.deepEqual(
    [record.plan, record.verdict, record.tested_snapshot, record.contract_hash, record.run],
    ['P6', 'pass', packet.data.tested_snapshot, packet.data.contract.hash, repo.run.id],
  );
  assert.deepEqual(record.user_acceptance, { answer: 'yes', because: 'The reservation flow works end to end.' });
  assert.deepEqual([record.checks, record.measurements, record.findings], [[], [], []]);
  assert.deepEqual(record.evidence.map(({ type }) => type), ['log']);
  assert.match(record.evidence[0].sha256, /^sha256:[0-9a-f]{64}$/);
  assert.ok(record.evidence[0].bytes > 0);
  assert.equal(record.evidence[0].path.startsWith(`akrs/verifications/P6/evidence/${repo.run.id}/`), true);
  const decoded = decodeJsonl(await repo.read(RESULTS), () => RESULT_SPEC);
  assert.deepEqual([decoded.issues, decoded.records.length], [[], 1]);
  assert.deepEqual(done.packet.data.result, {
    id: record.id, path: RESULTS, line: 1, verdict: 'pass', tested_snapshot: record.tested_snapshot, contract_hash: record.contract_hash, run: repo.run.id, hash: record.hash, counts: { checks: 0, measurements: 0, evidence: 1, findings: 0 },
  });
  assert.deepEqual(done.packet.changed, ['verifications/P6/results.jsonl']);
  assert.deepEqual(done.packet.next_commands.map(({ command }) => command), ['test-details']);
});

test('a flat fail and a flat blocked carry acceptance no, the same identity and no invented finding', async (t) => {
  const repo = await ranWorld(t);
  for (const verdict of ['fail', 'blocked']) {
    const done = await flat(repo, verdict, `The ${verdict} reason.`);
    assert.equal(done.exitCode, 0, done.text);
    assert.equal(done.packet.data.result.verdict, verdict);
  }
  const records = await ledger(repo);
  assert.deepEqual(records.map(({ verdict }) => verdict), ['fail', 'blocked']);
  for (const record of records) {
    assert.deepEqual(record.user_acceptance.answer, 'no');
    assert.deepEqual(record.findings, []);
    assert.equal(record.run, repo.run.id);
  }
});

test('the flat form needs a verdict and a reason; a verdict outside pass, fail, blocked is a usage error and nothing is written', async (t) => {
  const repo = await ranWorld(t);
  const digest = await treeDigest(repo);
  for (const args of [[], ['--verdict', 'pass'], ['--because', 'why'], ['--verdict', 'maybe', '--because', 'why'], ['--verdict', 'PASS', '--because', 'why'], ['--verdict', 'pass', '--because', '']]) {
    const out = await result(repo, args);
    assert.equal(out.exitCode, 2, `${args.join(' ')}: ${out.text}`);
  }
  assert.deepEqual(await treeDigest(repo), digest);
});

test('two input channels are a usage error', async (t) => {
  const repo = await ranWorld(t);
  const digest = await treeDigest(repo);
  const out = await result(repo, ['--json', '-', '--verdict', 'pass', '--because', 'x'], { stdin: JSON.stringify({ schema: 'akrs.result/v1' }) });
  assert.equal(out.exitCode, 2);
  assert.equal(out.packet.data.reason, 'two_input_channels');
  assert.deepEqual(await treeDigest(repo), digest);
});

test('the full JSON form validates against the closed schema: a typed hash, snapshot, plan or run is an unknown key', async (t) => {
  const repo = await ranWorld(t);
  const digest = await treeDigest(repo);
  const base = { verdict: 'fail', checks: [], measurements: [], evidence: [], findings: [{ id: 'F1', text: 'Save does nothing.', status: 'open' }], user_acceptance: acceptance('no') };
  for (const extra of [{ tested_snapshot: `sha256:${'a'.repeat(64)}` }, { contract_hash: `sha256:${'a'.repeat(64)}` }, { plan: 'P6' }, { run: '01ARZ3NDEKTSV4RRFFQ6000001' }, { id: '01ARZ3NDEKTSV4RRFFQ6000001' }, { hash: `sha256:${'a'.repeat(64)}` }]) {
    const out = await full(repo, { ...base, ...extra });
    assert.equal(out.exitCode, 2, JSON.stringify(Object.keys(extra)));
    assert.ok(out.packet.findings.some(({ code }) => code === 'AKRS-T001'), 'a schema finding');
  }
  assert.deepEqual(await treeDigest(repo), digest);
  const ok = await full(repo, base);
  assert.equal(ok.exitCode, 0, ok.text);
  const [record] = await ledger(repo);
  assert.deepEqual(record.findings, [{ id: 'F1', text: 'Save does nothing.', status: 'open' }]);
  assert.equal(record.run, repo.run.id, 'the CLI fills the run reference');
});

test('a result is appended in order and never rewrites an earlier record', async (t) => {
  const repo = await ranWorld(t);
  await flat(repo, 'fail', 'First attempt.');
  const first = await repo.read(RESULTS);
  await flat(repo, 'pass', 'Second attempt.');
  const second = await repo.read(RESULTS);
  assert.equal(second.startsWith(first), true);
  assert.equal(second.split('\n').filter(Boolean).length, 2);
});

test('an identical document is a noop that offers --again; --again appends a deliberate duplicate', async (t) => {
  const repo = await ranWorld(t);
  assert.equal((await flat(repo, 'pass')).packet.status, 'ok');
  const again = await flat(repo, 'pass');
  assert.equal(again.packet.status, 'noop');
  assert.equal((await ledger(repo)).length, 1);
  assert.ok(again.packet.next_commands.some(({ args }) => args.includes('--again')), 'the retry offers --again');
  const forced = await flat(repo, 'pass', undefined, ['--again']);
  assert.equal(forced.packet.status, 'ok');
  assert.equal((await ledger(repo)).length, 2);
});

test('a retry with the same request ID is replayed and two concurrent requests with one ID append exactly once', async (t) => {
  const repo = await ranWorld(t);
  const id = '01ARZ3NDEKTSV4RRFFQ6900001';
  const outs = await Promise.all([flat(repo, 'pass', undefined, ['--request-id', id]), flat(repo, 'pass', undefined, ['--request-id', id])]);
  const retried = await flat(repo, 'pass', undefined, ['--request-id', id]);
  assert.equal((await ledger(repo)).length, 1, JSON.stringify(outs.map(({ packet }) => packet.status)));
  assert.equal(retried.packet.status, 'noop');
  assert.equal(outs.filter(({ packet }) => packet.status === 'ok').length, 1);
});

test('a dry run reports what would change and writes nothing', async (t) => {
  const repo = await ranWorld(t);
  const digest = await treeDigest(repo);
  const out = await flat(repo, 'pass', undefined, ['--dry-run']);
  assert.equal(out.exitCode, 0, out.text);
  assert.equal(out.packet.data.dry_run, true);
  assert.deepEqual(out.packet.data.would_change, ['verifications/P6/results.jsonl']);
  assert.deepEqual(await treeDigest(repo), digest);
});

test('an explicit --if-snapshot that no longer matches is blocked and writes nothing', async (t) => {
  const repo = await ranWorld(t);
  const digest = await treeDigest(repo);
  const out = await flat(repo, 'pass', undefined, ['--if-snapshot', `sha256:${'0'.repeat(64)}`]);
  assert.equal(out.packet.status, 'blocked');
  assert.ok(out.packet.findings.some(({ code }) => code === 'AKRS-C013'));
  assert.deepEqual(await treeDigest(repo), digest);
});

test('a malformed Plan ID is a usage error and a Plan that does not exist is refused with unknown_plan; nothing is written', async (t) => {
  const repo = await ranWorld(t);
  const digest = await treeDigest(repo);
  assert.equal((await result(repo, ['--verdict', 'pass', '--because', 'x'], { key: 'not a plan' })).exitCode, 2);
  const unknown = await result(repo, ['--verdict', 'pass', '--because', 'x'], { key: 'P99' });
  assert.deepEqual([unknown.packet.status, reasonsOf(unknown.packet)], ['blocked', ['unknown_plan']]);
  assert.deepEqual(await treeDigest(repo), digest);
});

test('a result is not a verdict on the Plan: it never claims closure and offers no plan finish', async (t) => {
  const repo = await ranWorld(t);
  const done = await flat(repo, 'pass');
  assert.equal(JSON.stringify(done.packet).includes('plan-finish'), false);
  assert.equal(JSON.stringify(done.packet.next_commands).includes('closed'), false);
});

test('the policy none contract needs no Tester pass, so a result is refused', async (t) => {
  const repo = await runWorld(t, worldOptions());
  await redefine(repo, { policy: 'none', launch: null, scenario: [], measurements: [], setup: [], teardown: [], evidence_types: [] });
  const digest = await treeDigest(repo);
  const out = await flat(repo, 'pass');
  assert.deepEqual([out.packet.status, reasonsOf(out.packet)], ['blocked', ['policy_none']]);
  assert.deepEqual(await treeDigest(repo), digest);
});
