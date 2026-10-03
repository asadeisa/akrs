// P1-W02 snapshot engine: determinism, declared inputs, declared exclusions, A1 lease/Tester projections.
import assert from 'node:assert/strict';
import { appendFile, rm, writeFile } from 'node:fs/promises';
import { sep } from 'node:path';
import { test } from 'node:test';
import {
  COMMAND_SNAPSHOT_TABLE,
  EMPTY_SNAPSHOT,
  LEASE_CONTRACT_PROJECTION,
  ROAD_PACKET_PROJECTION,
  TESTER_LEASE_PROJECTION,
  TESTER_PACKET_PROJECTION,
  PLAN_CLOSE_PROJECTION,
  WORKFLOW_PROJECTION,
  commandSnapshot,
  computeSnapshot,
  captureReadSnapshot,
} from '../../lib/store/snapshots/index.js';
import {
  HANDOFF_LINE, OTHER_HANDOFF_LINE, REQUEST_LINE, RESOLUTION_LINE, RESULT_LINE, ROAD_R0, ROAD_R1, SECRET,
  createWorkflow, jsonLine, jsonText,
} from './support.js';

const SNAPSHOT = /^sha256:[0-9a-f]{64}$/;

// Named views over the fixture: projection set + target.
const VIEWS = {
  lease: { projections: LEASE_CONTRACT_PROJECTION, target: { road: 'R1' } },
  roadPacket: { projections: ROAD_PACKET_PROJECTION, target: { road: 'R1' } },
  testerLease: { projections: TESTER_LEASE_PROJECTION, target: { plan: 'P1' } },
  testerPacket: { projections: TESTER_PACKET_PROJECTION, target: { plan: 'P1' } },
  planClose: { projections: PLAN_CLOSE_PROJECTION, target: { plan: 'P1' } },
  workflow: { projections: WORKFLOW_PROJECTION, target: {} },
  roadWrites: { projections: ['road-writes'], target: { road: 'R1' } },
  handoffs: { projections: ['road-handoffs'], target: { road: 'R1' } },
};

async function snapshotAll(workflow) {
  const out = {};
  for (const [name, view] of Object.entries(VIEWS)) {
    const result = await computeSnapshot({ ...workflow.options, ...view });
    assert.equal(result.status, 'ok', name);
    assert.match(result.snapshot, SNAPSHOT, name);
    out[name] = result.snapshot;
  }
  return out;
}

const ALL = Object.keys(VIEWS);

