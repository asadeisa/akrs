#!/usr/bin/env node

import {
  commandHandlers,
  commandManifest,
} from '../lib/core/index.js';
import { runCliAdapter } from './cli-adapter.js';

const result = await runCliAdapter({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  manifest: commandManifest,
  handlers: commandHandlers,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
