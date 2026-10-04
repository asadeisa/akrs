// The orchestration of one scenario run: setup commands, launch, readiness, browser, steps, stop, teardown. It returns the
// mechanical facts and the evidence artifacts in memory; it writes no workflow file and holds no lock (an execution never does).
import { discoverBrowser } from '../browser/discovery.js';
import { runCheck } from '../store/verify/runner.js';
import { startApp } from './app.js';
import { openRealDriver } from './driver.js';
import { runHttpStep } from './http.js';
import { needsBrowser, runSteps } from './steps.js';

const text = (value) => Buffer.from(value, 'utf8');
const LOG_CAP = 65536;
const NETWORK_CAP = 262144;
const cut = (value, cap) => (Buffer.byteLength(value) > cap ? `${Buffer.from(value).subarray(0, cap).toString('utf8')}\n... cut at ${cap} bytes\n` : value);

function appLog(output) {
  const part = (name, record) => (record.total_bytes === 0 ? '' : `== ${name} (${record.total_bytes} bytes${record.truncated ? ', head and tail kept' : ''}) ==\n${record.text}${record.tail === null ? '' : `\n... \n${record.tail}`}\n`);
  const joined = `${part('stdout', output.stdout)}${part('stderr', output.stderr)}`;
  return joined === '' ? 'the app printed nothing\n' : joined;
}

const skippedSteps = (steps, detail) => steps.map((entry, index) => ({ index, step: entry.step, status: 'skipped', soft: entry.soft === true, duration_ms: 0, detail, evidence: [] }));
const emptySummary = (steps) => ({ passed: 0, failed: 0, soft_failed: 0, skipped: steps.length });

