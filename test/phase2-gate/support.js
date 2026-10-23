// Shared helpers of the v2.0.0 release gate (P2-W11). Every project lives under the dedicated pack sandbox and every command runs through the
// INSTALLED copy of the packed tarball in a separate process, never through the checkout. A call made as an agent (Worker or Tester) is
// counted and refused if it carries bookkeeping (A1 AX2/AX4: no hash, snapshot flag or request ID is ever typed by an agent).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { injectedEnvironment, runNode, runProcess } from '../helpers/process.js';
import { describeFailure } from '../package/pack-harness.js';

const BOOKKEEPING = ['--if-snapshot', '--request-id'];
export const EXECUTORS = Object.freeze([
  { id: 'lead', role: 'leader', class: 'frontier' },
  { id: 'worker', role: 'worker', class: 'weak' },
  { id: 'tester', role: 'tester', class: 'weak' },
]);
export const SENTENCE = 'This project serves its README over HTTP.';

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export const APP_SOURCE = `import { createServer } from 'node:http';
const port = Number(process.argv[2]);
createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('hello');
}).listen(port, '127.0.0.1');
`;

// A machine-checkable placeholder: an argument that is an angle-bracket or brace template, or empty.
export const hasPlaceholder = (argument) => typeof argument !== 'string' || argument === '' || /[<>{}]/.test(argument);

// A1 AX gate 5: every next command runs as it is (no placeholder, no empty argument), and a packet that is not ok says what to do: a next
// command, or a finding whose message names the action or the missing input. `<root>` is the fixtures' own stand-in for the machine root.
export function assertActionable(packet, label = packet.command) {
  for (const { command, args } of packet.next_commands) {
    assert.ok(Array.isArray(args) && args.every((argument) => typeof argument === 'string' && argument !== '' && !/[<>{}]/.test(argument.replaceAll('<root>', ''))),
      `${label}: the next command ${command} has a placeholder or an empty argument: ${JSON.stringify(args)}`);
  }
  if (packet.status === 'ok' || packet.status === 'noop') return;
  const named = packet.findings.some(({ message }) => typeof message === 'string' && message.trim().length >= 20);
  assert.ok(packet.next_commands.length > 0 || named, `${label}: a ${packet.status} packet offers neither a next command nor a finding that says what to do`);
}

// A digest of every file under a directory (path and bytes), skipping the listed top-level names (for example .git or a cache).
export async function digestTree(root, { skip = ['.git'] } = {}) {
  const hash = createHash('sha256');
  const walk = async (directory, prefix) => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => (left.name < right.name ? -1 : 1));
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (skip.includes(path)) continue;
      if (entry.isDirectory()) await walk(join(directory, entry.name), path);
      else hash.update(`${path}:`).update(await readFile(join(directory, entry.name))).update(';');
    }
  };
  await walk(root, '');
  return hash.digest('hex');
}

export async function git(root, args) {
  const result = await runProcess('git', args, { cwd: root, env: { GIT_OPTIONAL_LOCKS: '0' }, timeoutMs: 60_000 });
  assert.equal(result.exitCode, 0, describeFailure(`git ${args.join(' ')}`, result));
  return result.stdout;
}

export async function writeFiles(root, files) {
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }
}

export async function commitAll(root, message = 'baseline') {
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '-m', message]);
}

