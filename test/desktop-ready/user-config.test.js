// P2-W17 / F21: the user-config root, the registry schema and its frozen decisions. The resolver is pure: the environment, the platform
// and the home directory are inputs, so these tests never read the real profile.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CliUsageError } from '../../lib/core/errors.js';
import {
  CONFIG_HOME_ENV, CONFIG_SOURCES, MAX_PROJECTS, PROJECTS_FINDING_CODES, PROJECT_KEYS, PROJECT_REASONS, PROJECT_STATES, REGISTRY_FILE, REGISTRY_KEYS,
  REGISTRY_SCHEMA, USER_CONFIG_POLICY, WORKFLOW_MARKERS,
} from '../../lib/userconfig/policy.js';
import { resolveConfigRoot } from '../../lib/userconfig/root.js';
import { isNormalizedRoot, renderRegistry, validateRegistry } from '../../lib/userconfig/registry.js';
import { PROCESS_CONFIG_HOME } from './support.js';

test('F21 freezes the file, the schema, the closed keys and the vocabularies', () => {
  assert.equal(CONFIG_HOME_ENV, 'AKRS_CONFIG_HOME');
  assert.equal(REGISTRY_FILE, 'projects.json');
  assert.equal(REGISTRY_SCHEMA, 'akrs.projects/v1');
  assert.deepEqual([...REGISTRY_KEYS], ['schema', 'projects']);
  assert.deepEqual([...PROJECT_KEYS], ['root', 'workflow', 'name', 'added_at']);
  assert.deepEqual([...CONFIG_SOURCES], ['AKRS_CONFIG_HOME', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'home']);
  assert.deepEqual([...PROJECT_REASONS], ['missing', 'not_a_directory', 'not_akrs', 'registry_full', 'registry_invalid', 'unsafe']);
  assert.deepEqual([...PROJECT_STATES], ['missing', 'not_a_directory', 'not_akrs', 'ok', 'unreadable']);
  assert.deepEqual([...WORKFLOW_MARKERS], ['executors.json', 'plans', 'roads', 'state.json', 'tasks', 'verifications']);
  assert.deepEqual({ ...PROJECTS_FINDING_CODES }, { rejected: 'AKRS-C022', unreadable: 'AKRS-C023' });
  assert.equal(MAX_PROJECTS, 500);
});

test('F21 documents the root rules, the own lock, the temp-file rename writes and the path validation, deep-frozen', () => {
  assert.equal(Object.isFrozen(USER_CONFIG_POLICY), true);
  for (const key of ['root', 'injection', 'registry', 'lock', 'writes', 'validation', 'remove', 'projects_read', 'scope', 'snapshot']) {
    assert.equal(typeof USER_CONFIG_POLICY[key], 'string', key);
    assert.ok(USER_CONFIG_POLICY[key].length > 40, key);
  }
  assert.match(USER_CONFIG_POLICY.root, /AKRS_CONFIG_HOME/);
  assert.match(USER_CONFIG_POLICY.root, /LOCALAPPDATA/);
  assert.match(USER_CONFIG_POLICY.root, /XDG_CONFIG_HOME/);
  assert.match(USER_CONFIG_POLICY.lock, /own lock|its own lock/);
  assert.match(USER_CONFIG_POLICY.writes, /rename/);
});

test('AKRS_CONFIG_HOME names the root directly and wins over every platform default', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const absolute = platform === 'win32' ? 'D:\\cfg\\akrs-home' : '/tmp/cfg/akrs-home';
    const found = resolveConfigRoot({ env: { AKRS_CONFIG_HOME: absolute, LOCALAPPDATA: 'C:\\L', XDG_CONFIG_HOME: '/x' }, platform, homedir: '/h' });
    assert.equal(found.source, 'AKRS_CONFIG_HOME');
    assert.equal(found.root, absolute);
    assert.equal(found.display, absolute.replaceAll('\\', '/'));
  }
});

test('Windows uses %LOCALAPPDATA%\\akrs, falling back to <home>\\AppData\\Local\\akrs', () => {
  const direct = resolveConfigRoot({ env: { LOCALAPPDATA: 'C:\\Users\\sam\\AppData\\Local' }, platform: 'win32', homedir: 'C:\\Users\\sam' });
  assert.deepEqual([direct.source, direct.root, direct.display], ['LOCALAPPDATA', 'C:\\Users\\sam\\AppData\\Local\\akrs', 'C:/Users/sam/AppData/Local/akrs']);
  for (const env of [{}, { LOCALAPPDATA: '' }, { LOCALAPPDATA: 'relative\\dir' }]) {
    const fallback = resolveConfigRoot({ env, platform: 'win32', homedir: 'C:\\Users\\sam' });
    assert.deepEqual([fallback.source, fallback.display], ['home', 'C:/Users/sam/AppData/Local/akrs']);
  }
});

