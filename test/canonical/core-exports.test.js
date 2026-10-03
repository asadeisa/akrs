import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as core from '../../lib/core/index.js';

const FUNCTIONS = [
  'parseStrictJson', 'canonicalizeJson', 'canonicalizeJsonCompact', 'compareCodePoints',
  'decodeJsonl', 'encodeJsonlRecord',
  'renderMarkdownHeader', 'renderMarkdownRecord', 'parseMarkdownRecords',
  'contentHash', 'storedSpec', 'verifyMeta', 'withMeta', 'normalizeInput',
  'classifyPath', 'validateGlobPattern', 'pathOverlap', 'isProvablyDisjoint',
  'validateRepoPath', 'validateLineRange', 'validateArgv', 'validateIsoTimestamp', 'validateSha256',
  'validateIntegerRange', 'toJsonPointer', 'appendKey', 'appendIndex', 'issuesToFindingDetail', 'isExcludedNamespace',
  'isArtifactSchemaId', 'isId', 'isUlid',
];

test('F4/F11 the public core entry exposes the canonical codec, input normalization, and path primitives', () => {
  for (const name of FUNCTIONS) assert.equal(typeof core[name], 'function', name);
  assert.equal(typeof core.MAX_INPUT_BYTES, 'number');
  assert.deepEqual([...core.PATH_CLASSES], ['file', 'dir', 'glob', 'ephemeral']);
  assert.deepEqual([...core.EXCLUDED_NAMESPACES], ['drafts', '.cache', '.ops']);
  assert.equal(core.ID_MAX_LENGTH, 64);
  assert.equal(core.PATH_SAFETY_POLICY.glob_grammar, 'restricted_star_question_globstar_v1');
});

test('F6 the core entry re-exports the schema registry API by explicit names', () => {
  for (const name of ['validateArtifact', 'findingsForSchemaIssues', 'buildTemplate', 'findMissingInputs']) {
    assert.equal(typeof core[name], 'function', name);
  }
  for (const name of ['SCHEMA_REGISTRY', 'ARTIFACT_KINDS', 'ORDERING_TABLE', 'SCHEMA_VIOLATION_CODES', 'TEMPLATE_KINDS', 'TEMPLATE_SCHEMAS']) {
    assert.equal(typeof core[name], 'object', name);
  }
  assert.equal(core.SCHEMA_REGISTRY['akrs.road/v1'].kind, 'road');
  assert.equal(core.ARTIFACT_KINDS.includes('road'), true);
  assert.equal(core.TEMPLATE_KINDS.includes('road'), true);
});

test('F4 the core entry keeps its earlier exports unchanged', () => {
  for (const name of ['createPacket', 'discoverRoots', 'validateWorkflowPath', 'createPathService', 'commandManifest']) {
    assert.notEqual(core[name], undefined, name);
  }
  assert.equal(core.validateWorkflowPath.length >= 1, true);
});