// A JSON-RPC client over a real `node <installed>/bin/akrs.js mcp` child process (newline-delimited messages on stdout, logs on stderr).
export function spawnInstalledServer(binPath, cwd) {
  const child = spawn(process.execPath, [binPath, 'mcp'], { cwd, env: injectedEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const stdoutChunks = [];
  let stderr = '';
  let buffered = '';
  const lines = [];
  const waiters = [];
  let nextId = 1;
  child.stdout.on('data', (chunk) => {
    stdoutChunks.push(chunk);
    buffered += chunk.toString('utf8');
    let index = buffered.indexOf('\n');
    while (index !== -1) {
      lines.push(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
      index = buffered.indexOf('\n');
    }
    for (const waiter of [...waiters]) waiter();
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  const timer = setTimeout(() => child.kill(), 120_000);
  exited.then(() => clearTimeout(timer));
  const server = {
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    response(id) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = lines.map((line) => JSON.parse(line)).find((message) => message.id === id);
          if (found) {
            waiters.splice(waiters.indexOf(check), 1);
            resolve(found);
          }
        };
        waiters.push(check);
        exited.then(() => reject(new Error(`server exited before answering ${id}; stderr: ${stderr}`)));
        check();
      });
    },
    async request(method, params) {
      const id = nextId++;
      server.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      return server.response(id);
    },
    async finish() {
      child.stdin.end();
      const status = await exited;
      return { ...status, stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr, lines };
    },
  };
  return server;
}

// A git repository under the sandbox, driven through the installed bin.
export async function createProject(sandbox, installed, name, files = {}) {
  const root = sandbox.inside(join(sandbox.root, name));
  await mkdir(root, { recursive: true });
  await git(root, ['init', '-q']);
  for (const [key, value] of [['user.email', 'gate@example.test'], ['user.name', 'gate'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) {
    await git(root, ['config', key, value]);
  }
  await writeFiles(root, { 'README.md': '# Demo\n', 'package.json': '{ "type": "module" }\n', ...files });

  const agentCalls = [];
  const project = {
    root,
    agentCalls,
    path: (...parts) => join(root, ...parts),
    read: (path) => readFile(join(root, ...path.split('/')), 'utf8'),
    readJson: async (path) => JSON.parse(await project.read(path)),
    write: (path, text) => writeFiles(root, { [path]: text }),
    commit: (message) => commitAll(root, message),
    // One CLI call from the installed package. JSON mode keeps stderr empty and stdout one packet.
    async run(argv, { stdin, expect = [0], env } = {}) {
      const format = argv.some((argument) => ['--json', '--prompt', '--jsonl'].includes(argument)) ? [] : ['--json'];
      const result = await runNode([installed.binPath, ...argv, ...format], {
        cwd: root, timeoutMs: 120_000, ...(stdin === undefined ? {} : { stdin }), ...(env === undefined ? {} : { env }),
      });
      assert.ok(expect.includes(result.exitCode), describeFailure(`akrs ${argv.join(' ')} exit ${result.exitCode}`, result));
      if (argv.includes('--jsonl') || argv.includes('--prompt')) return { ...result, packet: null };
      assert.equal(result.stderr, '', `akrs ${argv.join(' ')}: JSON mode keeps stderr empty`);
      const packet = JSON.parse(result.stdout);
      assertActionable(packet, `akrs ${argv.join(' ')}`);
      return { ...result, packet };
    },
    // A call an agent makes: counted, and never carrying bookkeeping.
    async agent(argv, options) {
      for (const argument of argv) {
        assert.ok(!BOOKKEEPING.includes(argument), `an agent never types ${argument}`);
        assert.ok(!String(argument).includes('sha256:'), 'an agent never types a hash or snapshot');
      }
      agentCalls.push(argv);
      return project.run(argv, options);
    },
    // The snapshot a guarded Leader mutation expects: read from the command's own dry run.
    async snapshotFor(argv) {
      const dry = await project.run([...argv, '--dry-run']);
      assert.ok(['ok', 'noop', 'warning'].includes(dry.packet.status), JSON.stringify(dry.packet.findings));
      return dry.packet.snapshot.before;
    },
    // A guarded Leader mutation: dry run for the snapshot, then the real call.
    async guarded(argv, { expect = [0] } = {}) {
      const snapshot = await project.snapshotFor(argv);
      return project.run([...argv, '--if-snapshot', snapshot], { expect });
    },
    async draft(name, document) {
      await project.write(`akrs/drafts/${name}.json`, `${JSON.stringify(document, null, 2)}\n`);
      return `akrs/drafts/${name}.json`;
    },
    async setExecutors() {
      for (const executor of EXECUTORS) {
        const done = await project.run(['executor', 'set', executor.id, '--role', executor.role, '--class', executor.class, '--label', executor.id, '--answer', executor.class]);
        assert.equal(done.packet.status, 'ok', JSON.stringify(done.packet.findings));
      }
    },
    // The stored form of a canonical JSON artifact without its CLI-owned meta: the Leader's update form.
    async stored(path) {
      const { meta: _meta, ...rest } = await project.readJson(path);
      return rest;
    },
  };
  return project;
}
