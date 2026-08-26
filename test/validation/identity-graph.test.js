import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  analyzeDependencyCycles,
  analyzeDependencyReadiness,
  analyzeDependencyReferences,
  registerRoadIdentities,
} from '../../lib/validation/graph.js';
import { validateWorkflow } from '../../lib/commands/validation.js';

const providers = {
  now: () => '2026-08-25T10:30:00.000Z',
  runId: () => '01ARZ3NDEKTSV4RRFFQ69G5FAV',
};

function road(id, file, status, deps = []) {
  return { id, file, line: 1, status, deps };
}

test('duplicate nested Road identities fail before a lossy lookup map exists', () => {
  const result = registerRoadIdentities([
    road('R1', 'akrs/roads/P2/R1.md', 'ACTIVE'),
    road('R1', 'akrs/roads/P1/R1.md', 'DONE'),
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.by_id, null);
  assert.equal(result.findings.length, 2);
  assert.deepEqual(result.findings.map(({ file }) => file), [
    'akrs/roads/P1/R1.md', 'akrs/roads/P2/R1.md',
  ]);
  assert.equal(result.findings.every(({ code }) => code === 'AKRS-R001'), true);
});

test('references and cycles inspect every Road status while readiness is separate', () => {
  const roads = [
    road('Q', 'akrs/roads/Q.md', 'QUEUED', ['MISSING']),
    road('A', 'akrs/roads/A.md', 'ACTIVE', ['D']),
    road('D', 'akrs/roads/D.md', 'DONE', ['D']),
    road('X', 'akrs/roads/X.md', 'QUEUED', ['Y']),
    road('Y', 'akrs/roads/Y.md', 'DONE', ['X']),
  ];
  const registry = registerRoadIdentities(roads);
  assert.equal(registry.ok, true);

  const references = analyzeDependencyReferences(roads, registry.by_id);
  assert.equal(references.examined_count, roads.length);
  assert.deepEqual(references.findings.map(({ detail }) => detail.dependency), ['MISSING']);
  assert.equal(references.findings[0].file, 'akrs/roads/Q.md');

  const cycles = analyzeDependencyCycles(roads, registry.by_id);
  assert.equal(cycles.examined_count, roads.length);
  assert.deepEqual(cycles.findings.map(({ detail }) => detail.cycle), [
    ['D', 'D'], ['X', 'Y', 'X'],
  ]);

  const readiness = analyzeDependencyReadiness(roads, registry.by_id);
  assert.equal(readiness.examined_count, 1);
  assert.equal(readiness.findings.length, 0);
});

test('finding bytes are independent of filesystem creation order', async (t) => {
  const roots = [];
  const orderFixture = JSON.parse(await readFile(new URL(
    '../fixtures/validation/finding-order/orders.json', import.meta.url,
  ), 'utf8'));
  for (const order of orderFixture) {
    const root = await mkdtemp(join(tmpdir(), 'akrs-order-'));
    roots.push(root);
    const roads = join(root, 'akrs', 'roads');
    await mkdir(roads, { recursive: true });
    for (const name of order) {
      await writeFile(join(roads, name), `# ${name}\n\nStatus: ACTIVE\n\nDeps: MISSING\n`, 'utf8');
    }
  }
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

  const packets = [];
  for (const root of roots) {
    packets.push(await validateWorkflow({
      repositoryRoot: root,
      workflowRoot: join(root, 'akrs'),
      providers,
    }));
  }

  const project = (packet) => packet.findings.map((finding) => ({
    code: finding.code,
    severity: finding.severity,
    message: finding.message,
    file: finding.file,
    line: finding.line,
    detail: finding.detail,
  }));
  assert.deepEqual(project(packets[0]), project(packets[1]));
});
