import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PATH_CLASSES,
  classifyPath,
  hasNonTrivialCaseFold,
  isProvablyDisjoint,
  pathOverlap,
  validateGlobPattern,
} from '../../lib/schemas/glob.js';
import { PathSafetyError, validateRestrictedPath } from '../../lib/store/path-service.js';
import { validateRepoPath } from '../../lib/schemas/primitives.js';

test('F11 the path classes are file, dir, glob, and ephemeral', () => {
  assert.deepEqual(PATH_CLASSES, ['file', 'dir', 'glob', 'ephemeral']);
  assert.equal(Object.isFrozen(PATH_CLASSES), true);
});

test('F11 classifyPath separates globs from literals and names the rejection reason', () => {
  const table = [
    ['README.md', 'literal'],
    ['src/a.js', 'literal'],
    ['src/**', 'glob'],
    ['**/*.md', 'glob'],
    ['a/?/b', 'glob'],
    ['*.js', 'glob'],
    ['docs/**/x.md', 'glob'],
    ['a!b', 'literal'],
  ];
  for (const [value, expected] of table) assert.equal(classifyPath(value).class, expected, value);
  const rejected = [
    ['', 'invalid_path'], ['/x', 'invalid_path'], ['a//b', 'invalid_path'], ['../x', 'invalid_path'],
    ['a\\b', 'invalid_path'], ['a:b', 'invalid_path'], ['a/', 'invalid_path'], [5, 'invalid_path'],
    ['a[1]', 'invalid_glob'], ['a{b}', 'invalid_glob'], ['a**b', 'invalid_glob'], ['src/**.js', 'invalid_glob'],
    ['é', 'not_nfc'],
  ];
  for (const [value, reason] of rejected) {
    assert.deepEqual(classifyPath(value), { class: 'invalid', reason }, String(value));
  }
});

test('F11 validateGlobPattern accepts the restricted grammar and rejects everything else', () => {
  const check = (value) => {
    const issues = [];
    validateGlobPattern(value, '$.g', issues);
    return issues.map(({ code }) => code);
  };
  for (const good of ['*', '?', '**', 'a/**', '**/a', 'a/**/b', 'a*b', 'a?b', '*.md', 'a/b/c.md', 'plain']) {
    assert.deepEqual(check(good), [], good);
  }
  for (const bad of ['a**', '**a', 'a/***', '[a]', '{a,b}', '!x', '', 'a//b', '../a', 'a/', '\\a']) {
    const codes = check(bad);
    if (bad === '!x') assert.deepEqual(codes, [], bad);
    else assert.equal(codes.length > 0, true, bad);
  }
});

const OVERLAP_TABLE = [
  ['src/**', 'src/a.js', 'overlap'],
  ['src/*.js', 'src/*.ts', 'disjoint'],
  ['a/**/b', 'a/b', 'overlap'],
  ['*a*', '*b*', 'overlap'],
  ['Src/A.js', 'src/a.js', 'overlap'],
  ['SRC/**', 'src/deep/a.js', 'overlap'],
  ['src', 'src/a', 'disjoint'],
  ['src/**', 'src', 'overlap'],
  ['docs', 'docs/**', 'overlap'],
  ['**', 'any/thing/at/all', 'overlap'],
  ['**', '**', 'overlap'],
  ['**', 'a', 'overlap'],
  ['a/*', 'a/*/*', 'disjoint'],
  ['a/*/c', '*/b/*', 'overlap'],
  ['a/**/c', 'a/b/**/d', 'disjoint'],
  ['a/**/c', '**/d', 'disjoint'],
  ['a/**/c', '**/c', 'overlap'],
  ['*.md', 'README.md', 'overlap'],
  ['*.md', 'README.txt', 'disjoint'],
  ['?', 'ab', 'disjoint'],
  ['?', 'a', 'overlap'],
  ['??', 'ab', 'overlap'],
  ['a?c', 'a*c', 'overlap'],
  ['a?c', 'ac', 'disjoint'],
  ['a*', 'b*', 'disjoint'],
  ['*', '*', 'overlap'],
  ['*a', 'a*', 'overlap'],
  ['*/*', '**/x', 'overlap'],
  ['a/b', 'a/b', 'overlap'],
  ['a/b', 'a/B', 'overlap'],
  ['a/b', 'a/c', 'disjoint'],
  ['.*', '?', 'disjoint'],
  ['.*', '??', 'overlap'],
  ['.?', '?.', 'unknown_potential'],
  ['.*', '*', 'overlap'],
  ['akrs/**', 'akrs/roads/R1.json', 'overlap'],
  ['akrs/**', 'src/**', 'disjoint'],
  ['**/*.md', 'akrs/**', 'overlap'],
  ['**/*.js', 'akrs/**', 'overlap'],
  ['*/**', 'akrs/**', 'overlap'],
  ['src/**', 'SOT/**', 'disjoint'],
  ['**/a/**', '**/b/**', 'overlap'],
  ['x/**/y/**/z', 'x/y/z', 'overlap'],
  ['x/**/y/**/z', 'x/y', 'disjoint'],
];

