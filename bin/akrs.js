#!/usr/bin/env node

import {
  checkNodeVersion,
  failureExitCode,
  formatInternalError,
  refusalExitCode,
} from './node-guard.js';

// `akrs mcp` serves MCP over stdio (stdout carries protocol frames only); with an output format flag it is an ordinary packet command.
const OUTPUT_FORMATS = ['--json', '--jsonl', '--prompt'];

async function main(argv) {
  const { commandHandlers, commandManifest } = await import('../lib/core/index.js');
  if (argv[0] === 'mcp' && !argv.some((token) => OUTPUT_FORMATS.includes(token))) {
    const { runMcpCommand } = await import('../lib/mcp/stdio.js');
    const { createDefaultProviders } = await import('../lib/core/providers.js');
    process.exitCode = await runMcpCommand({
      argv,
      cwd: process.cwd(),
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      manifest: commandManifest,
      handlers: commandHandlers,
      providers: createDefaultProviders(),
    });
    return;
  }
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
