// P1-W05: the coordinator end to end, in process: every operation type, the journal and packet it produces, the
// snapshot contract, replay, dry runs and every way a request is rejected before anything is staged.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';
import { createPacket } from '../../lib/core/packet.js';
import { normalizeAbsolutePath } from '../../lib/core/roots.js';
import { readOp } from '../../lib/store/journal/index.js';
import { readLockOwner } from '../../lib/store/lock/index.js';
import { WORKFLOW_PROJECTION, computeSnapshot } from '../../lib/store/snapshots/index.js';
import { runTransactionalMutation } from '../../lib/store/transactions/index.js';
import {
  SCENARIOS,
  SCENARIO_REQUEST_ID,
  UNRELATED,
  commandSnapshotFor,
  createTxWorkflow,
  journalStates,
  pendingMarkers,
  runScenario,
  scenarioOptions,
  treeDigest,
  txDirectories,
  ulid,
} from './support.js';

const read = (workflow, path) => readFile(workflow.path('akrs', path), 'utf8');
const exists = async (path) => stat(path).then(() => true, () => false);

async function expectedBytes(workflow, operation) {
  if (operation.type === 'append') return `${workflow.files[`akrs/${operation.path}`]}${operation.content}`;
  return operation.content;
}

test('every scenario commits atomically and leaves no scratch behind', async (t) => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    const workflow = await createTxWorkflow(t);
    const before = await commandSnapshotFor(workflow, scenario);
    const { result, calls } = await runScenario(workflow, scenario);
    assert.equal(result.outcome, 'committed', name);
    assert.equal(result.packet.status, 'ok', name);
    assert.equal(calls.render, 1);
    for (const operation of scenario.operations) {
      if (operation.type === 'delete') {
        assert.equal(await exists(workflow.path('akrs', operation.path)), false, `${name}: ${operation.path} deleted`);
      } else if (operation.type === 'move') {
        assert.equal(await exists(workflow.path('akrs', operation.path)), false, `${name}: source gone`);
        assert.equal(await read(workflow, operation.to), workflow.files[`akrs/${operation.path}`], `${name}: bytes moved intact`);
      } else {
        assert.equal(await read(workflow, operation.path), await expectedBytes(workflow, operation), `${name}: ${operation.path}`);
      }
    }
    assert.deepEqual(await txDirectories(workflow), [], `${name}: transaction directory removed`);
    assert.deepEqual(await pendingMarkers(workflow), [], `${name}: pending marker removed`);
    assert.equal((await readLockOwner(workflow.options)).status, 'absent', `${name}: lock released`);
    assert.deepEqual(await journalStates(workflow, SCENARIO_REQUEST_ID), ['prepared', 'committed']);

    const { records, committed } = await readOp({ ...workflow.options, requestId: SCENARIO_REQUEST_ID });
    assert.match(result.transaction, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, 'the result names the transaction');
    assert.equal(records[0].transaction, result.transaction, 'the prepared record carries the transaction ID');
    assert.equal(committed.transaction, result.transaction);
    assert.equal(committed.before, before);
    const after = await commandSnapshotFor(workflow, scenario);
    assert.equal(result.packet.snapshot.before, before, `${name}: snapshot.before`);
    assert.equal(result.packet.snapshot.after, after, `${name}: snapshot.after equals a fresh computeSnapshot of the command row`);
    assert.equal(committed.after, after);
    assert.notEqual(before, after, `${name}: the command row really changed`);
    assert.equal(result.packet.request_id, SCENARIO_REQUEST_ID);
    assert.equal(result.packet.command, scenario.command);
    assert.deepEqual(committed.packet, result.packet, 'the journal stores the packet that was returned');
  }
});

test('packet.changed lists the touched workflow-relative paths, and the render may name its own', async (t) => {
  const workflow = await createTxWorkflow(t);
  const { result } = await runScenario(workflow, SCENARIOS.move);
  assert.deepEqual(result.packet.changed, ['roads/R9.json', 'roads/archive/R9.json']);

  const multi = await runScenario(await createTxWorkflow(t), SCENARIOS.multi);
  assert.deepEqual(multi.result.packet.changed, [
    'drafts/road-R3.json', 'log/0001.jsonl', 'roads/R1.json', 'verifications/P1/handoff.jsonl',
  ]);

  const explicit = await runScenario(await createTxWorkflow(t), SCENARIOS.create, {
    render: () => ({
      operations: SCENARIOS.create.operations.map((operation) => ({ ...operation })),
      packet: { data: { kind: 'x' }, changed: ['memory/topics/new.md', 'drafts/from-input.json'] },
    }),
  });
  assert.deepEqual(explicit.result.packet.changed, ['drafts/from-input.json', 'memory/topics/new.md']);
});