test('F11 pathOverlap decides exactly on the restricted grammar, case-folded, and is symmetric', () => {
  for (const [left, right, expected] of OVERLAP_TABLE) {
    assert.equal(pathOverlap(left, right), expected, `${left} ~ ${right}`);
    assert.equal(pathOverlap(right, left), expected, `${right} ~ ${left}`);
    assert.equal(isProvablyDisjoint(left, right), expected === 'disjoint', `${left} ~ ${right}`);
  }
});

test('F11 inputs outside the grammar or over budget give unknown_potential, never a false disjoint', () => {
  for (const [left, right] of [
    ['a[1]', 'a1'], ['{a,b}', 'a'], ['a**b', 'ab'], ['../x', 'x'], ['', 'a'], ['a', ''], ['a\\b', 'a/b'],
    ['é.md', '*.md'], [5, 'a'], ['a', null], ['a//b', 'a/b'], ['a/', 'a'],
  ]) {
    assert.equal(pathOverlap(left, right), 'unknown_potential', `${String(left)} ~ ${String(right)}`);
    assert.equal(isProvablyDisjoint(left, right), false);
  }
  const deep = `${'a/'.repeat(100)}x`;
  assert.equal(pathOverlap(deep, deep), 'unknown_potential');
  const wide = 'a'.repeat(600);
  assert.equal(pathOverlap(wide, wide), 'unknown_potential');
});

// ---- seeded property test against an independent brute-force matcher -----------------------------------
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function segmentMatches(pattern, text) {
  if (pattern === '') return text === '';
  if (pattern[0] === '*') {
    for (let skip = 0; skip <= text.length; skip += 1) {
      if (segmentMatches(pattern.slice(1), text.slice(skip))) return true;
    }
    return false;
  }
  if (text === '') return false;
  return (pattern[0] === '?' || pattern[0] === text[0]) && segmentMatches(pattern.slice(1), text.slice(1));
}

function pathMatches(patternSegments, pathSegments) {
  if (patternSegments.length === 0) return pathSegments.length === 0;
  const [head, ...rest] = patternSegments;
  if (head === '**') {
    for (let skip = 0; skip <= pathSegments.length; skip += 1) {
      if (pathMatches(rest, pathSegments.slice(skip))) return true;
    }
    return false;
  }
  if (pathSegments.length === 0) return false;
  return segmentMatches(head, pathSegments[0]) && pathMatches(rest, pathSegments.slice(1));
}

function universe() {
  const letters = ['a', 'b', 'c'];
  const segments = [];
  for (const first of letters) {
    segments.push(first);
    for (const second of letters) segments.push(first + second);
  }
  const paths = [];
  const extend = (prefix, depth) => {
    for (const segment of segments) {
      const next = [...prefix, segment];
      paths.push(next);
      if (depth < 4) extend(next, depth + 1);
    }
  };
  extend([], 1);
  return paths;
}

function generatePattern(random) {
  const segmentCount = 1 + Math.floor(random() * 3);
  const tokens = ['a', 'b', 'A', '*', '?'];
  const segments = [];
  for (let index = 0; index < segmentCount; index += 1) {
    if (random() < 0.25) {
      segments.push('**');
      continue;
    }
    const length = 1 + Math.floor(random() * 2);
    let segment = '';
    for (let position = 0; position < length; position += 1) segment += tokens[Math.floor(random() * tokens.length)];
    segments.push(segment);
  }
  return segments.join('/');
}

