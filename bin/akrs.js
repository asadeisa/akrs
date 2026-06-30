#!/usr/bin/env node
// AKRS CLI — copies the framework docs into a developer's project.
// Usage:
//   npx akrs init            Copy the AKRS framework into ./docs/akrs/
//   npx akrs init --force    Overwrite ./docs/akrs/ if it already exists

import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..'); // the installed package root
const cwd = process.cwd();

const args = process.argv.slice(2);
const command = args[0];
const force = args.includes('--force') || args.includes('-f');

const HELP = `
AKRS — Adaptive Knowledge Routing System

Usage
  npx akrs init           Copy the AKRS framework docs into ./docs/akrs/
  npx akrs init --force   Overwrite ./docs/akrs/ if it already exists

What 'init' copies into your project (./docs/akrs/):
  GETTING_STARTED.md      The human on-ramp
  framework/              The doctrine the Leader reads (01..08)
  guides/                 Routing flow + file structure (with diagrams)

Docs & issues: https://github.com/asadeisa/akrs
`;

if (command !== 'init') {
  process.stdout.write(HELP);
  process.exit(command ? 1 : 0);
}

const target = join(cwd, 'docs', 'akrs');

if (existsSync(target) && !force) {
  process.stderr.write(
    `\nAKRS: "${relative(cwd, target) || target}" already exists.\n` +
      `Re-run with --force to overwrite:\n\n    npx akrs init --force\n\n`,
  );
  process.exit(1);
}

// (source in package) -> (destination in the user's project)
const copies = [
  ['docs/framework', join(target, 'framework')],
  ['docs/guides', join(target, 'guides')],
  ['GETTING_STARTED.md', join(target, 'GETTING_STARTED.md')],
];

mkdirSync(target, { recursive: true });

for (const [src, dest] of copies) {
  const from = join(pkgRoot, src);
  if (!existsSync(from)) {
    process.stderr.write(`AKRS: missing in package, skipped: ${src}\n`);
    continue;
  }
  cpSync(from, dest, { recursive: true, force: true });
}

const rel = relative(cwd, target) || target;
process.stdout.write(
  `\n✅ AKRS framework copied to ${rel}\n\n` +
    `Next steps:\n` +
    `  1. Read   ${join(rel, 'GETTING_STARTED.md')}\n` +
    `  2. Point your Leader model at ${join(rel, 'framework')}\n` +
    `  3. Generate your workflow (Phase A), then your first Task + Road.\n\n`,
);
