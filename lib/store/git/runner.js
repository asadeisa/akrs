// The only place that starts git: argv arrays, no shell, a fixed locale, no optional locks (so a status never writes the
// index). It never throws: a missing program and a non-zero exit are results.
import { execFile } from 'node:child_process';

const MAX_BUFFER = 256 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

// -> { ok, unavailable, code, stdout: Buffer, stderr: Buffer }
export function runGit(cwd, args, { input = null } = {}) {
  return new Promise((resolve) => {
    const child = execFile('git', ['--no-optional-locks', '-c', 'core.quotepath=off', ...args], {
      cwd, encoding: 'buffer', maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS, windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout, stderr) => {
      if (error === null) return resolve({ ok: true, unavailable: false, code: 0, stdout, stderr });
      return resolve({ ok: false, unavailable: error.code === 'ENOENT', code: typeof error.code === 'number' ? error.code : null, stdout: stdout ?? Buffer.alloc(0), stderr: stderr ?? Buffer.alloc(0) });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? undefined);
  });
}
