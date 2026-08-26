import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../../bin/akrs.js', import.meta.url));

export function injectedEnvironment(overrides = {}) {
  return {
    ...process.env,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    TZ: 'UTC',
    ...overrides,
  };
}

export function runProcess(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: injectedEnvironment(options.env),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? 10_000);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const stdoutBytes = Buffer.concat(stdout);
      const stderrBytes = Buffer.concat(stderr);
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout: stdoutBytes.toString('utf8'),
        stderr: stderrBytes.toString('utf8'),
        stdoutBytes,
        stderrBytes,
      });
    });

    if (options.stdin === undefined) child.stdin.end();
    else child.stdin.end(options.stdin);
  });
}

export function runNode(args, options) {
  return runProcess(process.execPath, args, options);
}

export function runCli(args, options) {
  return runNode([cliPath, ...args], options);
}