test('F11 property: pathOverlap agrees with a brute-force matcher on seeded random pairs (sound and exact)', () => {
  const random = mulberry32(0x5eed1157);
  const paths = universe();
  assert.equal(paths.length, 22620);
  const pool = [...new Set(Array.from({ length: 140 }, () => generatePattern(random)))].slice(0, 90);
  assert.equal(pool.length >= 60, true);
  const matched = new Map();
  const matchesOf = (pattern) => {
    if (!matched.has(pattern)) {
      const segments = pattern.toLowerCase().split('/');
      const hits = new Set();
      paths.forEach((path, index) => {
        if (pathMatches(segments, path)) hits.add(index);
      });
      matched.set(pattern, hits);
    }
    return matched.get(pattern);
  };
  let overlaps = 0;
  let disjoints = 0;
  for (let left = 0; left < pool.length; left += 1) {
    assert.equal(pathOverlap(pool[left], pool[left]), 'overlap', `reflexive ${pool[left]}`);
    for (let right = left + 1; right < pool.length; right += 1) {
      const [smaller, larger] = [matchesOf(pool[left]), matchesOf(pool[right])]
        .sort((first, second) => first.size - second.size);
      let witness = false;
      for (const index of smaller) {
        if (larger.has(index)) {
          witness = true;
          break;
        }
      }
      const result = pathOverlap(pool[left], pool[right]);
      assert.equal(result, pathOverlap(pool[right], pool[left]), `symmetry ${pool[left]} ~ ${pool[right]}`);
      assert.notEqual(result, 'unknown_potential', `${pool[left]} ~ ${pool[right]}`);
      if (witness) assert.equal(result, 'overlap', `soundness: witness exists for ${pool[left]} ~ ${pool[right]}`);
      else assert.equal(result, 'disjoint', `exactness: no witness for ${pool[left]} ~ ${pool[right]}`);
      if (witness) overlaps += 1;
      else disjoints += 1;
    }
  }
  assert.equal(overlaps > 100, true);
  assert.equal(disjoints > 100, true);
});

const cp = (...points) => String.fromCodePoint(...points);

test('F11 case folds that are not 1:1 code point maps are detected generically', () => {
  const unsafe = [0x130, 0x131, 0x17f, 0xdf, 0x1e9e, 0x212a, 0x3c2, 0xfb01, 0x149, 0x1f0];
  for (const point of unsafe) assert.equal(hasNonTrivialCaseFold(cp(point)), true, point.toString(16));
  assert.equal(hasNonTrivialCaseFold(`dir/${cp(0x130)}.txt`), true);
  for (const safe of ['', 'abc', 'ABC', 'src/a.js', cp(0xe9), cp(0xc9), cp(0x3c3), cp(0x3a3), cp(0x416), cp(0x65e5, 0x672c), cp(0x1f600), cp(0x627, 0x644)]) {
    assert.equal(hasNonTrivialCaseFold(safe), false, safe);
  }
});

test('F11 patterns with non-1:1 case folds are never claimed disjoint (unknown_potential), ASCII and safe folds are unchanged', () => {
  const dotted = cp(0x130);
  const dotless = cp(0x131);
  const longS = cp(0x17f);
  const kelvin = cp(0x212a);
  const sharp = cp(0xdf);
  const capitalSharp = cp(0x1e9e);
  const sigma = cp(0x3c2);
  const pairs = [
    ['a/?', `a/${dotted}`],
    ['I', dotless],
    [`stra${sharp}e/*`, 'STRASSE/*'],
    ['s', longS],
    ['k', kelvin],
    [`${sharp}`, capitalSharp],
    [`x${sigma}`, `x${cp(0x3c3)}`],
    [`${dotted}/**`, 'a/b'],
    ['a/*', `a/${kelvin}`],
    [`**/${longS}`, 'b'],
  ];
  for (const [left, right] of pairs) {
    assert.equal(pathOverlap(left, right), 'unknown_potential', `${left} | ${right}`);
    assert.equal(pathOverlap(right, left), 'unknown_potential', `${right} | ${left}`);
    assert.equal(isProvablyDisjoint(left, right), false, `${left} | ${right}`);
  }
  assert.equal(pathOverlap(cp(0xe9), cp(0xc9)), 'overlap');
  assert.equal(pathOverlap(cp(0xe9), 'e'), 'disjoint');
  assert.equal(pathOverlap(`${cp(0xe9)}/*`, `${cp(0xc9)}/a`), 'overlap');
  assert.equal(pathOverlap('a/b', 'A/B'), 'overlap');
  assert.equal(pathOverlap('a/b', 'a/c'), 'disjoint');
  assert.equal(pathOverlap('src/*.js', 'src/a.ts'), 'disjoint');
});

const INVISIBLE_RANGES = [[0x80, 0x9f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]];