// [description, mutation(workflow), views that MUST change]; every other view MUST stay identical.
const MUTATIONS = [
  ['Road JSON of the target', (w) => w.write('akrs/roads/R1.json', jsonText({ ...ROAD_R1, acceptance: ['works', 'fast'] })),
    ['lease', 'roadPacket', 'testerLease', 'testerPacket', 'planClose', 'workflow']],
  ['dependency status', (w) => w.write('akrs/roads/nested/R0.json', jsonText({ ...ROAD_R0, status: 'ACTIVE' })),
    ['lease', 'roadPacket', 'workflow']],
  ['SOT window line', (w) => w.write('SOT/rules.md', w.files['SOT/rules.md'].replace('paid means settled', 'paid means captured')),
    ['lease', 'roadPacket']],
  ['declared read outside writes', (w) => w.write('src/shared.js', 'export const shared = 2;\n'),
    ['lease', 'roadPacket']],
  ['file inside a declared read directory', (w) => w.write('docs/guide/deep/more.md', '# Changed\n'),
    ['lease', 'roadPacket']],
  ['new file inside a declared read directory', (w) => w.write('docs/guide/new.md', '# New\n'),
    ['lease', 'roadPacket']],
  ['scope resolution appended', (w) => appendFile(w.path('akrs/scope/R1.jsonl'), RESOLUTION_LINE.replace('01', '02')),
    ['lease', 'roadPacket', 'workflow']],
  ['executors', (w) => w.write('akrs/executors.json', jsonText({ schema: 'akrs.executors/v1', executors: [{ id: 'flash' }] })),
    ['lease', 'roadPacket', 'workflow']],
  ['Task narrative', (w) => w.write('akrs/tasks/T1.md', '# T1\nchanged\n'), ['roadPacket', 'workflow']],
  ['pending scope request', (w) => appendFile(w.path('akrs/scope/R1.jsonl'), REQUEST_LINE), ['roadPacket', 'workflow']],
  ['product file inside the Road writes', (w) => w.write('src/own.js', 'export const own = 2;\n'),
    ['testerLease', 'testerPacket', 'planClose', 'roadWrites']],
  ['new product file inside a dir write', (w) => w.write('src/gen/b.js', 'export const b = 1;\n'),
    ['testerLease', 'testerPacket', 'planClose', 'roadWrites']],
  ['product file matched by another Road glob', (w) => w.write('lib/x.js', 'export const x = 2;\n'),
    ['testerLease', 'testerPacket', 'planClose']],
  ['verification contract', (w) => w.write('akrs/verifications/P1/contract.json', '{"changed":true}\n'),
    ['testerLease', 'testerPacket', 'planClose', 'workflow']],
  ['verification read source', (w) => w.write('SOT/flows.md', '# Flows\nchanged\n'),
    ['testerLease', 'testerPacket', 'planClose']],
  ['handoff appended for this Road', (w) => appendFile(w.path('akrs/verifications/P1/handoff.jsonl'), HANDOFF_LINE.replace('03', '13')),
    ['testerPacket', 'planClose', 'workflow', 'handoffs']],
  ['handoff appended for another Road', (w) => appendFile(w.path('akrs/verifications/P1/handoff.jsonl'), OTHER_HANDOFF_LINE),
    ['testerPacket', 'planClose', 'workflow']],
  ['Tester result appended', (w) => appendFile(w.path('akrs/verifications/P1/results.jsonl'), RESULT_LINE.replace('05', '15')),
    ['planClose', 'workflow']],
  ['Plan file', (w) => w.write('akrs/plans/P1.json', '{"id":"P1","title":"renamed"}\n'), ['testerPacket', 'planClose', 'workflow']],
  ['state', (w) => w.write('akrs/state.json', '{"mode":"plan"}\n'), ['workflow']],
  ['rendered state', (w) => w.write('akrs/STATE.md', '# State 2\n'), ['workflow']],
  ['closure log', (w) => appendFile(w.path('akrs/log/0001.jsonl'), jsonLine({ id: '01J00000000000000000000016' })), ['workflow']],
  ['memory', (w) => w.write('akrs/memory/decisions.md', '# Decisions\n- one\n'), ['workflow']],
  ['an unrelated Road', (w) => w.write('akrs/roads/R9.json', '{"id":"R9","status":"DONE"}\n'), ['workflow']],
  // Declared exclusions: none of these may change any view.
  ['SOT line outside every window', (w) => w.write('SOT/rules.md', w.files['SOT/rules.md'].replace('more tail', 'changed tail')), []],
  ['undeclared product file', (w) => w.write('README.md', '# Changed\n'), []],
  ['ephemeral write', (w) => w.write('tmp/handoff.md', 'consumed\n'), []],
  ['draft', (w) => w.write('akrs/drafts/road-R3.json', '{"id":"R3","x":1}\n'), []],
  ['new draft', (w) => w.write('akrs/drafts/road-R4.json', '{}\n'), []],
  ['cache', (w) => w.write('akrs/.cache/view/index.html', '<html>2</html>'), []],
  ['evidence', (w) => w.write('akrs/verifications/P1/evidence/run-1/shot.png', 'PNG-2'), []],
  ['run record', (w) => w.write('akrs/verifications/P1/evidence/run-2/run.json', '{}\n'), []],
  ['lock housekeeping', (w) => w.write('akrs/.ops/lock', 'pid 2'), []],
  ['journal housekeeping', (w) => appendFile(w.path('akrs/.ops/journal/0001.jsonl'), jsonLine({ op: 2 })), []],
  ['transaction scratch', (w) => w.write('akrs/.ops/tx/01J/manifest.json', '{}\n'), []],
  ['git metadata', (w) => w.write('.git/index', 'binary-index'), []],
];