// options: { contract, repositoryRoot, env, platform, signal?, onFact?, deps?, now? }
// deps: { discoverBrowser, openDriver, fetchImpl }  (test seams; the defaults are the real ones)
// -> { outcome: passed|failed|blocked|interrupted, block, message, steps, summary, artifacts, setup, teardown, app, browser, browser_problem }
export async function executeScenario({ contract, repositoryRoot, env = process.env, platform = process.platform, signal = null, onFact = null, deps = {}, now = Date.now }) {
  const wanted = new Set(contract.evidence_types);
  const artifacts = [];
  const artifact = (type, name, data) => {
    if (!wanted.has(type)) return;
    artifacts.push({ step: null, type, name, data: Buffer.from(data) });
    onFact?.({ type: 'artifact', artifact: { type, name, bytes: Buffer.byteLength(data) } });
  };
  const steps = contract.scenario;
  const result = { outcome: 'passed', block: null, message: null, steps: [], summary: emptySummary(steps), artifacts, setup: [], teardown: [], app: { ready_ms: null, termination: 'none' }, browser: null, browser_problem: null };
  const runCommands = async (commands, phase, into) => {
    for (const [index, command] of commands.entries()) {
      onFact?.({ type: 'progress', phase: `${phase}_started`, index, name: command.name });
      const record = await runCheck({ argv: command.argv, cwd: repositoryRoot, timeoutMs: contract.timeout_ms, env, platform, signal });
      into.push({ name: command.name, status: record.status, exit_code: record.exit_code, duration_ms: record.duration_ms });
      onFact?.({ type: 'progress', phase: `${phase}_finished`, index, name: command.name, status: record.status, duration_ms: record.duration_ms });
      if (record.status === 'interrupted') return 'interrupted';
      if (record.status !== 'passed' && phase === 'setup') return 'failed';
    }
    return 'passed';
  };
  const stopped = () => ({ ...result, outcome: 'interrupted', block: null, steps: result.steps.length === 0 ? skippedSteps(steps, 'not run: interrupted') : result.steps });
  const finishBlocked = async (block, message) => {
    result.outcome = 'blocked';
    result.block = block;
    result.message = message;
    result.steps = skippedSteps(steps, `not run: ${message}`);
    if ((await runCommands(contract.teardown, 'teardown', result.teardown)) === 'interrupted') return stopped();
    return result;
  };

  const setup = await runCommands(contract.setup, 'setup', result.setup);
  if (setup === 'interrupted') return stopped();
  if (setup === 'failed') return finishBlocked('setup_failed', `setup command ${result.setup.at(-1).name} did not pass`);

  onFact?.({ type: 'progress', phase: 'app_launching' });
  const started = await startApp({
    argv: contract.launch.argv, cwd: repositoryRoot, env, platform, launchUrl: contract.launch.url, ready: contract.launch.ready, signal, fetchImpl: deps.fetchImpl,
  });
  if (!started.ok) {
    artifact('log', 'app.log', cut(appLog(started.output), LOG_CAP));
    if (started.reason === 'interrupted') return stopped();
    return finishBlocked(started.reason === 'ready_timeout' ? 'ready_timeout' : 'launch_failed', started.message);
  }
  result.app.ready_ms = started.ready_ms;
  onFact?.({ type: 'progress', phase: 'app_ready', duration_ms: started.ready_ms });

  let opened = null;
  let driverProblem = null;
  if (needsBrowser(steps)) {
    const discovered = (deps.discoverBrowser ?? discoverBrowser)({ platform, env });
    if (!discovered.ok) {
      result.browser_problem = discovered;
      driverProblem = discovered.reason;
    } else {
      const attempt = await (deps.openDriver ?? openRealDriver)({ executable: discovered.path, env, platform, signal, timeoutMs: contract.timeout_ms });
      if (attempt.ok) {
        opened = attempt;
        result.browser = attempt.browser;
      } else {
        result.browser_problem = { ok: false, reason: 'launch_failed', tried: [{ source: 'launch', path: discovered.path }], remediation: attempt.message };
        driverProblem = attempt.message;
      }
    }
  }

  const baseUrl = contract.launch.url;
  const ran = await runSteps({
    steps, driver: opened?.driver ?? null, driverProblem, baseUrl, timeoutMs: contract.timeout_ms, now, signal, onFact,
    http: (step) => runHttpStep(step, { baseUrl, allowedHosts: contract.allowed_hosts, timeoutMs: contract.timeout_ms, fetchImpl: deps.fetchImpl }),
  });
  result.steps = ran.steps;
  result.summary = ran.summary;
  result.artifacts.push(...ran.artifacts.filter((entry) => wanted.has(entry.type)));
  for (const entry of ran.artifacts) onFact?.({ type: 'artifact', artifact: { type: entry.type, name: entry.name, bytes: entry.data.length } });
  result.outcome = ran.outcome;
  result.block = ran.block;
  if (ran.block === 'no_browser') result.message = `no browser (${driverProblem})`;

  if (opened !== null) {
    const collect = async (type, name, produce, cap) => {
      try {
        artifact(type, name, cut(await produce(), cap));
      } catch {
        // a page that is already gone has nothing more to say
      }
    };
    await collect('console', 'console.log', () => opened.driver.consoleLog(), LOG_CAP);
    await collect('network', 'network.json', () => opened.driver.networkLog(), NETWORK_CAP);
    await collect('a11y', 'a11y.txt', () => opened.driver.a11yText(), LOG_CAP);
    await collect('timing', 'timing.json', async () => `${JSON.stringify(await opened.driver.timings(), null, 2)}\n`, LOG_CAP);
    await opened.close?.();
  }

  const stop = await started.app.stop();
  result.app.termination = stop.termination;
  onFact?.({ type: 'progress', phase: 'app_stopped' });
  artifact('log', 'app.log', cut(appLog(started.app.output()), LOG_CAP));

  if (result.outcome !== 'interrupted' && (await runCommands(contract.teardown, 'teardown', result.teardown)) === 'interrupted') result.outcome = 'interrupted';
  return result;
}
