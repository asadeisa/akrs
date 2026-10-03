import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HTTP_METHODS,
  MEASURE_METRICS,
  SCENARIO_STEPS,
  SCENARIO_STEP_KEYS,
  validateScenarioStep,
  validateVerification,
} from '../../lib/schemas/verification.js';
import { clone, describeIssues, expectIssue, loadFixtures, setAt } from './schema-harness.js';

const full = (await loadFixtures('verification', 'valid')).find(({ name }) => name === 'full').value;

function step(value, options = {}) {
  const issues = [];
  validateScenarioStep(value, '$.s', issues, options);
  return { ok: issues.length === 0, issues };
}
const scenario = (steps, extra = {}) => ({ ...clone(full), scenario: steps, ...extra });

test('F18/Q21 scenario: the closed step vocabulary (Lock 20: no arbitrary JavaScript)', () => {
  assert.deepEqual(SCENARIO_STEPS, [
    'goto', 'click', 'fill', 'press', 'wait_for', 'expect_text', 'expect_no_console_errors', 'http',
    'screenshot', 'measure', 'viewport',
  ]);
  assert.deepEqual(HTTP_METHODS, ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
  assert.deepEqual(MEASURE_METRICS, ['lcp', 'load', 'ttfb']);
  assert.deepEqual(SCENARIO_STEP_KEYS, {
    goto: ['step', 'url', 'soft'],
    click: ['step', 'text', 'selector', 'role', 'name', 'soft'],
    fill: ['step', 'selector', 'value', 'soft'],
    press: ['step', 'key', 'soft'],
    wait_for: ['step', 'text', 'selector', 'url', 'timeout_ms', 'soft'],
    expect_text: ['step', 'text', 'soft'],
    expect_no_console_errors: ['step', 'soft'],
    http: ['step', 'method', 'url', 'headers', 'body', 'expect_status', 'expect_json', 'soft'],
    screenshot: ['step', 'name', 'soft'],
    measure: ['step', 'metric', 'budget_ms', 'soft'],
    viewport: ['step', 'width', 'height', 'soft'],
  });
  for (const forbidden of ['eval', 'script', 'evaluate', 'js', 'exec', 'run', 'shell', 'launch', 'ready']) {
    assert.equal(SCENARIO_STEPS.includes(forbidden), false, forbidden);
  }
});

test('Q21 scenario: every vocabulary step in the full fixture is valid (one per kind at least)', () => {
  const kinds = new Set(full.scenario.map(({ step: name }) => name));
  assert.deepEqual([...kinds].sort(), [...SCENARIO_STEPS].sort());
  for (const [index, value] of full.scenario.entries()) {
    const result = step(clone(value), { allowedHosts: ['staging.example.test'] });
    assert.equal(result.ok, true, `scenario[${index}] ${describeIssues(result)}`);
  }
});

test('Q21 scenario: unknown, missing or non-string discriminators fail with unknown_step / missing_key', () => {
  for (const name of ['eval', 'script', 'GOTO', 'goto ', '', 'launch']) {
    const result = validateVerification(scenario([{ step: name, soft: false }]), { form: 'stored' });
    assert.equal(result.issues.some((entry) => entry.code === 'unknown_step' && entry.path === '$.scenario[0].step'), true, `${JSON.stringify(name)} ${describeIssues(result)}`);
  }
  expectIssue(validateVerification(scenario([{ soft: false }]), { form: 'stored' }), 'missing_key', '$.scenario[0].step');
  expectIssue(validateVerification(scenario([42]), { form: 'stored' }), 'invalid_type', '$.scenario[0]');
});

test('Q21 scenario: exactly-one-of groups (click target, wait_for condition)', () => {
  const click = { step: 'click', text: null, selector: null, role: null, name: null, soft: false };
  for (const variant of [
    click,
    { ...click, text: 'a', selector: '#b' },
    { ...click, role: 'button' },
    { ...click, name: 'Open' },
    { ...click, text: 'a', role: 'button', name: 'Open' },
  ]) {
    assert.equal(step(variant).ok, false, JSON.stringify(variant));
  }
  assert.equal(step({ ...click, role: 'button', name: 'Open' }).ok, true);
  const wait = { step: 'wait_for', text: null, selector: null, url: null, timeout_ms: null, soft: false };
  for (const variant of [wait, { ...wait, text: 'a', selector: '.b' }, { ...wait, text: 'a', url: '/x' }]) {
    assert.equal(step(variant).ok, false, JSON.stringify(variant));
  }
  assert.equal(step({ ...wait, selector: '.b' }).ok, true);
});

test('Q21 scenario: http steps - methods, loopback-only unless allowed_hosts lists the host, no file/ftp/data URLs', () => {
  const http = (overrides) => ({
    step: 'http', method: 'GET', url: 'http://localhost:3000/api', headers: [], body: null, expect_status: 200,
    expect_json: null, soft: false, ...overrides,
  });
  for (const url of [
    'http://localhost:3000/a', 'http://127.0.0.1/a', 'http://127.255.255.254:81/a', 'https://localhost/a', 'http://[::1]:8080/a',
    '/api/health',
  ]) {
    assert.equal(step(http({ url })).ok, true, url);
  }
  for (const url of [
    'file:///etc/passwd', 'ftp://localhost/x', 'data:text/plain,hi', 'javascript:alert(1)', '//evil.test/x', 'http://user:pw@localhost/x',
    'http://example.com/x', 'http://localhost.evil.test/x', 'http://169.254.169.254/latest', '', 'localhost:3000/x', 'http://',
  ]) {
    const result = step(http({ url }));
    assert.equal(result.ok, false, url);
    assert.equal(result.issues.some((entry) => entry.path === '$.s.url'), true, `${url} ${describeIssues(result)}`);
  }
  assert.equal(step(http({ url: 'https://staging.example.test/x' }), { allowedHosts: ['staging.example.test'] }).ok, true);
  assert.equal(step(http({ url: 'https://staging.example.test:8443/x' }), { allowedHosts: ['staging.example.test'] }).ok, true, 'a listed host matches any port');
  assert.equal(step(http({ url: 'https://other.example.test/x' }), { allowedHosts: ['staging.example.test'] }).ok, false);
  for (const method of ['get', 'TRACE', 'CONNECT', '']) assert.equal(step(http({ method })).ok, false, method);
  for (const method of HTTP_METHODS) assert.equal(step(http({ method })).ok, true, method);
});

test('Q21 scenario: http expectations - at least one, status range, JSON Pointer, JSON-only equals', () => {
  const http = (overrides) => ({
    step: 'http', method: 'GET', url: '/api', headers: [], body: null, expect_status: 200, expect_json: null, soft: false, ...overrides,
  });
  assert.equal(step(http({ expect_status: null, expect_json: null })).ok, false, 'a step with no expectation proves nothing');
  for (const status of [99, 600, 200.5, '200']) assert.equal(step(http({ expect_status: status })).ok, false, String(status));
  for (const pointer of ['', '/a', '/a/0/b', '/a~1b', '/a~0b', '/']) {
    assert.equal(step(http({ expect_json: { pointer, equals: 1 } })).ok, true, pointer);
  }
  for (const pointer of ['a', '/a~', '/a~2', '$.a', '/a b\n']) {
    assert.equal(step(http({ expect_json: { pointer, equals: 1 } })).ok, false, pointer);
  }
  for (const equals of [null, true, 'x', 7, [1, 'a'], { k: [1, { z: null }] }]) {
    assert.equal(step(http({ expect_json: { pointer: '/a', equals } })).ok, true, JSON.stringify(equals));
  }
  assert.equal(step(http({ expect_json: { pointer: '/a', equals: 1.5 } })).ok, false, 'integers only in canonical JSON');
  for (const equals of [{ 0: 'x' }, { 10: 1 }, JSON.parse('{"__proto__": 1}'), JSON.parse('{"constructor": 1}')]) {
    assert.equal(step(http({ expect_json: { pointer: '/a', equals } })).ok, false, 'keys that cannot round-trip are rejected');
  }
  let deep = 1;
  for (let level = 0; level < 70; level += 1) deep = [deep];
  assert.equal(step(http({ expect_json: { pointer: '/a', equals: deep } })).ok, false, 'depth is bounded like the canonical writer');
  assert.equal(step(http({ headers: [{ name: 'content-type', value: 'a' }, { name: 'accept', value: 'b' }] })).ok, true);
  assert.equal(step(http({ headers: [{ name: 'Bad Name', value: 'a' }] })).ok, false);
  assert.equal(step(http({ headers: [{ name: 'x-a', value: 'a\r\nHost: evil' }] })).ok, false);
  assert.equal(step(http({ headers: [{ name: 'x-a', value: 'a' }, { name: 'x-a', value: 'b' }] })).ok, false, 'header names are unique');
  assert.equal(step(http({ headers: [{ name: 'X-A', value: 'a' }] })).ok, false, 'header names are lower-case tokens');
});

test('Q21 scenario: viewport, measure, press, screenshot bounds', () => {
  assert.equal(step({ step: 'viewport', width: 390, height: 844, soft: false }).ok, true);
  for (const [width, height] of [[0, 1], [1, 0], [10001, 1], [1.5, 2], [-1, 5]]) {
    assert.equal(step({ step: 'viewport', width, height, soft: false }).ok, false, `${width}x${height}`);
  }
  for (const metric of MEASURE_METRICS) assert.equal(step({ step: 'measure', metric, budget_ms: null, soft: false }).ok, true, metric);
  for (const budget of [0, -1, 1.5, '5']) assert.equal(step({ step: 'measure', metric: 'lcp', budget_ms: budget, soft: false }).ok, false, String(budget));
  for (const key of ['Enter', 'Control+S', 'ArrowDown', 'a']) assert.equal(step({ step: 'press', key, soft: false }).ok, true, key);
  for (const key of ['', 'Ctrl S', 'a\nb', 'x'.repeat(33)]) assert.equal(step({ step: 'press', key, soft: false }).ok, false, JSON.stringify(key));
  for (const name of ['after-save', 'a1']) assert.equal(step({ step: 'screenshot', name, soft: false }).ok, true, name);
  for (const name of ['../x', 'a/b', 'a b', '', 'x'.repeat(65)]) assert.equal(step({ step: 'screenshot', name, soft: false }).ok, false, JSON.stringify(name));
});

test('Q21 scenario: soft is a boolean on every step; selectors and text are non-empty single values', () => {
  for (const [index, value] of full.scenario.entries()) {
    const missing = clone(value);
    delete missing.soft;
    assert.equal(step(missing).ok, false, `scenario[${index}] without soft`);
    assert.equal(step({ ...clone(value), soft: 'no' }).ok, false, `scenario[${index}] soft not boolean`);
  }
  assert.equal(step({ step: 'fill', selector: '', value: 'x', soft: false }).ok, false);
  assert.equal(step({ step: 'fill', selector: '#a', value: '', soft: false }).ok, true, 'filling an empty value clears a field');
  assert.equal(step({ step: 'expect_text', text: '', soft: false }).ok, false);
  assert.equal(step({ step: 'goto', url: 'javascript:alert(1)', soft: false }).ok, false);
});

test('Q21 scenario: the contract carries no executable-code key anywhere', () => {
  for (const key of ['script', 'eval', 'code', 'js']) {
    expectIssue(validateVerification({ ...clone(full), [key]: 'x' }, { form: 'stored' }), 'unknown_key', `$.${key}`);
    const withCode = scenario([{ step: 'goto', url: '/x', soft: false, [key]: 'x' }]);
    expectIssue(validateVerification(withCode, { form: 'stored' }), 'unknown_key', `$.scenario[0].${key}`);
  }
});

test('Q21 scenario: step-level http host policy follows the contract allowed_hosts', () => {
  const external = scenario([{
    step: 'http', method: 'GET', url: 'https://staging.example.test/x', headers: [], body: null,
    expect_status: 200, expect_json: null, soft: false,
  }], { allowed_hosts: [] });
  expectIssue(validateVerification(external, { form: 'stored' }), 'invalid_value', '$.scenario[0].url');
  const listed = setAt(clone(external), 'allowed_hosts', ['staging.example.test']);
  assert.equal(validateVerification(listed, { form: 'stored' }).ok, true);
});

test('NIT loopback: only exact localhost, 127.0.0.0/8 and [::1] are implicit; *.localhost needs allowed_hosts', () => {
  const http = (url) => ({ step: 'http', method: 'GET', url, headers: [], body: null, expect_status: 200, expect_json: null, soft: false });
  assert.equal(step(http('http://app.localhost/a')).ok, false);
  assert.equal(step(http('http://a.b.localhost:3000/a')).ok, false);
  assert.equal(step(http('http://app.localhost/a'), { allowedHosts: ['app.localhost'] }).ok, true);
  assert.equal(step(http('http://localhost/a')).ok, true);
});
