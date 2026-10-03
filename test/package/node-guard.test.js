import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  MINIMUM_NODE_VERSION,
  checkNodeVersion,
  failureExitCode,
  formatInternalError,
  refusalExitCode,
} from '../../bin/node-guard.js';

const binUrl = (name) => new URL(`../../bin/${name}`, import.meta.url);

const cases = [
  ['16.20.2', false],
  ['18.0.0', false],
  ['20.19.0', false],
  ['22.0.0', false],
  ['22.16.9', false],
  ['22.17.0', true],
  ['22.17.1', true],
  ['22.22.3', true],
  ['23.0.0', true],
  ['24.0.0', true],
  ['100.0.0', true],
  ['v22.17.0', true],
  ['v22.16.0', false],
  ['22.17.0-nightly20250101', true],
  ['', false],
  ['not-a-version', false],
  ['22', false],
  ['22.17', false],
  ['22.x.0', false],
  [undefined, false],
  [null, false],
  [22, false],
];

test('minimum Node version is 22.17.0', () => {
  assert.equal(MINIMUM_NODE_VERSION, '22.17.0');
});

for (const [version, accepted] of cases) {
  test(`checkNodeVersion(${JSON.stringify(version)}) is ${accepted ? 'accepted' : 'refused'}`, () => {
    const result = checkNodeVersion(version);
    assert.equal(result.ok, accepted);
    if (accepted) {
      assert.equal(result.message, '');
    } else {
      assert.match(result.message, /akrs requires Node\.js >=22\.17\.0/);
      assert.match(result.message, /Upgrade Node\.js/);
    }
  });
}

test('refusal message names the detected version', () => {
  assert.match(checkNodeVersion('16.20.2').message, /found v16\.20\.2/);
  assert.match(checkNodeVersion('v18.0.0').message, /found v18\.0\.0/);
  assert.match(checkNodeVersion('garbage').message, /found "garbage"/);
});

test('exit codes: refusal is 2 except postinstall, internal failure is 4 except postinstall', () => {
  for (const [argv, refusal, failure] of [
    [[], 2, 4],
    [['--version', '--json'], 2, 4],
    [['validate'], 2, 4],
    [['init'], 2, 4],
    [['sync'], 2, 4],
    [['postinstall'], 0, 0],
    [['postinstall', '--json'], 0, 0],
    [['--json', 'postinstall'], 2, 4],
    [undefined, 2, 4],
  ]) {
    assert.equal(refusalExitCode(argv), refusal, JSON.stringify(argv));
    assert.equal(failureExitCode(argv), failure, JSON.stringify(argv));
  }
});

test('internal error message is one line prefixed with akrs: internal error:', () => {
  assert.equal(formatInternalError(new Error('boom')), 'akrs: internal error: boom\n');
  assert.equal(formatInternalError(new Error('a\r\nb\n  c')), 'akrs: internal error: a b c\n');
  assert.equal(formatInternalError('plain'), 'akrs: internal error: plain\n');
  assert.equal(formatInternalError(undefined), 'akrs: internal error: undefined\n');
  assert.equal(formatInternalError(null), 'akrs: internal error: null\n');
  assert.equal(formatInternalError({ message: '' }), 'akrs: internal error: unknown error\n');
});

test('bin/akrs.js loads nothing but the guard before the version check', async () => {
  const source = await readFile(binUrl('akrs.js'), 'utf8');
  const staticImports = [...source.matchAll(/^import\b[^;]*?from\s+'([^']+)';/gms)].map((match) => match[1]);
  assert.deepEqual(staticImports, ['./node-guard.js']);
  assert.equal((source.match(/^import\b/gm) ?? []).length, 1, 'exactly one static import statement');
  assert.match(source, /checkNodeVersion\(process\.versions\.node\)/);
  assert.match(source, /refusalExitCode\(/);
  assert.match(source, /failureExitCode\(/);
  assert.match(source, /\.catch\(/);
  assert.match(source, /import\('\.\.\/lib\/core\/index\.js'\)/);
  assert.match(source, /import\('\.\/cli-adapter\.js'\)/);
});

test('guard module uses conservative syntax only', async () => {
  const source = await readFile(binUrl('node-guard.js'), 'utf8');
  const code = source.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  for (const [name, pattern] of [
    ['optional chaining', /\?\./],
    ['nullish coalescing', /\?\?/],
    ['import attributes', /\bwith\s*\{/],
    ['import.meta', /import\.meta/],
    ['await', /\bawait\b/],
    ['arrow function', /=>/],
    ['template literal', /`/],
    ['class', /\bclass\b/],
    ['spread', /\.\.\./],
    ['import statement', /^import\s/m],
  ]) {
    assert.equal(pattern.test(code), false, `node-guard.js must not use ${name}`);
  }
});
