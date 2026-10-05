#!/usr/bin/env node
// The pre-write hook entry point (A1 5.4): one path in, allow or deny out. It imports only the guard core (node built-ins), never the
// manifest, the schemas or the snapshot engine, so a hook costs one small module load. Hooks run `node <abs>/bin/akrs-guard.js`, never a shim.
//
//   node bin/akrs-guard.js <path> [--executor <id>] [--root <dir>] [--workflow-root <dir>]
//   a hook payload on stdin (JSON with tool_input.file_path | tool_input.path | file_path | path) replaces <path>
//
// stdout: one JSON line { decision, reason, path, road, detail }. Exit 0 = allow, 2 = deny (the reason on stderr). A failure of the guard
// itself is an allow (fail-open): `audit` is the backstop.
import { GUARD_ENV_VARIABLE, decideWrite, denialMessage, locateRoots } from '../lib/store/intents/guard-core.js';

const FLAGS = new Set(['--executor', '--root', '--workflow-root']);

function parse(argv) {
  const flags = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (FLAGS.has(value)) {
      flags[value] = argv[index + 1];
      index += 1;
    } else if (value === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    } else {
      positionals.push(value);
    }
  }
  return { flags, positionals };
}

function pathOfPayload(text) {
  const payload = JSON.parse(text);
  const input = payload?.tool_input ?? payload;
  for (const key of ['file_path', 'path', 'filePath']) if (typeof input?.[key] === 'string') return input[key];
  return null;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const { flags, positionals } = parse(process.argv.slice(2));
  let path = positionals[0] ?? null;
  if (path === null) path = pathOfPayload(await readStdin());
  const { repositoryRoot, workflowRoot } = locateRoots({ cwd: process.cwd(), root: flags['--root'] ?? null, workflowRoot: flags['--workflow-root'] ?? null });
  const result = decideWrite({ path, executor: flags['--executor'] ?? process.env[GUARD_ENV_VARIABLE] ?? null, repositoryRoot, workflowRoot });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.decision === 'deny') {
    process.stderr.write(`akrs guard: ${denialMessage(result)}\n`);
    process.exitCode = 2;
  }
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({ schema: 'akrs.guard/v1', decision: 'allow', reason: 'guard_error', path: null, road: null, detail: null })}\n`);
});
