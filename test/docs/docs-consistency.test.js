// P2-W10: the documentation teaches only what the shipped manifest ships. Every `akrs <command> [flags]` example in the user-facing
// docs is checked against the command manifest; deleted commands and forms are absent; the skill bodies are plain, vendor-neutral and
// one owner per procedure.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { parseSkillFrontmatter } from '../../lib/agents/skills.js';
import { SKILL_LIMITS } from '../../lib/agents/policy.js';
import { codeFragments, documentationFiles, readRepositoryFile, skillFiles } from './support.js';

const COMMANDS = commandManifest.commands;

// the longest manifest command whose tokens prefix `argv`, or null
function selectCommand(argv) {
  return COMMANDS
    .filter(({ tokens }) => tokens.every((token, index) => argv[index] === token))
    .sort((left, right) => right.tokens.length - left.tokens.length)[0] ?? null;
}

const clean = (token) => token.replace(/^[[(]+/u, '').replace(/[\])},.;:…]+$/u, '');

// every `akrs ...` / `akrs-framework ...` example of a code fragment: { argv }
function examplesOf(text) {
  const out = [];
  for (const match of text.matchAll(/(?:^|[\s("'`])(?:akrs|akrs-framework)\s+([^|;&\n]*)/gu)) {
    const rest = match[1].split(/\s#\s|\s←\s|\s—\s/u)[0];
    const argv = rest.split(/\s+/u).map(clean).filter((token) => token !== '' && token !== '|');
    if (argv.length > 0) out.push(argv);
  }
  return out;
}

test('every akrs command example in the documentation is a manifest command with manifest flags', async () => {
  const problems = [];
  let checked = 0;
  for (const file of await documentationFiles()) {
    for (const { line, text } of codeFragments(await readRepositoryFile(file))) {
      for (const argv of examplesOf(text)) {
        if (argv[0].startsWith('<') || argv[0].startsWith('…') || argv[0].startsWith('.')) continue;
        const command = selectCommand(argv);
        if (command === null) {
          problems.push(`${file}:${line} unknown command: akrs ${argv.join(' ')}`);
          continue;
        }
        checked += 1;
        const known = new Set([...command.flags.map(({ name }) => name), '--help']);
        for (const token of argv.slice(command.tokens.length)) {
          if (!token.startsWith('--')) continue;
          const name = token.split('=')[0];
          if (!known.has(name)) problems.push(`${file}:${line} \`akrs ${command.tokens.join(' ')}\` has no flag ${name}`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(checked > 80, `the docs carry command examples (found ${checked})`);
});

// v1 commands, flags and forms that no user-facing document may teach any more (history lives in docs/research and the CHANGELOG)
const DELETED = [
  [/validate --fix/u, 'validate --fix'],
  [/validate --clean/u, 'validate --clean'],
  [/validate:(fix|clean)/u, 'validate:fix / validate:clean scripts'],
  [/npm run validate/u, 'npm run validate'],
  [/\bLOG(-<?NNN>?)?\.md\b/u, 'LOG.md ledger'],
  [/BLOCKED\.md/u, 'BLOCKED.md flag file'],
  [/akrs\/verify\//u, 'akrs/verify/ handoff files'],
  [/-handoff\.md/u, '<plan>-handoff.md'],
  [/request-scope/u, 'road request-scope'],
  [/memory\/tester/u, 'tester memory folder'],
  [/DONE \+ superseded/u, 'DONE + superseded status'],
  [/Expected files/iu, 'Expected files'],
  [/AskUserQuestion/u, 'a vendor tool ID'],
  [/road compile/u, 'road compile'],
];

test('no user-facing document teaches a deleted command, flag or v1 form', async () => {
  const problems = [];
  for (const file of await documentationFiles()) {
    const lines = (await readRepositoryFile(file)).split(/\r?\n/u);
    lines.forEach((text, index) => {
      for (const [pattern, name] of DELETED) if (pattern.test(text)) problems.push(`${file}:${index + 1} mentions ${name}`);
    });
  }
  assert.deepEqual(problems, []);
});

const VENDOR_TOOL_IDS = /\b(AskUserQuestion|TodoWrite|WebFetch|WebSearch|NotebookEdit|mcp__[a-z0-9_]+|browser_(navigate|click|snapshot|type)|Playwright|Puppeteer|Selenium)\b/u;

test('skill bodies are valid, vendor-neutral and registered in the skills README exactly once', async () => {
  const files = await skillFiles();
  assert.deepEqual(files.map((file) => file.split('/').at(-1)), [
    'akrs-classify-executors.md', 'akrs-close-out.md', 'akrs-live-verify.md', 'akrs-road-author.md', 'akrs-scope-request.md', 'akrs-work-loop.md',
  ]);
  const readme = await readRepositoryFile('docs/framework/skills/README.md');
  const descriptions = new Set();
  for (const file of files) {
    const text = await readRepositoryFile(file);
    const name = file.split('/').at(-1).replace(/\.md$/u, '');
    const front = parseSkillFrontmatter(text);
    assert.notEqual(front, null, `${name}: frontmatter`);
    assert.equal(front.name, name, `${name}: the frontmatter name is the file name`);
    assert.match(front.name, new RegExp(SKILL_LIMITS.name_pattern), name);
    assert.ok(front.description.length <= SKILL_LIMITS.description_max, `${name}: description length`);
    assert.equal(descriptions.has(front.description), false, `${name}: description is unique`);
    descriptions.add(front.description);
    const frontKeys = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)[1].split(/\r?\n/u).map((line) => line.split(':')[0]);
    assert.deepEqual(frontKeys, ['name', 'description'], `${name}: frontmatter has only name and description`);
    assert.equal(VENDOR_TOOL_IDS.test(text), false, `${name}: no vendor tool ID (${VENDOR_TOOL_IDS.exec(text)?.[0]})`);
    assert.equal(readme.split(`[\`${name}.md\`](${name}.md)`).length - 1, 1, `${name}: listed once in skills/README.md`);
    assert.match(text, /single owner/u, `${name}: names itself the single owner of its procedure`);
  }
});

test('every skill the documentation names exists, and no skill restates another skill’s numbered procedure', async () => {
  const skills = new Set((await skillFiles()).map((file) => file.split('/').at(-1).replace(/\.md$/u, '')));
  const problems = [];
  for (const file of await documentationFiles()) {
    for (const match of (await readRepositoryFile(file)).matchAll(/\bakrs-[a-z]+(?:-[a-z]+)*\b/gu)) {
      const name = match[0];
      if (['akrs-framework', 'akrs-guard', 'akrs-system-graph'].includes(name) || skills.has(name)) continue;
      problems.push(`${file} names the unknown skill ${name}`);
    }
  }
  assert.deepEqual([...new Set(problems)], []);
  // one owner per procedure: the finish command line appears in exactly the owning skills, never in a spec
  const owners = [];
  for (const file of await documentationFiles()) {
    if ((await readRepositoryFile(file)).includes('--result "<what is ready>"')) owners.push(file);
  }
  const allowed = new Set([
    'docs/framework/skills/akrs-close-out.md', 'docs/framework/skills/akrs-work-loop.md', 'GETTING_STARTED.md',
  ]);
  assert.deepEqual(owners.filter((file) => !allowed.has(file)), [], 'the specs point to the skill, they do not restate the finish call');
});

test('the manifest help names every flag the skills teach for the intent commands', () => {
  const flagsOf = (id) => new Set(COMMANDS.find((command) => command.id === id).flags.map(({ name }) => name));
  for (const flag of ['--result', '--reach', '--expect', '--handoff', '--deviations', '--pre-existing']) assert.ok(flagsOf('done').has(flag), `done ${flag}`);
  for (const flag of ['--verdict', '--because', '--input']) assert.ok(flagsOf('test-result').has(flag), `test result ${flag}`);
  for (const flag of ['--role', '--class', '--label', '--answer', '--override', '--clear-override']) assert.ok(flagsOf('executor-set').has(flag), `executor set ${flag}`);
  for (const flag of ['--class', '--to-draft']) assert.ok(flagsOf('template').has(flag), `template ${flag}`);
  for (const flag of ['--patch', '--reason', '--if-snapshot', '--dry-run', '--input']) assert.ok(flagsOf('road-update').has(flag), `road update ${flag}`);
});

test('every complete JSON record shown in the documentation validates against its closed schema', async () => {
  const { SCHEMA_REGISTRY, validateArtifact } = await import('../../lib/schemas/index.js');
  const problems = [];
  let checked = 0;
  for (const file of await documentationFiles()) {
    for (const match of (await readRepositoryFile(file)).matchAll(/```json\r?\n([\s\S]*?)```/gu)) {
      let value;
      try {
        value = JSON.parse(match[1]);
      } catch {
        continue; // a fragment (for example a list of reads), not a whole record
      }
      if (value === null || typeof value !== 'object' || !Object.hasOwn(SCHEMA_REGISTRY, value.schema)) continue;
      const { forms } = SCHEMA_REGISTRY[value.schema];
      const result = validateArtifact(value.schema, value, { form: forms.includes('input') ? 'input' : forms[0] });
      checked += 1;
      if (!result.ok) problems.push(`${file}: ${value.schema}: ${JSON.stringify(result.issues)}`);
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(checked >= 1, 'the docs show at least one complete record');
});
