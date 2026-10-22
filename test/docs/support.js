// P2-W10 shared helpers of the documentation tests: which Markdown files are the user-facing documentation, and a code-span
// extractor. Historical material (docs/research, docs/validation, CHANGELOG) is deliberately not part of the set: it may name
// deleted commands and forms as history.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = fileURLToPath(new URL('../../', import.meta.url));

export const ROOT_DOCS = Object.freeze(['README.md', 'GETTING_STARTED.md', 'ROADMAP.md', 'VERSIONING.md']);

async function markdownIn(directory) {
  const found = [];
  for (const entry of await readdir(join(REPOSITORY, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await markdownIn(path));
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found.sort();
}

// Repository-relative paths (forward slashes) of every user-facing Markdown document.
export async function documentationFiles() {
  return [
    ...ROOT_DOCS,
    ...await markdownIn('docs/framework'),
    ...await markdownIn('docs/guides'),
    'examples/minimal/README.md',
  ];
}

export const skillFiles = async () => (await markdownIn('docs/framework/skills')).filter((path) => !path.endsWith('/README.md'));

export const readRepositoryFile = (path) => readFile(join(REPOSITORY, path), 'utf8');

// The code of a Markdown text: [{ line, text }] (1-based line numbers). Every backtick-delimited span counts (a span a fenced block
// leaves open at the end of a line counts too). Inside a fenced block, a line that is itself a shell command (it starts with `akrs `,
// `npx ` or `$ `) counts whole; the prose and the sample file contents of a fenced block do not.
export function codeFragments(markdown) {
  const out = [];
  let fence = null;
  markdown.replace(/\r\n/g, '\n').split('\n').forEach((line, index) => {
    const marker = /^\s*(`{3,}|~{3,})(\S*)/.exec(line);
    if (marker !== null) {
      if (fence === null) fence = { char: marker[1][0], lang: marker[2] };
      else if (marker[1][0] === fence.char) fence = null;
      return;
    }
    if (fence !== null && !['markdown', 'md', 'json'].includes(fence.lang) && /^\s*(\$ |akrs |npx )/u.test(line) && !line.includes('`')) {
      out.push({ line: index + 1, text: line.replace(/^\s*\$ /u, '').trim() });
      return;
    }
    line.split('`').forEach((piece, position) => {
      if (position % 2 === 1 && piece !== '') out.push({ line: index + 1, text: piece });
    });
  });
  return out;
}
