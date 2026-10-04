// P2-W14: the event stream of `test run --jsonl`: ordered facts, one complete event carrying the final packet.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateRunEvent } from '../../lib/schemas/run-events.js';
import { runWorld, testRun } from './support.js';

const parse = (text) => text.trim().split('\n').map((line) => JSON.parse(line));

test('a run is told as started, per-step progress, evidence and exactly one complete, in order', async (t) => {
  const repo = await runWorld(t);
  const run = await testRun(repo, ['P6'], { format: '--jsonl' });
  const events = parse(run.text);
  assert.deepEqual(events.map(({ sequence }) => sequence), events.map((_event, index) => index + 1));
  assert.equal(events[0].type, 'started');
  assert.equal(events.at(-1).type, 'complete');
  assert.equal(events.filter(({ type }) => type === 'complete').length, 1);
  const phases = events.filter(({ type }) => type === 'progress').map(({ data }) => `${data.phase}:${data.index ?? '-'}`);
  assert.deepEqual(phases, ['app_launching:-', 'app_ready:-', 'step_started:0', 'step_finished:0', 'step_started:1', 'step_finished:1', 'app_stopped:-']);
  assert.deepEqual(events.filter(({ type }) => type === 'evidence').map(({ data }) => data.type), ['log']);
  for (const event of events.filter(({ type }) => type !== 'complete')) assert.equal(validateRunEvent(event).ok, true, JSON.stringify(validateRunEvent(event).issues));
  assert.deepEqual(events.at(-1).data.packet, run.packet);
});

test('the complete event of a failed run is the failed packet and findings come before it', async (t) => {
  const repo = await runWorld(t, { contract: { scenario: [{ step: 'http', method: 'GET', url: '/boom', headers: [], body: null, expect_status: 200, expect_json: null, soft: false }] } });
  const run = await testRun(repo, ['P6'], { format: '--jsonl' });
  const events = parse(run.text);
  assert.equal(events.at(-1).data.packet.status, 'error');
  const finding = events.findIndex(({ type }) => type === 'finding');
  assert.ok(finding !== -1 && finding < events.length - 1);
  assert.equal(events[finding].data.finding.code, 'AKRS-T005');
});

test('the event data schemas are closed: unknown keys, wrong phases and wrong kinds are refused', () => {
  const base = { schema_version: 'akrs.event/v1', run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', sequence: 1, timestamp: '2026-10-04T10:00:00.000Z' };
  const progress = { kind: 'run_progress', phase: 'step_started', index: 0, name: 'goto', status: null, duration_ms: null };
  assert.equal(validateRunEvent({ ...base, type: 'progress', data: progress }).ok, true);
  assert.equal(validateRunEvent({ ...base, type: 'progress', data: { ...progress, extra: 1 } }).ok, false);
  assert.equal(validateRunEvent({ ...base, type: 'progress', data: { ...progress, phase: 'bogus' } }).ok, false);
  assert.equal(validateRunEvent({ ...base, type: 'progress', data: { ...progress, kind: 'verify_progress' } }).ok, false);
  assert.equal(validateRunEvent({ ...base, type: 'progress', data: { ...progress, phase: 'step_finished' } }).ok, false, 'a finished step names its status');
});

test('a refusal before any execution is one complete event with the blocked packet', async (t) => {
  const repo = await runWorld(t, { contract: { scenario: [] } });
  const run = await testRun(repo, ['P6'], { format: '--jsonl' });
  const events = parse(run.text);
  assert.deepEqual(events.map(({ type }) => type), ['finding', 'complete']);
  assert.equal(events.at(-1).data.packet.data.reason, 'scenario_missing');
});
