import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest, nextCommandBuilders } from '../../lib/commands/manifest.js';
import { getFindingDefinition } from '../../lib/findings/catalog.js';
import { LOG_FINDING_CODES, LOG_SEGMENT_LIMIT, LOG_SEGMENT_REASONS, segmentName, segmentNumber } from '../../lib/store/log/index.js';
import { TRANSACTIONAL_COMMANDS } from '../../lib/store/transactions/index.js';
import { COMMAND_SNAPSHOT_TABLE } from '../../lib/store/snapshots/projections.js';

test('frozen ledger constants and segment naming', () => {
  assert.equal(LOG_SEGMENT_LIMIT, 80);
  assert.deepEqual({ ...LOG_FINDING_CODES }, { duplicate: 'AKRS-S002', segment: 'AKRS-S003' });
  assert.equal(segmentName(1), '0001.jsonl');
  assert.equal(segmentName(12), '0012.jsonl');
  assert.equal(segmentNumber('0002.jsonl'), 2);
  for (const name of ['0000.jsonl', '1.jsonl', '0001.json', 'x0001.jsonl', '0001.jsonl.bak']) assert.equal(segmentNumber(name), null);
  assert.throws(() => segmentName(0));
  assert.throws(() => segmentName(10_000));
});

test('log-append is a live, transactional, journaled mutation with a next-command builder', () => {
  const command = commandManifest.commands.find(({ id }) => id === 'log-append');
  assert.deepEqual(command.tokens, ['log', 'append']);
  assert.equal(command.mutability, 'mutation');
  assert.equal(command.idempotency, 'journal');
  assert.equal(command.expected_snapshot, 'revalidate');
  assert.equal(command.dry_run, true);
  assert.equal(typeof nextCommandBuilders['log-append'], 'function');
  assert.equal(TRANSACTIONAL_COMMANDS.includes('log-append'), true);
  assert.deepEqual(COMMAND_SNAPSHOT_TABLE['log-append'], { target: 'none', inputs: ['log'], lease_guard: null });
});

test('S002 and S003 are permanent state-family catalog entries with closed detail shapes', () => {
  const s002 = getFindingDefinition('AKRS-S002');
  const s003 = getFindingDefinition('AKRS-S003');
  for (const definition of [s002, s003]) {
    assert.equal(definition.category, 'state');
    assert.equal(definition.severity, 'error');
    assert.equal(definition.data_schema.additionalProperties, false);
  }
  assert.deepEqual(Object.keys(s002.data_schema.properties).sort(), ['kind', 'line', 'outcome', 'path', 'record', 'subject']);
  assert.deepEqual(s003.data_schema.properties.reason.enum, [...LOG_SEGMENT_REASONS]);
});
