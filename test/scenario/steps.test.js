// P2-W14: the scenario step executor with a fake driver: closed vocabulary, soft/hard rule, skipped steps, mechanical facts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSteps, validateScenario } from '../../lib/scenario/steps.js';

// A fake browser driver that records every call; `answers` overrides what it says.
function fakeDriver(answers = {}) {
  const calls = [];
  const driver = new Proxy({}, {
    get: (_target, name) => async (...args) => {
      calls.push([name, ...args]);
      const answer = answers[name];
      if (typeof answer === 'function') return answer(...args);
      if (answer instanceof Error) throw answer;
      if (answer !== undefined) return answer;
      return { expectText: true, waitFor: true, consoleErrors: [], measure: 100, screenshot: Buffer.from('PNG') }[name];
    },
  });
  return { driver, calls };
}
const http = (status = 'passed') => async (step) => ({ status, detail: `${step.method} ${step.url} -> ${status === 'passed' ? 200 : 500}` });
const clock = () => { let t = 0; return () => { t += 10; return t; }; };
const run = (steps, extra = {}) => runSteps({ steps, baseUrl: 'http://127.0.0.1:3000', timeoutMs: 5000, now: clock(), http: http(), ...extra });
const goto = (url = '/', extra = {}) => ({ step: 'goto', url, soft: false, ...extra });
const expectText = (text, extra = {}) => ({ step: 'expect_text', text, soft: false, ...extra });
const httpStep = (extra = {}) => ({ step: 'http', method: 'GET', url: '/health', headers: [], body: null, expect_status: 200, expect_json: null, soft: false, ...extra });

test('only the closed vocabulary validates: an unknown step or a foreign host is refused before anything runs', () => {
  assert.equal(validateScenario([goto(), expectText('x')], { allowedHosts: [] }).ok, true);
  const unknown = validateScenario([{ step: 'eval', script: 'alert(1)' }], { allowedHosts: [] });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.issues[0].code, 'unknown_step');
  const host = validateScenario([goto('http://example.com/')], { allowedHosts: [] });
  assert.equal(host.ok, false);
  assert.equal(validateScenario([goto('http://example.com/')], { allowedHosts: ['example.com'] }).ok, true);
});

test('every step yields one structured result with consecutive indexes, soft and a duration', async () => {
  const { driver } = fakeDriver();
  const result = await run([goto(), expectText('Saved'), httpStep({ soft: true })], { driver });
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.steps.map(({ index, step, status, soft }) => [index, step, status, soft]), [[0, 'goto', 'passed', false], [1, 'expect_text', 'passed', false], [2, 'http', 'passed', true]]);
  assert.ok(result.steps.every(({ duration_ms: ms }) => Number.isInteger(ms) && ms > 0));
  assert.ok(result.steps.every(({ detail }) => detail === null || typeof detail === 'string'));
});

test('the first hard failure stops the run and says which step stopped it', async () => {
  const { driver, calls } = fakeDriver({ expectText: false });
  const result = await run([goto(), expectText('Saved'), { step: 'screenshot', name: 'late', soft: false }], { driver });
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(result.steps.map(({ status }) => status), ['passed', 'failed', 'skipped']);
  assert.equal(result.steps[1].detail, 'text not found: "Saved"');
  assert.equal(result.steps[2].detail, 'not run: step 1 (expect_text) failed');
  assert.ok(!calls.some(([name]) => name === 'screenshot'));
});

test('a soft failure is recorded and the run goes on; the run is not failed by it', async () => {
  const { driver } = fakeDriver({ expectText: false });
  const result = await run([expectText('Nope', { soft: true }), goto()], { driver });
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.steps.map(({ status, soft }) => [status, soft]), [['failed', true], ['passed', false]]);
  assert.deepEqual(result.summary, { passed: 1, failed: 0, soft_failed: 1, skipped: 0 });
});

test('without a browser the browser steps are skipped, HTTP steps still run, and the run is blocked', async () => {
  const result = await run([httpStep(), goto(), expectText('x'), httpStep({ url: '/api' })], { driver: null, driverProblem: 'no browser was found' });
  assert.equal(result.outcome, 'blocked');
  assert.deepEqual(result.steps.map(({ status }) => status), ['passed', 'skipped', 'skipped', 'passed']);
  assert.equal(result.steps[1].detail, 'not run: no browser (no browser was found)');
  assert.equal(result.block, 'no_browser');
});

test('an HTTP-only scenario needs no browser at all and passes', async () => {
  const result = await run([httpStep(), httpStep({ url: '/api' })], { driver: null });
  assert.equal(result.outcome, 'passed');
  assert.equal(result.block, null);
});

test('a failed HTTP step fails the run like any hard step', async () => {
  const result = await run([httpStep(), httpStep()], { http: http('failed'), driver: null });
  assert.deepEqual([result.outcome, ...result.steps.map(({ status }) => status)], ['failed', 'failed', 'skipped']);
});