test('binary and CRLF contents are written byte for byte', async (t) => {
  const workflow = await createTxWorkflow(t);
  const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80, 0x7f, 0x0a]);
  const text = 'line one\r\nline two\r\n';
  const { result } = await runScenario(workflow, UNRELATED, {
    render: () => ({
      operations: [
        { type: 'create', path: 'memory/binary.bin', content: bytes },
        { type: 'create', path: 'memory/crlf.md', content: text },
      ],
      packet: { data: { kind: 'x' } },
    }),
  });
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(await readFile(workflow.path('akrs', 'memory', 'binary.bin')), bytes);
  assert.equal(await read(workflow, 'memory/crlf.md'), text);
});

test('an append keeps the existing bytes as an exact prefix', async (t) => {
  const workflow = await createTxWorkflow(t);
  const old = await readFile(workflow.path('akrs', 'log', '0001.jsonl'));
  await runScenario(workflow, SCENARIOS.append);
  const now = await readFile(workflow.path('akrs', 'log', '0001.jsonl'));
  assert.deepEqual(now.subarray(0, old.length), old);
  assert.equal(now.subarray(old.length).toString('utf8'), SCENARIOS.append.operations[0].content);
});

test('replaying a committed request is a noop that stages nothing and never renders again', async (t) => {
  const workflow = await createTxWorkflow(t);
  const first = await runScenario(workflow, SCENARIOS.multi);
  const tree = await treeDigest(workflow);
  const again = await runScenario(workflow, SCENARIOS.multi);
  assert.equal(again.result.outcome, 'replayed');
  assert.equal(again.result.packet.status, 'noop');
  assert.equal(again.result.packet.request_id, first.result.packet.request_id);
  assert.equal(again.calls.render, 0);
  assert.equal(await treeDigest(workflow), tree);
  assert.deepEqual(await txDirectories(workflow), []);
});

test('a dry run renders and validates but writes nothing, and reports the plan', async (t) => {
  const workflow = await createTxWorkflow(t);
  const tree = await treeDigest(workflow);
  const { result, calls } = await runScenario(workflow, SCENARIOS.multi, { dryRun: true, requestId: undefined });
  assert.equal(result.outcome, 'dry_run');
  assert.equal(calls.render, 1);
  assert.deepEqual(result.plan.map(({ index, type, path, to }) => ({ index, type, path, to })), [
    { index: 0, type: 'append', path: 'verifications/P1/handoff.jsonl', to: null },
    { index: 1, type: 'replace', path: 'roads/R1.json', to: null },
    { index: 2, type: 'append', path: 'log/0001.jsonl', to: null },
    { index: 3, type: 'delete', path: 'drafts/road-R3.json', to: null },
  ]);
  assert.equal(await treeDigest(workflow), tree);
  assert.deepEqual(await txDirectories(workflow), []);
  assert.equal(await journalStates(workflow, SCENARIO_REQUEST_ID), null);

  const invalid = await runScenario(workflow, SCENARIOS.create, {
    dryRun: true,
    requestId: undefined,
    render: () => ({ operations: [{ type: 'create', path: '../escape.md', content: 'x' }], packet: { data: { kind: 'x' } } }),
  });
  assert.equal(invalid.result.outcome, 'rejected', 'a dry run also rejects an unsafe target');
});

