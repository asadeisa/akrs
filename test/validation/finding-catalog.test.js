import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCliAdapter } from '../../bin/cli-adapter.js';
import { commandHandlers, commandManifest } from '../../lib/core/index.js';
import {
  FINDING_CATALOG_KEYS,
  FINDING_CODE_FAMILIES,
  findingCatalog,
  getFindingDefinition,
  validateFindingCatalog,
} from '../../lib/findings/catalog.js';

const providers = {
  now: () => '2026-08-25T10:30:00.000Z',
  runId: () => '01ARZ3NDEKTSV4RRFFQ69G5FAV',
};

test('F10 freezes the permanent finding families and closed catalog shape', () => {
  assert.deepEqual(FINDING_CODE_FAMILIES, {
    R: 'road', M: 'memory', S: 'state', G: 'git', C: 'command', T: 'tester',
  });
  assert.deepEqual(FINDING_CATALOG_KEYS, [
    'code', 'category', 'severity', 'rationale', 'data_schema', 'remediation',
  ]);
  assert.equal(validateFindingCatalog(findingCatalog).ok, true);
  assert.equal(findingCatalog.length > 0, true);
  assert.equal(new Set(findingCatalog.map(({ code }) => code)).size, findingCatalog.length);
  assert.deepEqual([...findingCatalog].map(({ code }) => code),
    [...findingCatalog].map(({ code }) => code).sort());
});

test('every catalog code is explainable from the same immutable record', async () => {
  for (const definition of findingCatalog) {
    assert.equal(getFindingDefinition(definition.code), definition);
    const result = await runCliAdapter({
      argv: ['explain', definition.code, '--json'],
      cwd: 'E:/project',
      manifest: commandManifest,
      handlers: commandHandlers,
      providers,
    });
    assert.equal(result.exitCode, 0, definition.code);
    assert.deepEqual(JSON.parse(result.stdout).data.finding, definition);
  }
});

test('explain rejects unknown codes deterministically before inventing metadata', async () => {
  for (const code of ['AKRS-R999', 'akrs-r001', 'R001']) {
    const result = await runCliAdapter({
      argv: ['explain', code, '--json'],
      cwd: 'E:/project',
      manifest: commandManifest,
      handlers: commandHandlers,
      providers,
    });
    assert.equal(result.exitCode, 2, code);
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.data.kind, 'usage');
    assert.equal(packet.findings[0].code, 'AKRS-C001');
    assert.equal(packet.findings[0].detail.reason, `unknown finding code: ${code}`);
  }
});
