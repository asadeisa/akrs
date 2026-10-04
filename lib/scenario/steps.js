// The scenario step executor: the closed vocabulary only, one structured result per step, the first hard failure stops
// the run unless the step is soft. It talks to a driver (browser) and an `http` function; it knows no process and no file.
import { SCENARIO_STEPS, validateScenarioStep } from '../schemas/verification.js';
import { cutLine } from './http.js';

const BROWSER_STEPS = new Set(SCENARIO_STEPS.filter((name) => name !== 'http'));
export const needsBrowser = (steps) => steps.some(({ step }) => BROWSER_STEPS.has(step));

// -> { ok, issues }: every step against the closed schema and the host rule, before anything runs
export function validateScenario(steps, { allowedHosts = [] } = {}) {
  const issues = [];
  if (!Array.isArray(steps)) return { ok: false, issues: [{ path: '$.scenario', code: 'invalid_type', message: 'must be an array' }] };
  steps.forEach((step, index) => validateScenarioStep(step, `$.scenario[${index}]`, issues, { allowedHosts }));
  const names = new Set();
  steps.forEach((step, index) => {
    if (step?.step !== 'screenshot' || typeof step.name !== 'string') return;
    if (names.has(step.name)) issues.push({ path: `$.scenario[${index}].name`, code: 'duplicate_value', message: `screenshot name ${step.name} is used twice` });
    names.add(step.name);
  });
  return { ok: issues.length === 0, issues };
}

const clickTarget = (step) => {
  if (step.text !== null && step.text !== undefined) return { text: step.text };
  if (step.selector !== null && step.selector !== undefined) return { selector: step.selector };
  return { role: step.role, name: step.name };
};
const waitTarget = (step) => {
  if (step.text !== null && step.text !== undefined) return { text: step.text };
  if (step.selector !== null && step.selector !== undefined) return { selector: step.selector };
  return { url: step.url };
};
const describeTarget = (target) => {
  const [kind, value] = Object.entries(target)[0];
  return `${kind} ${JSON.stringify(value)}`;
};
const pass = (detail = null) => ({ status: 'passed', detail });
const fail = (detail) => ({ status: 'failed', detail });

// options: { steps, driver, driverProblem?, baseUrl, timeoutMs, now, http(step), onFact?, signal? }
// -> { outcome: passed|failed|blocked|interrupted, block: null|'no_browser', steps, summary, artifacts }
export async function runSteps({ steps, driver, driverProblem = null, baseUrl, timeoutMs, now = () => Date.now(), http, onFact = null, signal = null }) {
  const results = [];
  const artifacts = [];
  let stoppedBy = null;
  let interrupted = false;
  let block = null;
  onFact?.({ type: 'steps_started', total: steps.length });

  const execute = async (step, index) => {
    switch (step.step) {
      case 'goto':
        await driver.goto(new URL(step.url, baseUrl).href);
        return pass();
      case 'click':
        await driver.click(clickTarget(step));
        return pass();
      case 'fill':
        await driver.fill(step.selector, step.value);
        return pass();
      case 'press':
        await driver.press(step.key);
        return pass();
      case 'wait_for': {
        const target = waitTarget(step);
        const limit = step.timeout_ms ?? timeoutMs;
        return (await driver.waitFor(target, limit)) ? pass() : fail(`not seen within ${limit} ms: ${describeTarget(target)}`);
      }
      case 'expect_text':
        return (await driver.expectText(step.text)) ? pass() : fail(`text not found: ${JSON.stringify(cutLine(step.text))}`);
      case 'expect_no_console_errors': {
        const errors = await driver.consoleErrors();
        if (errors.length === 0) return pass();
        return fail(`${errors.length} console ${errors.length === 1 ? 'error' : 'errors'} since the last goto; first: ${errors[0].kind}: ${cutLine(errors[0].text)}`);
      }
      case 'http':
        return http(step);
      case 'screenshot':
        artifacts.push({ step: index, type: 'screenshot', name: `${step.name}.png`, data: await driver.screenshot() });
        return pass();
      case 'measure': {
        const value = await driver.measure(step.metric);
        if (value === null || value === undefined) return fail(`${step.metric} could not be measured`);
        if (step.budget_ms === null || step.budget_ms === undefined) return pass(`${step.metric} ${value} ms (no budget)`);
        return value <= step.budget_ms ? pass(`${step.metric} ${value} ms (budget ${step.budget_ms} ms)`) : fail(`${step.metric} ${value} ms is over the budget of ${step.budget_ms} ms`);
      }
      case 'viewport':
        await driver.viewport(step.width, step.height);
        return pass();
      default:
        throw new TypeError(`unknown step: ${String(step.step)}`);
    }
  };

  for (const [index, step] of steps.entries()) {
    const base = { index, step: step.step, soft: step.soft === true };
    const skipped = (detail) => {
      results.push({ ...base, status: 'skipped', duration_ms: 0, detail, evidence: [] });
      onFact?.({ type: 'step_skipped', index, step: step.step });
    };
    if (signal?.aborted) interrupted = true;
    if (interrupted) {
      skipped('not run: interrupted');
      continue;
    }
    if (stoppedBy !== null) {
      skipped(`not run: step ${stoppedBy.index} (${stoppedBy.step}) failed`);
      continue;
    }
    if (BROWSER_STEPS.has(step.step) && driver === null) {
      block = 'no_browser';
      skipped(`not run: no browser${driverProblem === null ? '' : ` (${driverProblem})`}`);
      continue;
    }
    onFact?.({ type: 'step_started', index, step: step.step });
    const startedAt = now();
    let outcome;
    try {
      outcome = await execute(step, index);
    } catch (error) {
      outcome = fail(cutLine(error instanceof Error ? error.message : 'the step failed'));
    }
    const duration = Math.max(0, Math.round(now() - startedAt));
    results.push({ ...base, status: outcome.status, duration_ms: duration, detail: outcome.detail, evidence: [] });
    onFact?.({ type: 'step_finished', index, step: step.step, status: outcome.status, duration_ms: duration });
    if (outcome.status === 'failed' && !base.soft) stoppedBy = { index, step: step.step };
  }

  const summary = {
    passed: results.filter(({ status }) => status === 'passed').length,
    failed: results.filter(({ status, soft }) => status === 'failed' && !soft).length,
    soft_failed: results.filter(({ status, soft }) => status === 'failed' && soft).length,
    skipped: results.filter(({ status }) => status === 'skipped').length,
  };
  let outcome = 'passed';
  if (interrupted) outcome = 'interrupted';
  else if (stoppedBy !== null) outcome = 'failed';
  else if (block !== null) outcome = 'blocked';
  return { outcome, block: outcome === 'failed' || outcome === 'interrupted' ? null : block, steps: results, summary, artifacts };
}
