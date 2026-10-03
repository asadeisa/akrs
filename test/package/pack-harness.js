import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPathWithin } from '../helpers/paths.js';
import { runProcess } from '../helpers/process.js';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PACKAGE_NAME = 'akrs-framework';
export const SANDBOX_PREFIX = 'akrs-pack-';
const NPM_TIMEOUT_MS = 180_000;
export const POSTINSTALL_ENVIRONMENT = Object.freeze({
  AKRS_SKIP_POSTINSTALL: '',
  npm_config_ignore_scripts: 'false',
  npm_config_global: 'false',
  npm_command: '',
});

// Locate npm without a shell: argv arrays only, never the .cmd/.ps1 shims.
export function locateNpmCli() {
  const candidates = [];
  const execPath = process.env.npm_execpath;
  if (execPath && /^npm-cli\.[cm]?js$/.test(basename(execPath))) candidates.push(execPath);
  const nodeDir = dirname(process.execPath);
  candidates.push(
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  );
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`cannot locate npm-cli.js; tried:\n${candidates.join('\n')}\n`
      + 'run the tests through "npm test" or install npm next to the running node');
  }
  return resolve(found);
}

export function runNpm(args, options = {}) {
  return runProcess(process.execPath, [locateNpmCli(), ...args], {
    timeoutMs: NPM_TIMEOUT_MS,
    ...options,
    env: {
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
      ...options.env,
    },
  });
}

export function describeFailure(label, result) {
  return `${label} failed (exit ${result.exitCode}, signal ${result.signal}, `
    + `timedOut ${result.timedOut})\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
}

export function parseNpmJson(label, result) {
  if (result.exitCode !== 0) throw new Error(describeFailure(label, result));
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} printed non-JSON stdout: ${error.message}\n${result.stdout}`);
  }
}

export async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

// Read-only git must never take .git/index.lock: a timed-out child killed mid-refresh would leave
// a stale lock behind on Windows and block the developer's next commit.
const READ_ONLY_GIT = Object.freeze({ cwd: repositoryRoot, env: { GIT_OPTIONAL_LOCKS: '0' }, timeoutMs: 60_000 });

// Returns null when the repository is not a git work tree (for example a source archive).
export async function gitStatus() {
  const inside = await runProcess('git', ['rev-parse', '--is-inside-work-tree'], READ_ONLY_GIT)
    .catch(() => null);
  if (!inside || inside.exitCode !== 0) return null;
  const status = await runProcess('git', ['status', '--short', '--untracked-files=all'], READ_ONLY_GIT);
  if (status.exitCode !== 0) throw new Error(describeFailure('git status', status));
  return status.stdout;
}

export async function repositoryTarballs() {
  const entries = await readdir(repositoryRoot);
  return entries.filter((entry) => entry.endsWith('.tgz')).sort();
}

function isWithin(root, candidate) {
  const prefix = root.endsWith('\\') || root.endsWith('/') ? root : `${root}${root.includes('\\') ? '\\' : '/'}`;
  return candidate === root || candidate.startsWith(prefix);
}

// One dedicated directory under the OS temp root; every generated path is verified to stay inside
// it and cleanup removes only that exact verified directory.
export async function createPackSandbox(testContext) {
  const temporaryRoot = resolve(tmpdir());
  const root = await mkdtemp(join(temporaryRoot, SANDBOX_PREFIX));
  assertPathWithin(temporaryRoot, root);
  const sandbox = {
    root,
    tarballDirectory: join(root, 'tarball'),
    projectDirectory: join(root, 'project'),
    cacheDirectory: join(root, 'npm-cache'),
    paths: new Set([root]),
    removed: false,
    inside(candidate) {
      const resolved = assertPathWithin(root, candidate);
      sandbox.paths.add(resolved);
      return resolved;
    },
    assertAllInside() {
      for (const generated of sandbox.paths) {
        assertPathWithin(root, generated);
        if (!isWithin(root, generated)) throw new Error(`generated path escaped the temp root: ${generated}`);
      }
    },
    async cleanup() {
      if (sandbox.removed) return;
      assertPathWithin(temporaryRoot, root);
      if (!basename(root).startsWith(SANDBOX_PREFIX) || dirname(root) !== temporaryRoot) {
        throw new Error(`refusing to remove unexpected path: ${root}`);
      }
      const info = await lstat(root).catch(() => null);
      if (info && (info.isSymbolicLink() || !info.isDirectory())) {
        throw new Error(`refusing to remove non-directory sandbox: ${root}`);
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      sandbox.removed = true;
    },
  };
  if (testContext?.after) testContext.after(() => sandbox.cleanup());
  await mkdir(sandbox.inside(sandbox.tarballDirectory));
  await mkdir(sandbox.inside(sandbox.projectDirectory));
  await mkdir(sandbox.inside(sandbox.cacheDirectory));
  return sandbox;
}

export async function packTarball(sandbox) {
  const result = await runNpm(
    ['pack', '--pack-destination', sandbox.tarballDirectory, '--json'],
    { cwd: repositoryRoot, env: { npm_config_cache: sandbox.cacheDirectory } },
  );
  const [entry] = parseNpmJson('npm pack', result);
  const tarballPath = sandbox.inside(join(sandbox.tarballDirectory, entry.filename));
  const info = await stat(tarballPath);
  if (!info.isFile()) throw new Error(`tarball is not a file: ${tarballPath}`);
  const generated = (await readdir(sandbox.tarballDirectory)).sort();
  if (generated.length !== 1 || generated[0] !== entry.filename) {
    throw new Error(`unexpected files in tarball directory: ${generated.join(', ')}`);
  }
  return {
    path: tarballPath,
    filename: entry.filename,
    sha256: await sha256File(tarballPath),
    files: entry.files.map(({ path }) => path),
    version: entry.version,
  };
}

// Installs into a second child temp project; lifecycle scripts (postinstall) run as for a user.
export async function installTarball(sandbox, tarball) {
  await writeFile(
    sandbox.inside(join(sandbox.projectDirectory, 'package.json')),
    `${JSON.stringify({ name: 'akrs-pack-smoke-project', version: '0.0.0', private: true }, null, 2)}\n`,
  );
  const result = await runNpm(
    ['install', tarball.path, '--no-package-lock'],
    {
      cwd: sandbox.projectDirectory,
      env: {
        npm_config_cache: sandbox.cacheDirectory,
        // A developer or CI environment must not silently skip the postinstall under test.
        ...POSTINSTALL_ENVIRONMENT,
      },
    },
  );
  const packageRoot = sandbox.inside(
    join(sandbox.projectDirectory, 'node_modules', PACKAGE_NAME),
  );
  return {
    install: result,
    packageRoot,
    binPath: join(packageRoot, 'bin', 'akrs.js'),
    exampleRoot: join(packageRoot, 'examples', 'minimal'),
  };
}
