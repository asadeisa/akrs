// P2-W14: the real-browser scenario run: goto, click, fill, expect, wait, screenshot and measure against the fixture app.
// It runs where a Chromium-family browser exists and is reported `skipped`, never passed, where none is.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverBrowser } from '../../lib/browser/discovery.js';
import { runWorld, testRun } from './support.js';

const found = discoverBrowser({ platform: process.platform, env: process.env });

test('a real browser drives the fixture app through a scenario and the evidence is on disk', { skip: found.ok ? false : `no browser found (${found.reason})` }, async (t) => {
  const repo = await runWorld(t, { contract: { evidence_types: ['screenshot', 'console', 'network', 'a11y', 'timing', 'log'], scenario: [
    { step: 'viewport', width: 390, height: 844, soft: false },
    { step: 'goto', url: '/', soft: false },
    { step: 'expect_text', text: 'Reservations', soft: false },
    { step: 'click', text: 'Save', selector: null, role: null, name: null, soft: false },
    { step: 'wait_for', text: 'Saved!', selector: null, url: null, timeout_ms: 5000, soft: false },
    { step: 'expect_no_console_errors', soft: false },
    { step: 'goto', url: '/form', soft: false },
    { step: 'fill', selector: '#name', value: 'Ada', soft: false },
    { step: 'click', text: null, selector: null, role: 'button', name: 'Greet', soft: false },
    { step: 'wait_for', text: 'Hello Ada', selector: null, url: null, timeout_ms: 5000, soft: false },
    { step: 'screenshot', name: 'form', soft: false },
    { step: 'measure', metric: 'load', budget_ms: 10000, soft: false },
    { step: 'goto', url: '/errors', soft: false },
    { step: 'expect_no_console_errors', soft: true },
  ] } });
  const run = await testRun(repo);
  assert.equal(run.packet.data.run.status, 'passed', run.text);
  assert.deepEqual(run.packet.data.steps.map(({ status }) => status).filter((status) => status !== 'passed'), ['failed']);
  assert.equal(run.packet.data.steps.at(-1).soft, true);
  assert.match(run.packet.data.steps.at(-1).detail, /fixture-boom/);
  assert.ok(run.packet.data.evidence.some(({ type }) => type === 'screenshot'));
  assert.equal(run.packet.status, 'warning');
});