for (const [name, mutate, changes] of MUTATIONS) {
  test(`F5 ${changes.length === 0 ? 'exclusion' : 'input'}: ${name} changes exactly [${changes.join(', ')}]`, async (t) => {
    const workflow = await createWorkflow(t);
    const before = await snapshotAll(workflow);
    await mutate(workflow);
    const after = await snapshotAll(workflow);
    for (const view of ALL) {
      if (changes.includes(view)) assert.notEqual(after[view], before[view], `${view} must change`);
      else assert.equal(after[view], before[view], `${view} must not change`);
    }
  });
}

test('F5 creation order, CRLF text, and root path spelling do not change any snapshot', async (t) => {
  const forward = await snapshotAll(await createWorkflow(t));
  const reverse = await snapshotAll(await createWorkflow(t, { order: 'reverse' }));
  const crlf = await snapshotAll(await createWorkflow(t, { eol: '\r\n' }));
  assert.deepEqual(reverse, forward);
  assert.deepEqual(crlf, forward);

  const workflow = await createWorkflow(t);
  const spelled = {
    repositoryRoot: `${workflow.root}${sep}`,
    workflowRoot: `${workflow.root}${sep}akrs${sep}`,
  };
  for (const [name, view] of Object.entries(VIEWS)) {
    const result = await computeSnapshot({ ...spelled, ...view });
    assert.equal(result.snapshot, forward[name], name);
  }
});

test('F5 the inventory is sorted, uses / paths, and never embeds file contents', async (t) => {
  const workflow = await createWorkflow(t);
  const result = await computeSnapshot({ ...workflow.options, projections: ROAD_PACKET_PROJECTION, target: { road: 'R1' } });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes('\\\\'), false);
  const keys = result.inventory.map(({ projection, key }) => `${projection}\u0000${key}`);
  assert.deepEqual(keys, [...keys].sort());
  for (const entry of result.inventory) {
    assert.deepEqual(Object.keys(entry), ['projection', 'key', 'kind', 'value']);
    assert.ok(['file', 'window', 'status', 'record'].includes(entry.kind));
  }
  const reads = result.inventory.filter(({ projection }) => projection === 'road-reads').map(({ key }) => key);
  assert.deepEqual(reads, [
    'SOT/rules.md#L2-3',
    'docs/guide/deep/more.md',
    'docs/guide/intro.md',
    'src/shared.js',
  ]);
  const deps = result.inventory.filter(({ projection }) => projection === 'road-deps');
  assert.deepEqual(deps, [{ projection: 'road-deps', key: 'R0', kind: 'status', value: 'DONE' }]);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual([...result.projections], [...ROAD_PACKET_PROJECTION]);
});

test('F5 the Tester product projection expands dir and glob writes of every applicable Road', async (t) => {
  const workflow = await createWorkflow(t);
  const result = await computeSnapshot({ ...workflow.options, projections: ['plan-product', 'plan-roads'], target: { plan: 'P1' } });
  const product = result.inventory.filter(({ projection }) => projection === 'plan-product').map(({ key }) => key);
  // lib/*.js matches one segment only; ephemeral writes are consumed and never pinned.
  assert.deepEqual(product, ['lib/x.js', 'src/gen/a.js', 'src/own.js']);
  const roads = result.inventory.filter(({ projection }) => projection === 'plan-roads').map(({ key }) => key);
  assert.deepEqual(roads, ['akrs/roads/R1.json', 'akrs/roads/R2.json']);
});

test('F5 the no-Plan tier keys the Tester projection by the Road ID', async (t) => {
  const workflow = await createWorkflow(t, {
    extra: { 'akrs/verifications/R9/contract.json': jsonText({ plan: 'R9', roads: ['R9'], reads: [] }), 'other/z.js': 'z\n' },
  });
  const result = await computeSnapshot({ ...workflow.options, projections: TESTER_LEASE_PROJECTION, target: { plan: 'R9' } });
  assert.equal(result.status, 'ok');
  const keys = result.inventory.map(({ projection, key }) => `${projection}:${key}`);
  assert.deepEqual(keys, [
    'plan-contract:akrs/verifications/R9/contract.json',
    'plan-product:other/z.js',
    'plan-roads:akrs/roads/R9.json',
  ]);
});