test('goto resolves a path against the launch URL; click, fill, press, wait_for and viewport reach the driver as declared', async () => {
  const { driver, calls } = fakeDriver();
  await run([
    goto('/form'),
    { step: 'click', text: 'Save', selector: null, role: null, name: null, soft: false },
    { step: 'click', text: null, selector: '#go', role: null, name: null, soft: false },
    { step: 'click', text: null, selector: null, role: 'button', name: 'Greet', soft: false },
    { step: 'fill', selector: '#name', value: 'Ada', soft: false },
    { step: 'press', key: 'Enter', soft: false },
    { step: 'wait_for', text: 'Hello', selector: null, url: null, timeout_ms: 1500, soft: false },
    { step: 'wait_for', text: null, selector: '#out', url: null, timeout_ms: null, soft: false },
    { step: 'viewport', width: 390, height: 844, soft: false },
  ], { driver });
  assert.deepEqual(calls, [
    ['goto', 'http://127.0.0.1:3000/form'],
    ['click', { text: 'Save' }],
    ['click', { selector: '#go' }],
    ['click', { role: 'button', name: 'Greet' }],
    ['fill', '#name', 'Ada'],
    ['press', 'Enter'],
    ['waitFor', { text: 'Hello' }, 1500],
    ['waitFor', { selector: '#out' }, 5000],
    ['viewport', 390, 844],
  ]);
});

test('a wait that times out fails with what was awaited', async () => {
  const { driver } = fakeDriver({ waitFor: false });
  const result = await run([{ step: 'wait_for', text: 'Never', selector: null, url: null, timeout_ms: 200, soft: false }], { driver });
  assert.equal(result.steps[0].detail, 'not seen within 200 ms: text "Never"');
});

test('expect_no_console_errors fails with the first error, cut and counted', async () => {
  const errors = [{ kind: 'console', text: `boom ${'x'.repeat(400)}`, url: null, line: null }, { kind: 'exception', text: 'second', url: null, line: null }];
  const { driver } = fakeDriver({ consoleErrors: errors });
  const result = await run([{ step: 'expect_no_console_errors', soft: false }], { driver });
  assert.equal(result.outcome, 'failed');
  assert.match(result.steps[0].detail, /^2 console errors since the last goto; first: console: boom x+/);
  assert.ok(result.steps[0].detail.length < 260);
});

test('measure passes under its budget, fails over it or when it cannot be measured, and only reports without a budget', async () => {
  const measure = (budget) => [{ step: 'measure', metric: 'load', budget_ms: budget, soft: false }];
  assert.equal((await run(measure(500), { driver: fakeDriver({ measure: 120 }).driver })).steps[0].detail, 'load 120 ms (budget 500 ms)');
  const over = await run(measure(100), { driver: fakeDriver({ measure: 480 }).driver });
  assert.deepEqual([over.outcome, over.steps[0].detail], ['failed', 'load 480 ms is over the budget of 100 ms']);
  const missing = await run(measure(100), { driver: fakeDriver({ measure: null }).driver });
  assert.equal(missing.steps[0].detail, 'load could not be measured');
  const free = await run(measure(null), { driver: fakeDriver({ measure: 7000 }).driver });
  assert.deepEqual([free.outcome, free.steps[0].detail], ['passed', 'load 7000 ms (no budget)']);
});

test('a screenshot is an artifact of its step named after the step', async () => {
  const { driver } = fakeDriver({ screenshot: Buffer.from('IMG') });
  const result = await run([goto(), { step: 'screenshot', name: 'home', soft: false }], { driver });
  assert.deepEqual(result.artifacts.map(({ step, type, name, data }) => [step, type, name, data.toString()]), [[1, 'screenshot', 'home.png', 'IMG']]);
});

test('a driver that throws fails its step with the message, cut to one line', async () => {
  const { driver } = fakeDriver({ goto: new Error('navigation failed: net::ERR_CONNECTION_REFUSED\nstack...') });
  const result = await run([goto()], { driver });
  assert.deepEqual([result.steps[0].status, result.steps[0].detail], ['failed', 'navigation failed: net::ERR_CONNECTION_REFUSED']);
});

test('facts are told in order: started, then each step started and finished', async () => {
  const facts = [];
  await run([goto(), httpStep()], { driver: fakeDriver().driver, onFact: (fact) => facts.push(fact.type + (fact.index === undefined ? '' : `:${fact.index}`)) });
  assert.deepEqual(facts, ['steps_started', 'step_started:0', 'step_finished:0', 'step_started:1', 'step_finished:1']);
});

test('an abort stops between steps: the remaining steps are skipped and the outcome is interrupted', async () => {
  const controller = new AbortController();
  const { driver } = fakeDriver({ goto: () => controller.abort() });
  const result = await run([goto(), expectText('x')], { driver, signal: controller.signal });
  assert.equal(result.outcome, 'interrupted');
  assert.equal(result.steps[1].detail, 'not run: interrupted');
});
