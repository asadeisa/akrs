// Child-process fixture for the P1-W03 lock tests. It does nothing without a JSON config argument, because
// `node --test` also executes every .js file under test/ directly.
import { appendFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireRepositoryLock } from '../../../lib/store/lock/index.js';

const raw = process.argv[2];
if (raw !== undefined) await main(JSON.parse(raw));

function summarize(result) {
  if (result.status !== 'acquired') return result;
  return {
    status: result.status,
    recovered: result.recovered,
    waited_ms: result.waited_ms,
    attempts: result.attempts,
    lock_path: result.lock_path,
    run_id: result.handle.run_id,
    pid: process.pid,
  };
}

async function main(config) {
  const options = {
    ...config.options,
    command: config.command ?? 'test worker',
    timeoutMs: config.timeoutMs,
    retryMs: config.retryMs,
  };
  if (config.fixedNow !== undefined) options.clock = () => new Date(config.fixedNow);

  if (config.mode === 'critical') {
    const recovered = [];
    for (let iteration = 0; iteration < config.iterations; iteration += 1) {
      const result = await acquireRepositoryLock(options);
      if (result.status !== 'acquired') {
        process.stderr.write(`${JSON.stringify(result)}\n`);
        process.exit(3);
      }
      if (result.recovered) recovered.push(result.recovered);
      await appendFile(config.markerFile, `enter ${config.id}\n`);
      await delay(config.holdMs ?? 5);
      await appendFile(config.markerFile, `exit ${config.id}\n`);
      const released = await result.handle.release();
      if (released.released !== true) {
        process.stderr.write(`${JSON.stringify(released)}\n`);
        process.exit(4);
      }
    }
    process.stdout.write(`${JSON.stringify({ id: config.id, acquisitions: config.iterations, recovered })}\n`);
    return;
  }

  if (config.mode === 'hold') {
    const result = await acquireRepositoryLock(options);
    process.stdout.write(`${JSON.stringify(summarize(result))}\n`);
    if (result.status !== 'acquired') process.exit(3);
    // Stay alive holding the lock until the test terminates this process.
    setInterval(() => {}, 1000);
    return;
  }

  if (config.mode === 'once') {
    const result = await acquireRepositoryLock(options);
    if (result.status === 'acquired') {
      await delay(config.holdMs ?? 20);
      const released = await result.handle.release();
      process.stdout.write(`${JSON.stringify({ ...summarize(result), released: released })}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(summarize(result))}\n`);
    }
    return;
  }

  throw new Error(`unknown worker mode: ${config.mode}`);
}