test('F5 missing and unverifiable inputs are reported, never dropped from the projection', async (t) => {
  const workflow = await createWorkflow(t, {
    extra: {
      'akrs/roads/R5.json': jsonText({
        ...ROAD_R1,
        id: 'R5',
        deps: ['Gone', 'R0', 'Dup'],
        reads: [
          { path: 'SOT/rules.md', lines: [4, 99], why: null },
          { path: 'SOT/absent.md', lines: null, why: null },
          { path: 'bin.dat', lines: [1, 1], why: null },
        ],
        writes: [],
        task: 'T5',
      }),
      'akrs/roads/Dup.json': '{"id":"Dup","status":"DONE"}\n',
      'akrs/roads/again/Dup.json': '{"id":"Dup","status":"DONE"}\n',
      'akrs/roads/Bad.json': '{ not json',
      'bin.dat': Buffer.from([0x00, 0xff, 0x0a]),
    },
  });
  const result = await computeSnapshot({ ...workflow.options, projections: ROAD_PACKET_PROJECTION, target: { road: 'R5' } });
  assert.equal(result.status, 'ok');
  assert.match(result.snapshot, SNAPSHOT);
  const unresolved = result.unresolved.map(({ projection, key, value }) => `${projection}:${key}:${value}`);
  assert.deepEqual(unresolved, [
    'road-deps:Dup:ambiguous',
    'road-deps:Gone:missing',
    'road-reads:SOT/absent.md:missing',
    'road-reads:SOT/rules.md#L4-99:out_of_range',
    'road-reads:bin.dat#L1-1:not_text',
    'road-task:akrs/tasks/T5.md:missing',
  ]);
  for (const entry of result.unresolved) {
    assert.ok(result.inventory.some((item) => item.projection === entry.projection && item.key === entry.key));
  }

  const missingRoad = await computeSnapshot({ ...workflow.options, projections: LEASE_CONTRACT_PROJECTION, target: { road: 'Nope' } });
  assert.deepEqual(missingRoad.unresolved.map(({ projection, key, value }) => `${projection}:${key}:${value}`), [
    'road:Nope:missing',
    'road-deps:Nope:missing',
    'road-reads:Nope:missing',
    'road-scope-resolutions:Nope:missing',
  ]);

  const badRoad = await computeSnapshot({ ...workflow.options, projections: ['road', 'road-deps'], target: { road: 'Bad' } });
  assert.deepEqual(badRoad.unresolved.map(({ projection, key, value }) => `${projection}:${key}:${value}`), [
    'road-deps:Bad:unparseable',
  ]);
  assert.equal(badRoad.inventory.find(({ projection }) => projection === 'road').key, 'akrs/roads/Bad.json');
});

test('F5 unsafe declared paths are recorded as unsafe instead of being read', async (t) => {
  const workflow = await createWorkflow(t, {
    extra: {
      'akrs/roads/R6.json': jsonText({
        ...ROAD_R1, id: 'R6', deps: [], task: null, writes: [],
        reads: [{ path: '../outside.md', lines: null, why: null }, { path: 'Readme.md', lines: null, why: null }],
      }),
    },
  });
  const result = await computeSnapshot({ ...workflow.options, projections: ['road-reads'], target: { road: 'R6' } });
  assert.deepEqual(result.unresolved.map(({ key, value }) => `${key}:${value}`), [
    '../outside.md:unsafe',
    'Readme.md:case_mismatch',
  ]);
});

