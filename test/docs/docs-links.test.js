// P2-W10: every relative link in the user-facing documentation resolves in the repository, and the files `akrs init` copies into a
// project (GETTING_STARTED.md and docs/framework) resolve in that copied layout too — the real command is run, not a model of it.
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { runCli } from '../helpers/process.js';
import { REPOSITORY, documentationFiles, readRepositoryFile } from './support.js';

const exists = (path) => access(path).then(() => true, () => false);

// [{ line, target }] of the relative links of a Markdown text (absolute URLs, mailto and pure anchors are not relative)
function relativeLinks(markdown) {
  const out = [];
  let fence = false;
  markdown.split(/\r?\n/u).forEach((line, index) => {
    if (/^\s*(```|~~~)/u.test(line)) fence = !fence;
    if (fence) return;
    for (const match of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)) {
      const target = match[1];
      if (/^([a-z][a-z0-9+.-]*:|#)/iu.test(target)) continue;
      out.push({ line: index + 1, target: decodeURI(target.split('#')[0]) });
    }
  });
  return out.filter(({ target }) => target !== '');
}

test('every relative link of a user-facing document resolves in the repository', async () => {
  const problems = [];
  let checked = 0;
  for (const file of await documentationFiles()) {
    for (const { line, target } of relativeLinks(await readRepositoryFile(file))) {
      checked += 1;
      if (!await exists(resolve(REPOSITORY, dirname(file), target))) problems.push(`${file}:${line} -> ${target}`);
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(checked > 20, `the docs carry links (found ${checked})`);
});

test('the framework docs link only inside the framework folder, and GETTING_STARTED links only by absolute URL', async () => {
  const problems = [];
  for (const file of await documentationFiles()) {
    const links = relativeLinks(await readRepositoryFile(file));
    if (file.startsWith('docs/framework/')) {
      for (const { line, target } of links) {
        const inside = relative(join(REPOSITORY, 'docs/framework'), resolve(REPOSITORY, dirname(file), target));
        if (inside.startsWith('..')) problems.push(`${file}:${line} -> ${target} leaves docs/framework`);
      }
    }
    if (file === 'GETTING_STARTED.md') for (const { line, target } of links) problems.push(`${file}:${line} -> ${target} is relative`);
  }
  assert.deepEqual(problems, []);
});

async function markdownTree(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...await markdownTree(path));
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found;
}

test('after akrs init, every relative link of the copied GETTING_STARTED.md and framework docs resolves in the project', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'akrs-docs-links-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const result = await runCli(['init', '--json'], { cwd: project });
  assert.equal(result.exitCode, 0, result.stderr);
  const copied = await markdownTree(join(project, 'docs', 'akrs'));
  assert.ok(copied.some((path) => path.endsWith('GETTING_STARTED.md')));
  assert.ok(copied.some((path) => path.endsWith('akrs-work-loop.md')), 'the skills are copied');
  const problems = [];
  for (const file of copied) {
    for (const { line, target } of relativeLinks(await readFile(file, 'utf8'))) {
      if (!await exists(resolve(dirname(file), target))) problems.push(`${relative(project, file)}:${line} -> ${target}`);
    }
  }
  assert.deepEqual(problems, []);
});
