// Crash worker for the P1-W05 tests. It does nothing without a JSON config argument, because `node --test` also
// executes every .js file under test/ directly.
//
// It runs one transactional mutation and terminates ITSELF with SIGKILL right after the `killAt`-th boundary fired
// (0-based): no cleanup, no handlers, no flushed buffers. That is the crash the packet requires; a caught exception
// inside one process would not prove anything.
import { runTransactionalMutation } from '../../../lib/store/transactions/index.js';
import { SCENARIOS, UNRELATED, scenarioOptions } from './scenarios.js';

const raw = process.argv[2];
if (raw !== undefined) await main(JSON.parse(raw));

function crash() {
  process.kill(process.pid, 'SIGKILL');
  // The signal is asynchronous on some platforms; never let the mutation continue meanwhile.
  return new Promise(() => {});
}

async function main(config) {
  const scenario = config.scenario === 'unrelated' ? UNRELATED : SCENARIOS[config.scenario];
  if (scenario === undefined) throw new Error(`unknown scenario: ${config.scenario}`);
  let count = 0;
  const result = await runTransactionalMutation(scenarioOptions(config.options, scenario, {
    requestId: config.requestId,
    async boundary() {
      const current = count;
      count += 1;
      if (config.killAt !== null && config.killAt !== undefined && current === config.killAt) await crash();
    },
  }));
  process.stdout.write(`${JSON.stringify({
    completed: true, outcome: result.outcome, request_id: result.request_id, boundaries: count,
  })}\n`);
}