test('F5 an empty projection is the empty snapshot and targets are required by scoped projections', async (t) => {
  const workflow = await createWorkflow(t);
  const empty = await computeSnapshot({ ...workflow.options, projections: [], target: {} });
  assert.equal(empty.snapshot, EMPTY_SNAPSHOT);
  assert.deepEqual(empty.inventory, []);
  await assert.rejects(computeSnapshot({ ...workflow.options, projections: ['road'], target: {} }), TypeError);
  await assert.rejects(computeSnapshot({ ...workflow.options, projections: ['plan'], target: { road: 'R1' } }), TypeError);
  await assert.rejects(computeSnapshot({ ...workflow.options, projections: ['everything'], target: {} }), TypeError);
  await assert.rejects(computeSnapshot({ ...workflow.options, projections: ['doctrine'], target: {} }), TypeError);
  await assert.rejects(computeSnapshot({ ...workflow.options, projections: ['road'], target: { road: '../x' } }), TypeError);
});

test('F5 commandSnapshot follows the table row for each computable command', async (t) => {
  const workflow = await createWorkflow(t);
  const targets = { none: {}, road: { road: 'R1' }, plan: { plan: 'P1' } };
  for (const [id, row] of Object.entries(COMMAND_SNAPSHOT_TABLE)) {
    if (row.inputs.some((input) => ['doctrine', 'agent-configs', 'projects-registry'].includes(input))) {
      await assert.rejects(commandSnapshot(id, { ...workflow.options, target: targets[row.target] }), TypeError, id);
      continue;
    }
    const viaCommand = await commandSnapshot(id, { ...workflow.options, target: targets[row.target] });
    const direct = await computeSnapshot({ ...workflow.options, projections: row.inputs, target: targets[row.target] });
    assert.equal(viaCommand.snapshot, direct.snapshot, id);
  }
  await assert.rejects(commandSnapshot('no-such-command', workflow.options), TypeError);
});

test('F5 a read-only capture reports identical before and after', async (t) => {
  const workflow = await createWorkflow(t);
  const capture = await captureReadSnapshot('road-details', { ...workflow.options, target: { road: 'R1' } });
  assert.equal(capture.status, 'ok');
  assert.equal(capture.snapshot.before, capture.snapshot.after);
  assert.match(capture.snapshot.before, SNAPSHOT);
});

// Shared across racers: a fresh counter per racer would rewrite content equal to what an earlier scenario left behind.
let counter = 0;

function racingIo(workflow, { times }) {
  let remaining = times;
  return {
    async afterRead(path) {
      if (remaining > 0 && path.endsWith('src/shared.js')) {
        remaining -= 1;
        counter += 1;
        await writeFile(workflow.path('src/shared.js'), `export const shared = ${counter};\n`);
      }
    },
  };
}

test('F5 a file changing during collection is retried, then reported unstable instead of mixed', async (t) => {
  const workflow = await createWorkflow(t);
  const once = await computeSnapshot({
    ...workflow.options, ...VIEWS.lease, io: racingIo(workflow, { times: 1 }),
  });
  assert.equal(once.status, 'ok');
  assert.equal(once.attempts, 2);
  const settled = await computeSnapshot({ ...workflow.options, ...VIEWS.lease });
  assert.equal(once.snapshot, settled.snapshot);

  const always = await computeSnapshot({
    ...workflow.options, ...VIEWS.lease, io: racingIo(workflow, { times: 100 }), maxAttempts: 3,
  });
  assert.equal(always.status, 'unstable');
  assert.equal(always.snapshot, null);
  assert.equal(always.attempts, 3);

  const capture = await captureReadSnapshot('work', {
    ...workflow.options, target: { road: 'R1' }, io: racingIo(workflow, { times: 100 }),
  });
  assert.equal(capture.status, 'unstable');
  assert.deepEqual(capture.snapshot, { before: null, after: null });
});

test('F5 a deleted file between collection passes is detected', async (t) => {
  const workflow = await createWorkflow(t);
  let done = false;
  const io = {
    async afterRead(path) {
      if (!done && path.endsWith('docs/guide/intro.md')) {
        done = true;
        await rm(workflow.path('docs/guide/deep/more.md'));
      }
    },
  };
  const result = await computeSnapshot({ ...workflow.options, ...VIEWS.lease, io });
  assert.equal(result.status, 'ok');
  assert.equal(result.attempts, 2);
  assert.equal(result.inventory.some(({ key }) => key === 'docs/guide/deep/more.md'), false);
});