test('Linux and macOS use $XDG_CONFIG_HOME/akrs when absolute, else ~/.config/akrs', () => {
  for (const platform of ['linux', 'darwin']) {
    const xdg = resolveConfigRoot({ env: { XDG_CONFIG_HOME: '/srv/cfg' }, platform, homedir: '/home/sam' });
    assert.deepEqual([xdg.source, xdg.root], ['XDG_CONFIG_HOME', '/srv/cfg/akrs']);
    for (const env of [{}, { XDG_CONFIG_HOME: '' }, { XDG_CONFIG_HOME: 'relative/cfg' }]) {
      const fallback = resolveConfigRoot({ env, platform, homedir: '/home/sam' });
      assert.deepEqual([fallback.source, fallback.root], ['home', '/home/sam/.config/akrs']);
    }
  }
});

test('a relative or NUL-carrying AKRS_CONFIG_HOME is a usage error, never guessed', () => {
  for (const bad of ['relative/dir', './here', 'C:relative', 'a\0b']) {
    assert.throws(() => resolveConfigRoot({ env: { AKRS_CONFIG_HOME: bad }, platform: process.platform, homedir: '/h' }), CliUsageError, JSON.stringify(bad));
  }
  assert.equal(resolveConfigRoot({ env: { AKRS_CONFIG_HOME: '' }, platform: 'linux', homedir: '/h' }).source, 'home', 'an empty value is unset');
});

test('the resolver never reads the process environment on its own', () => {
  const found = resolveConfigRoot({ env: {}, platform: 'linux', homedir: '/only/this' });
  assert.equal(found.root, '/only/this/.config/akrs');
});

test('the test process itself is pointed at a throwaway config root', () => {
  assert.notEqual(PROCESS_CONFIG_HOME, undefined);
  const real = resolveConfigRoot({ env: { ...process.env, AKRS_CONFIG_HOME: '' }, platform: process.platform }).root;
  assert.notEqual(PROCESS_CONFIG_HOME, real);
});

test('normalized roots: absolute, forward slashes, no dot segments, no trailing slash', () => {
  for (const ok of ['/home/sam/p', 'C:/work/p', 'c:/p', '/a']) assert.equal(isNormalizedRoot(ok), true, ok);
  for (const bad of ['', 'p', 'rel/p', 'C:\\work\\p', '/a/', '/a//b', '/a/./b', '/a/../b', 'C:/', '/', '//server/share', '/a\0b', '/a\\b']) {
    assert.equal(isNormalizedRoot(bad), false, JSON.stringify(bad));
  }
});

const project = (overrides = {}) => ({ root: '/home/sam/p', workflow: 'akrs', name: 'p', added_at: '2026-10-22T08:00:00.000Z', ...overrides });
const registry = (projects) => ({ schema: REGISTRY_SCHEMA, projects });

test('the registry document is closed, sorted by root in code point order and unique', () => {
  assert.equal(validateRegistry(registry([])).ok, true);
  assert.equal(validateRegistry(registry([project({ root: '/a' }), project({ root: '/b' })])).ok, true);
  const issues = (value) => validateRegistry(value).issues.map(({ path, code }) => `${path} ${code}`);
  assert.ok(issues(registry([project({ root: '/b' }), project({ root: '/a' })])).includes('$.projects[1].root invalid_order'));
  assert.ok(issues(registry([project(), project()])).includes('$.projects[1].root duplicate_value'));
  assert.ok(issues({ ...registry([]), extra: 1 }).includes('$.extra unknown_key'));
  assert.ok(issues({ schema: 'akrs.projects/v0', projects: [] }).includes('$.schema invalid_value'));
  assert.ok(issues(registry([{ ...project(), extra: 1 }])).includes('$.projects[0].extra unknown_key'));
  assert.ok(issues(registry([project({ root: 'rel' })])).includes('$.projects[0].root invalid_path'));
  assert.ok(issues(registry([project({ workflow: '../x' })])).includes('$.projects[0].workflow invalid_path'));
  assert.ok(issues(registry([project({ name: 'two\nlines' })])).includes('$.projects[0].name invalid_value'));
  assert.ok(issues(registry([project({ name: 'x'.repeat(81) })])).includes('$.projects[0].name invalid_value'));
  assert.ok(issues(registry([project({ added_at: 'yesterday' })])).some((entry) => entry.startsWith('$.projects[0].added_at')));
});

test('the registry is written through the canonical codec: key order, two-space indent, LF, one final newline', () => {
  const text = renderRegistry([project({ root: '/b' }), project({ root: '/a' })]);
  assert.equal(text, '{\n  "schema": "akrs.projects/v1",\n  "projects": [\n    {\n      "root": "/a",\n      "workflow": "akrs",\n      "name": "p",\n      "added_at": "2026-10-22T08:00:00.000Z"\n    },\n    {\n      "root": "/b",\n      "workflow": "akrs",\n      "name": "p",\n      "added_at": "2026-10-22T08:00:00.000Z"\n    }\n  ]\n}\n');
  assert.equal(renderRegistry([]), '{\n  "schema": "akrs.projects/v1",\n  "projects": []\n}\n');
});