test('F11 artifact paths reject C1 controls and invisible or bidirectional format characters', () => {
  for (const [from, to] of INVISIBLE_RANGES) {
    for (let point = from; point <= to; point += 1) {
      for (const path of [`a${cp(point)}b.txt`, `${cp(point)}a`, `dir/a${cp(point)}`, `a${cp(point)}*`]) {
        assert.deepEqual(classifyPath(path), { class: 'invalid', reason: 'invalid_path' }, `${point.toString(16)} ${path}`);
      }
      assert.throws(() => validateRestrictedPath(`dir/a${cp(point)}b`), PathSafetyError, point.toString(16));
    }
  }
  for (const ok of [cp(0xe9), cp(0x65e5, 0x672c), cp(0x627, 0x644), cp(0x1f600), cp(0xa0), cp(0x3000)]) {
    assert.equal(classifyPath(`dir/${ok}.txt`).class, 'literal', ok);
    assert.equal(validateRestrictedPath(`dir/${ok}.txt`), `dir/${ok}.txt`);
  }
  assert.throws(() => validateRestrictedPath(`akrs/${cp(0x202e)}x`), /control|invisible|format/);
});

test('F11 artifact paths reject segments ending in a dot or space and Windows device names', () => {
  for (const path of ['a./b', 'a /b', 'x.', 'x ', 'dir/x. ', 'dir/x .', '...', 'a/b./c', 'src/*.', 'src/* ', '?.', '**/x.']) {
    assert.equal(classifyPath(path).class, 'invalid', JSON.stringify(path));
  }
  const devices = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9'];
  for (const device of devices) {
    for (const name of [device, device.toLowerCase(), `${device[0]}${device.slice(1).toLowerCase()}`, `${device}.txt`, `${device.toLowerCase()}.tar.gz`]) {
      for (const path of [name, `src/${name}`, `${name}/x.js`]) {
        assert.deepEqual(classifyPath(path), { class: 'invalid', reason: 'invalid_path' }, path);
      }
    }
  }
  for (const ok of ['src/console.js', 'conx', 'com10', 'com0', 'lpt', 'lpt10.txt', 'nulls', 'auxiliary/x', 'prn1', '.env', '.github/x.yml',
    'src/a.b', 'a/.hidden', 'x.y.z', 'src/*.js', 'src/**', 'con*', 'co?', 'a.b/c', 'v1.0/x']) {
    assert.notEqual(classifyPath(ok).class, 'invalid', ok);
  }
  const issues = [];
  validateRepoPath('src/nul.txt', '$.p', issues);
  assert.deepEqual(issues.map(({ code, path }) => [code, path]), [['invalid_path', '$.p']]);
  assert.equal(pathOverlap('CON', 'con'), 'unknown_potential');
});

test('F11 the shared P0 path service keeps allowing device-like and dotted names (it also resolves existing POSIX files)', () => {
  for (const ok of ['src/nul.txt', 'CON', 'a./b', 'x ', 'docs/aux']) {
    assert.equal(validateRestrictedPath(ok), ok);
  }
});

test('F11 artifact paths cap each segment at 255 UTF-16 units and the whole path at 1024', () => {
  const invalid = { class: 'invalid', reason: 'invalid_path' };
  const segment = (length) => 'a'.repeat(length);
  assert.equal(classifyPath(`d/${segment(255)}`).class, 'literal');
  assert.deepEqual(classifyPath(`d/${segment(256)}`), invalid);
  assert.deepEqual(classifyPath(segment(256)), invalid);
  assert.deepEqual(classifyPath(`${segment(255)}/${segment(256)}`), invalid);
  // astral characters are two UTF-16 units each
  assert.equal(classifyPath(`d/${cp(0x1f600).repeat(127)}`).class, 'literal');
  assert.deepEqual(classifyPath(`d/${cp(0x1f600).repeat(128)}`), invalid);
  // globs count their pattern text
  assert.equal(classifyPath(`d/${segment(254)}*`).class, 'glob');
  assert.deepEqual(classifyPath(`d/${segment(255)}*`), invalid);
  // total length: five segments plus four slashes
  const total = (lengths) => lengths.map(segment).join('/');
  assert.equal(total([205, 205, 205, 205, 200]).length, 1024);
  assert.equal(classifyPath(total([205, 205, 205, 205, 200])).class, 'literal');
  assert.deepEqual(classifyPath(total([205, 205, 205, 205, 201])), invalid);
  assert.deepEqual(classifyPath(`${total([205, 205, 205, 205, 200])}/**`), invalid);

  const issues = [];
  validateRepoPath(`d/${segment(256)}`, '$.p', issues);
  assert.deepEqual(issues.map(({ code, path }) => [code, path]), [['invalid_path', '$.p']]);
  assert.equal(pathOverlap(`d/${segment(256)}`, 'd/*'), 'unknown_potential');
});

test('F11 the shared P0 path service has no length cap of its own (it resolves existing repository files)', () => {
  const long = `d/${'a'.repeat(300)}`;
  assert.equal(validateRestrictedPath(long), long);
  const wide = Array.from({ length: 6 }, () => 'a'.repeat(200)).join('/');
  assert.equal(validateRestrictedPath(wide), wide);
});
