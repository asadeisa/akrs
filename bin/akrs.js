#!/usr/bin/env node

import {
  checkNodeVersion,
  failureExitCode,
  formatInternalError,
  refusalExitCode,
} from './node-guard.js';

async function main(argv) {
  const { commandHandlers, commandManifest } = await import('../lib/core/index.js');
  const { runCliAdapter } = await import('./cli-adapter.js');

  const result = await runCliAdapter({
    argv,
    cwd: process.cwd(),
    manifest: commandManifest,
    handlers: commandHandlers,
    // streamed events leave the process the moment they exist
    write: (text) => process.stdout.write(text),
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

const argv = process.argv.slice(2);
const nodeCheck = checkNodeVersion(process.versions.node);
if (nodeCheck.ok) {
  main(argv).catch((error) => {
    process.stderr.write(formatInternalError(error));
    process.exitCode = failureExitCode(argv);
  });
} else {
  process.stderr.write(nodeCheck.message);
  process.exitCode = refusalExitCode(argv);
}