test('authorize, validate and a stale expected snapshot reject before anything is staged', async (t) => {
  const workflow = await createTxWorkflow(t);
  const tree = await treeDigest(workflow);
  const root = normalizeAbsolutePath(workflow.root);
  const reject = (status) => ({
    packet: createPacket({
      command: 'memory-add', status, root, snapshot: { before: null, after: null }, data: { kind: 'rejected' },
      findings: [{ code: 'AKRS-C001', severity: 'error', message: 'no', file: null, line: null, detail: { reason: 'no' } }],
    }),
  });

  const denied = await runScenario(workflow, SCENARIOS.create, { authorize: () => reject('blocked') });
  assert.equal(denied.result.outcome, 'rejected');
  assert.equal(denied.calls.render, 0, 'render never runs for an unauthorized request');

  const invalid = await runScenario(workflow, SCENARIOS.create, { validate: () => reject('error') });
  assert.equal(invalid.result.outcome, 'rejected');
  assert.equal(invalid.calls.render, 0);

  const stale = await runScenario(workflow, SCENARIOS.create, { expectedSnapshot: `sha256:${'0'.repeat(64)}` });
  assert.equal(stale.result.outcome, 'stale');
  assert.equal(stale.calls.render, 0);

  const rendered = await runScenario(workflow, SCENARIOS.create, { render: () => ({ rejection: reject('error') }) });
  assert.equal(rendered.result.outcome, 'rejected', 'the render can reject the proposed tree');
  assert.equal(rendered.result.packet.status, 'error');

  assert.equal(await treeDigest(workflow), tree);
  assert.deepEqual(await txDirectories(workflow), []);
  assert.equal(await journalStates(workflow, SCENARIO_REQUEST_ID), null, 'rejections consume no request ID');
});

test('the render must hand back a usable result', async (t) => {
  const workflow = await createTxWorkflow(t);
  const bad = async (render, pattern) => {
    await assert.rejects(runScenario(workflow, SCENARIOS.create, { render }), pattern);
    assert.deepEqual(await txDirectories(workflow), []);
  };
  await bad(() => null, TypeError);
  await bad(() => ({ operations: [], packet: { data: {} } }), /operations/);
  await bad(() => ({ operations: [{ type: 'create', path: 'memory/a.md', content: 'x' }] }), TypeError);
  await bad(() => ({ operations: [{ type: 'create', path: 'memory/a.md', content: 'x' }], packet: { status: 'error', data: {} } }), /status/);
  await bad(() => ({ operations: 'x', packet: { data: {} } }), TypeError);
  assert.equal((await readLockOwner(workflow.options)).status, 'absent');
});

test('the coordinator refuses missing or mistyped options as programming errors', async (t) => {
  const workflow = await createTxWorkflow(t);
  const base = scenarioOptions(workflow.options, SCENARIOS.create);
  await assert.rejects(runTransactionalMutation({ ...base, render: undefined }), TypeError);
  await assert.rejects(runTransactionalMutation({ ...base, boundary: 'nope' }), TypeError);
  await assert.rejects(runTransactionalMutation({ ...base, workflowRoot: undefined }), TypeError);
  await assert.rejects(runTransactionalMutation({ ...base, command: undefined }), TypeError);
});

test('scratch under .ops/tx never changes any snapshot', async (t) => {
  const workflow = await createTxWorkflow(t);
  const snapshots = async () => {
    const out = {};
    out.workflow = (await computeSnapshot({ ...workflow.options, projections: WORKFLOW_PROJECTION })).snapshot;
    for (const scenario of Object.values(SCENARIOS)) out[scenario.command] = await commandSnapshotFor(workflow, scenario);
    return out;
  };
  const before = await snapshots();
  let during = null;
  const { result } = await runScenario(workflow, SCENARIOS.multi, {
    async boundary({ point }) {
      // everything is staged and prepared (images, manifest) but no target was touched
      if (point === 'manifest_prepared') {
        assert.notDeepEqual(await txDirectories(workflow), [], 'scratch exists at this boundary');
        during = await snapshots();
      }
    },
  });
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(during, before, 'staging images and manifests are invisible to every projection');
});

test('different requests commit one after the other with their own transactions', async (t) => {
  const workflow = await createTxWorkflow(t);
  const one = await runScenario(workflow, SCENARIOS.create);
  const two = await runScenario(workflow, SCENARIOS.replace, { requestId: ulid(701), providers: one.providers });
  assert.equal(one.result.outcome, 'committed');
  assert.equal(two.result.outcome, 'committed');
  assert.notEqual(one.result.transaction, two.result.transaction);
  assert.deepEqual(await txDirectories(workflow), []);
});
