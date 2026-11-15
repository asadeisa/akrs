#!/usr/bin/env node
// `npm create akrs` (or `npx create-akrs`): run `akrs init` from akrs-framework in the current directory, passing every argument through
// (`npm create akrs -- --force`, `npm create akrs -- --scaffold --plan P1`).
//
// akrs-framework is run through `npm exec`, exactly like `npx akrs-framework init`, and is deliberately not a dependency of this
// package: its postinstall skips an npm exec install, so nothing is written into the project before `init` itself runs.
import { spawn } from 'node:child_process';

const FRAMEWORK = 'akrs-framework@2';
const args = process.argv.slice(2);
const execArgs = ['exec', '--yes', `--package=${FRAMEWORK}`, '--', 'akrs', 'init', ...args];

// Under `npm create`, npm names its own CLI in npm_execpath: reuse it so the same npm runs the framework. Otherwise call npm from PATH
// (through the shell on Windows, where npm is a .cmd shim).
const npmCli = process.env.npm_execpath;
const viaNode = typeof npmCli === 'string' && /npm-cli\.c?js$/.test(npmCli);
const command = viaNode ? process.execPath : 'npm';
const commandArgs = viaNode ? [npmCli, ...execArgs] : execArgs;
const quote = (value) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`);

const child = viaNode || process.platform !== 'win32'
  ? spawn(command, commandArgs, { stdio: 'inherit' })
  : spawn([command, ...commandArgs].map(quote).join(' '), { stdio: 'inherit', shell: true });

child.on('error', (error) => {
  process.stderr.write(`create-akrs: could not run npm (${error.message}). Run instead: npx ${FRAMEWORK} init\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
