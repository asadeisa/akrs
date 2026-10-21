// Skill discovery and the thin pointer file: names and descriptions come from the canonical bodies, nothing of the procedure is copied.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SOURCE_ROOT } from '../../lib/core/index.js';
import { discoverSkills, parseSkillFrontmatter, renderSkillFile } from '../../lib/agents/skills.js';
import { SKILL_LIMITS } from '../../lib/agents/policy.js';
import { SKILL_TEMPLATES, makeWorld, writeTree } from './support.js';

test('frontmatter: name and description, bare, double quoted (JSON escapes) and single quoted values', () => {
  assert.deepEqual(parseSkillFrontmatter('---\nname: a-b\ndescription: Run the thing: now.\n---\nbody\n'), { name: 'a-b', description: 'Run the thing: now.' });
  assert.deepEqual(parseSkillFrontmatter('---\r\nname: "a-b"\r\ndescription: "say \\"hi\\""\r\n---\r\n'), { name: 'a-b', description: 'say "hi"' });
  assert.deepEqual(parseSkillFrontmatter("---\nname: 'a'\ndescription: 'it''s'\n---\n"), { name: 'a', description: "it's" });
  assert.equal(parseSkillFrontmatter('no frontmatter\n'), null);
  assert.equal(parseSkillFrontmatter('---\nname: a\n---\n'), null);
  assert.equal(parseSkillFrontmatter('---\nname: a\ndescription: x\n'), null);
});

test('the pointer file has only name and description in the frontmatter and one managed block that points at the body', () => {
  const text = renderSkillFile({ name: 'akrs-close-out', description: 'Do "it": now.', bodyPath: 'akrs/skills/akrs-close-out.md' });
  assert.match(text, /^---\nname: akrs-close-out\ndescription: "Do \\"it\\": now\."\n---\n\n<!-- akrs:begin skill-pointer sha256=[0-9a-f]{64} -->\n/);
  assert.match(text, /Read and execute `akrs\/skills\/akrs-close-out\.md`/);
  assert.match(text, /\n<!-- akrs:end skill-pointer -->\n$/);
  assert.deepEqual(parseSkillFrontmatter(text), { name: 'akrs-close-out', description: 'Do "it": now.' });
  assert.equal(text.includes('Steps.'), false);
});

test('without a project skills folder the packaged templates are used (README excluded) and the pointer names the installed doctrine copy', async (t) => {
  const world = await makeWorld(t);
  const found = await discoverSkills({ repositoryRoot: world.repo.root, workflowRelative: 'akrs', sourceRoot: world.sourceRoot });
  assert.equal(found.source, 'packaged');
  assert.deepEqual(found.skills.map(({ name, bodyPath }) => [name, bodyPath]), [
    ['akrs-close-out', 'docs/akrs/framework/skills/akrs-close-out.md'],
    ['akrs-live-verify', 'docs/akrs/framework/skills/akrs-live-verify.md'],
  ]);
  assert.deepEqual(found.skipped, []);
});

test('a project skills folder (<workflow>/skills) wins and the pointer names that body', async (t) => {
  const world = await makeWorld(t, {
    repoFiles: { 'akrs/skills/local-skill.md': '---\nname: local-skill\ndescription: Local procedure.\n---\nbody\n', 'akrs/skills/notes.txt': 'ignored' },
  });
  const found = await discoverSkills({ repositoryRoot: world.repo.root, workflowRelative: 'akrs', sourceRoot: world.sourceRoot });
  assert.equal(found.source, 'project');
  assert.deepEqual(found.skills.map(({ name, bodyPath }) => [name, bodyPath]), [['local-skill', 'akrs/skills/local-skill.md']]);
});

test('an invalid name, a missing frontmatter and a long description are handled and reported, never guessed', async (t) => {
  const long = 'x'.repeat(2000);
  const world = await makeWorld(t, {
    repoFiles: {
      'akrs/skills/Bad_Name.md': '---\nname: Bad_Name\ndescription: x\n---\n',
      'akrs/skills/plain.md': '# no frontmatter\n',
      'akrs/skills/wrong.md': '---\nname: other\ndescription: x\n---\n',
      'akrs/skills/long.md': `---\nname: long\ndescription: ${long}\n---\n`,
    },
  });
  const found = await discoverSkills({ repositoryRoot: world.repo.root, workflowRelative: 'akrs', sourceRoot: world.sourceRoot });
  assert.deepEqual(found.skills.map(({ name }) => name), ['long']);
  assert.equal(found.skills[0].description.length, SKILL_LIMITS.description_max);
  assert.deepEqual(found.skipped, [
    { file: 'akrs/skills/Bad_Name.md', reason: 'invalid_name' },
    { file: 'akrs/skills/plain.md', reason: 'no_frontmatter' },
    { file: 'akrs/skills/wrong.md', reason: 'name_mismatch' },
  ]);
});

test('the packaged skills of this repository are valid pointers: name equals file name, pattern and length limits hold', async () => {
  const found = await discoverSkills({ repositoryRoot: DEFAULT_SOURCE_ROOT, workflowRelative: 'no-such-workflow', sourceRoot: DEFAULT_SOURCE_ROOT });
  assert.equal(found.source, 'packaged');
  assert.deepEqual(found.skipped, []);
  const files = (await readdir(join(DEFAULT_SOURCE_ROOT, 'docs', 'framework', 'skills'))).filter((name) => name !== 'README.md');
  assert.deepEqual(found.skills.map(({ name }) => `${name}.md`).sort(), files.sort());
  for (const skill of found.skills) {
    assert.match(skill.name, new RegExp(SKILL_LIMITS.name_pattern));
    assert.ok(skill.description.length > 0 && skill.description.length <= SKILL_LIMITS.description_max);
    const body = await readFile(join(DEFAULT_SOURCE_ROOT, 'docs', 'framework', 'skills', `${skill.name}.md`), 'utf8');
    assert.equal(body.startsWith('---\n'), true);
  }
});

test('an extra templates fixture is read the same way (sanity of the shared fixture)', async (t) => {
  const world = await makeWorld(t, { skillFiles: { ...SKILL_TEMPLATES } });
  await writeTree(world.pkg.root, { 'docs/framework/skills/zzz.md': '---\nname: zzz\ndescription: last\n---\n' });
  const found = await discoverSkills({ repositoryRoot: world.repo.root, workflowRelative: 'akrs', sourceRoot: world.sourceRoot });
  assert.deepEqual(found.skills.map(({ name }) => name), ['akrs-close-out', 'akrs-live-verify', 'zzz']);
});
