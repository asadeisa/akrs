// Skill discovery and the thin pointer file (F20). The canonical body of a skill is never copied: a pointer holds the skill's name and
// description (read from the body's frontmatter) and one managed block that says to read and execute the body.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { applyManagedBlock } from '../store/managed-block.js';
import { MANAGED_BLOCKS, SKILL_LIMITS } from './policy.js';

const NAME_PATTERN = new RegExp(SKILL_LIMITS.name_pattern);
const PACKAGED_DIRECTORY = 'docs/framework/skills';
// `init` installs docs/framework under docs/akrs/framework
const INSTALLED_DIRECTORY = 'docs/akrs/framework/skills';

function scalar(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

// { name, description } of a body's or pointer's frontmatter, or null when the frontmatter is absent, unclosed or incomplete.
export function parseSkillFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.replace(/^﻿/, ''));
  if (match === null) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^(name|description):(.*)$/.exec(line);
    if (field !== null) fields[field[1]] = scalar(field[2]);
  }
  return typeof fields.name === 'string' && fields.name !== '' && typeof fields.description === 'string' && fields.description !== ''
    ? { name: fields.name, description: fields.description }
    : null;
}

export function pointerContent(bodyPath) {
  return `Read and execute \`${bodyPath}\`. It is the single owner of this procedure; do not restate it here.\n`;
}

export function skillFrontmatter({ name, description }) {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
}

// Brings the name and description lines of an existing pointer's frontmatter in line with the canonical body, leaving every other line and
// everything outside the frontmatter alone; adds the frontmatter when the file has none. Returns the same text when nothing differs.
export function fixSkillFrontmatter(text, { name, description }) {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const body = text.slice(bom.length);
  const match = /^---(\r?\n)([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(body);
  if (match === null) return `${bom}${skillFrontmatter({ name, description })}${body}`;
  const newline = match[1];
  const wanted = { name: `name: ${name}`, description: `description: ${JSON.stringify(description)}` };
  const values = { name, description };
  const lines = match[2].split(/\r?\n/);
  const seen = new Set();
  const fixed = lines.map((line) => {
    const field = /^(name|description):(.*)$/.exec(line);
    if (field === null) return line;
    seen.add(field[1]);
    return scalar(field[2]) === values[field[1]] ? line : wanted[field[1]];
  });
  for (const key of ['name', 'description']) if (!seen.has(key)) fixed.push(wanted[key]);
  const replacement = `---${newline}${fixed.join(newline)}${newline}---`;
  return replacement === match[0] ? text : `${bom}${replacement}${body.slice(match[0].length)}`;
}

export function renderSkillFile({ name, description, bodyPath }) {
  const block = MANAGED_BLOCKS.skill_pointer;
  return applyManagedBlock(skillFrontmatter({ name, description }), { id: block.id, style: block.style, content: pointerContent(bodyPath) }).text;
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

// -> { source: 'project' | 'packaged' | 'none', skills: [{ name, description, bodyPath }], skipped: [{ file, reason }] }
export async function discoverSkills({ repositoryRoot, workflowRelative, sourceRoot }) {
  const projectRelative = workflowRelative === '' ? 'skills' : `${workflowRelative}/skills`;
  const projectDirectory = join(repositoryRoot, ...projectRelative.split('/'));
  const packagedDirectory = join(sourceRoot, ...PACKAGED_DIRECTORY.split('/'));
  let source = 'none';
  let directory = null;
  let shown = null;
  let body = null;
  if (await isDirectory(projectDirectory)) {
    [source, directory, shown, body] = ['project', projectDirectory, projectRelative, projectRelative];
  } else if (await isDirectory(packagedDirectory)) {
    [source, directory, shown, body] = ['packaged', packagedDirectory, PACKAGED_DIRECTORY, INSTALLED_DIRECTORY];
  }
  if (directory === null) return { source, skills: [], skipped: [] };

  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
    .map((entry) => entry.name)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const skills = [];
  const skipped = [];
  for (const file of names) {
    const frontmatter = parseSkillFrontmatter(await readFile(join(directory, file), 'utf8'));
    const skip = (reason) => skipped.push({ file: `${shown}/${file}`, reason });
    if (frontmatter === null) skip('no_frontmatter');
    else if (!NAME_PATTERN.test(frontmatter.name)) skip('invalid_name');
    else if (`${frontmatter.name}.md` !== file) skip('name_mismatch');
    else {
      skills.push({ name: frontmatter.name, description: frontmatter.description.slice(0, SKILL_LIMITS.description_max), bodyPath: `${body}/${file}` });
    }
  }
  return { source, skills, skipped };
}
