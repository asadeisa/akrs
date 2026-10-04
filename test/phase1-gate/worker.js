// Crash worker for the P1-W14 gate. It does nothing without a JSON config argument (`node --test` also executes every
// .js file under test/). It runs ONE real writer of cases.js and SIGKILLs itself right after the `killAt`-th boundary.
import { CASES, repoAt } from './cases.js';

const raw = process.argv[2];
if (raw !== undefined) await main(JSON.parse(raw));

function crash() {
  process.kill(process.pid, 'SIGKILL');
  return new Promise(() => {});
}

async function main(config) {
  let count = 0;
  const result = await CASES[config.caseId].run(repoAt(config.root), {
    ...config.extra,
    async boundary() {
      const current = count;
      count += 1;
      if (config.killAt !== null && config.killAt === current) await crash();
    },
  });
  process.stdout.write(`${JSON.stringify({ completed: true, outcome: result.outcome, boundaries: count })}\n`);
}
