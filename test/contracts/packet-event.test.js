import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createCompleteEvent, createPacket } from '../../lib/core/packet.js';
import {
  EVENT_TYPES,
  FINDING_SEVERITIES,
  PACKET_STATUSES,
} from '../../lib/schemas/common.js';
import { validateEvent } from '../../lib/schemas/event.js';
import { validateFinding } from '../../lib/schemas/finding.js';
import {
  PACKET_KEYS,
  validateMutationChanges,
  validatePacket,
  validateReadOnlyPacket,
} from '../../lib/schemas/packet.js';

const fixture = async (name) => JSON.parse(await readFile(
  new URL(`../fixtures/packet-envelope/${name}`, import.meta.url),
  'utf8',
));

const validFinding = await fixture('valid-finding.json');
const validPacket = await fixture('valid-packet.json');
const validEvent = await fixture('valid-event.json');
const knownCommands = ['road-details', 'road-update'];

test('F3 accepts the exact finding, packet, and event fixtures', () => {
  assert.equal(validateFinding(validFinding).ok, true);
  assert.equal(validatePacket(validPacket, { knownCommands }).ok, true);
  assert.equal(validateEvent(validEvent, { knownCommands }).ok, true);
});

test('F3 freezes every packet, event, and finding status value', () => {
  assert.deepEqual(PACKET_STATUSES, ['ok', 'warning', 'error', 'blocked', 'noop']);
  assert.deepEqual(EVENT_TYPES, ['started', 'progress', 'evidence', 'finding', 'complete']);
  assert.deepEqual(FINDING_SEVERITIES, ['info', 'warning', 'error']);

  for (const status of PACKET_STATUSES) {
    const candidate = structuredClone(validPacket);
    candidate.status = status;
    assert.equal(validatePacket(candidate, { knownCommands }).ok, true, status);
  }
  for (const severity of FINDING_SEVERITIES) {
    assert.equal(validateFinding({ ...validFinding, severity }).ok, true, severity);
  }
  for (const type of EVENT_TYPES.filter((value) => value !== 'complete')) {
    assert.equal(validateEvent({ ...validEvent, type }, { knownCommands }).ok, true, type);
  }
});

test('F3 packet factory uses injected time and run ID and canonicalizes set-like arrays', () => {
  const packet = createPacket({
    command: 'road-details',
    requestId: null,
    status: 'warning',
    root: 'E:\\project\\',
    snapshot: {
      before: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      after: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    data: { road_id: 'R1' },
    findings: [
      { ...validFinding, code: 'AKRS-R002', file: 'akrs/roads/Z.json' },
      validFinding,
    ],
    changed: ['akrs/z.json', 'akrs/a.json'],
    nextCommands: [
      { command: 'road-update', args: ['R1'] },
      { command: 'road-details', args: ['R1'] },
    ],
    providers: {
      now: () => '2026-08-25T10:30:00.000Z',
      runId: () => '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    },
    knownCommands,
  });

  assert.equal(packet.timestamp, '2026-08-25T10:30:00.000Z');
  assert.equal(packet.run_id, '01ARZ3NDEKTSV4RRFFQ69G5FAV');
  assert.equal(packet.root, 'E:/project');
  assert.deepEqual(packet.findings.map(({ code }) => code), ['AKRS-R001', 'AKRS-R002']);
  assert.deepEqual(packet.changed, ['akrs/a.json', 'akrs/z.json']);
  assert.deepEqual(packet.next_commands.map(({ command }) => command), ['road-update', 'road-details']);
});

test('F3 packet envelopes fail closed for every missing and unknown field', () => {
  assert.deepEqual(PACKET_KEYS, [
    'schema_version', 'command', 'run_id', 'request_id', 'timestamp', 'status',
    'root', 'snapshot', 'data', 'findings', 'changed', 'next_commands',
  ]);

  for (const key of PACKET_KEYS) {
    const candidate = structuredClone(validPacket);
    delete candidate[key];
    const result = validatePacket(candidate, { knownCommands });
    assert.equal(result.ok, false, key);
    assert.ok(result.issues.some((issue) => issue.code === 'missing_key'), key);
  }

  const unknown = structuredClone(validPacket);
  unknown.extra = true;
  const result = validatePacket(unknown, { knownCommands });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'unknown_key'));
});

test('F3 rejects malformed IDs, timestamps, statuses, paths, and terminal identity bytes', () => {
  const mutations = [
    (packet) => { packet.run_id = 'not-a-run-id'; },
    (packet) => { packet.request_id = 'request-1'; },
    (packet) => { packet.timestamp = '2026-08-25'; },
    (packet) => { packet.status = 'success'; },
    (packet) => { packet.command = '\u001b[32mroad-details'; },
    (packet) => { packet.root = 'relative/root'; },
    (packet) => { packet.changed = ['akrs\\state.json']; },
    (packet) => { packet.findings[0].file = 'akrs\\roads\\R1.json'; },
    (packet) => { packet.next_commands[0].command = 'not-enabled'; },
  ];

  for (const mutate of mutations) {
    const candidate = structuredClone(validPacket);
    mutate(candidate);
    assert.equal(validatePacket(candidate, { knownCommands }).ok, false);
  }
});

test('F3 finding and event envelopes reject unknown and missing keys', () => {
  for (const [source, validate] of [
    [validFinding, (candidate) => validateFinding(candidate)],
    [validEvent, (candidate) => validateEvent(candidate, { knownCommands })],
  ]) {
    for (const key of Object.keys(source)) {
      const candidate = structuredClone(source);
      delete candidate[key];
      const result = validate(candidate);
      assert.equal(result.ok, false, key);
      assert.ok(result.issues.some((issue) => issue.code === 'missing_key'), key);
    }

    const candidate = structuredClone(source);
    candidate.extra = true;
    const result = validate(candidate);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === 'unknown_key'));
  }
});

test('F3 terminal complete event carries the same validated packet', () => {
  const complete = createCompleteEvent({
    packet: validPacket,
    sequence: 2,
    providers: { now: () => '2026-08-25T10:30:02.000Z' },
    knownCommands,
  });

  assert.deepEqual(complete, {
    schema_version: 'akrs.event/v1',
    run_id: validPacket.run_id,
    sequence: 2,
    timestamp: '2026-08-25T10:30:02.000Z',
    type: 'complete',
    data: { packet: validPacket },
  });
  assert.equal(validateEvent(complete, { knownCommands }).ok, true);
});

test('read-only packets require matching snapshots and no changed files', () => {
  assert.equal(validateReadOnlyPacket(validPacket).ok, true);

  const changedSnapshot = structuredClone(validPacket);
  changedSnapshot.snapshot.after = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  assert.equal(validateReadOnlyPacket(changedSnapshot).ok, false);

  const changedFile = structuredClone(validPacket);
  changedFile.changed = ['akrs/state.json'];
  assert.equal(validateReadOnlyPacket(changedFile).ok, false);
});

test('mutation evidence rejects a changed file omitted from the packet', () => {
  const packet = structuredClone(validPacket);
  packet.request_id = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
  packet.changed = ['akrs/a.json'];

  const result = validateMutationChanges(packet, ['akrs/a.json', 'akrs/b.json']);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'unreported_change'));

  packet.request_id = null;
  const missingRequest = validateMutationChanges(packet, packet.changed);
  assert.ok(missingRequest.issues.some((issue) => issue.code === 'missing_request_id'));
});
