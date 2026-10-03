import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ARTIFACT_SCHEMA_ID_PATTERN,
  ID_MAX_LENGTH,
  ID_PATTERN,
  isArtifactSchemaId,
  isId,
  isUlid,
} from '../../lib/schemas/common.js';
import {
  EXCLUDED_NAMESPACES,
  appendIndex,
  appendKey,
  isExcludedNamespace,
  issuesToFindingDetail,
  toJsonPointer,
  validateArgv,
  validateIntegerRange,
  validateIsoTimestamp,
  validateLineRange,
  validateRepoPath,
  validateSha256,
} from '../../lib/schemas/primitives.js';

function run(validator, value, ...rest) {
  const issues = [];
  validator(value, '$.x', issues, ...rest);
  return issues;
}

const codes = (issues) => issues.map(({ code }) => code);
const NFC_U = '\u00fc';
const NFD_U = 'u\u0308';

test('Q2/Q8 artifact schema IDs and explicit IDs follow the frozen grammars', () => {
  for (const good of ['akrs.road/v1', 'akrs.executors/v1', 'akrs.scope-request/v12']) {
    assert.equal(isArtifactSchemaId(good), true, good);
  }
  for (const bad of ['akrs.road', 'akrs.road/v0', 'akrs.Road/v1', 'akrs.road/v1/x', 'road/v1', 'akrs.packet/v02', '', null, 5]) {
    assert.equal(isArtifactSchemaId(bad), false, String(bad));
  }
  assert.equal(ARTIFACT_SCHEMA_ID_PATTERN.test('akrs.packet/v2'), true);
  for (const good of ['R1', 'R-P6-1', 'T-P6-1', 'P6', 'a.b-c', 'A'.repeat(ID_MAX_LENGTH)]) {
    assert.equal(isId(good), true, good);
  }
  for (const bad of ['', '1R', '-R', 'R-', 'R--1', 'R_1', 'R 1', 'R/1', 'R.', 'é', 'A'.repeat(ID_MAX_LENGTH + 1), null, 7]) {
    assert.equal(isId(bad), false, String(bad));
  }
  assert.equal(ID_PATTERN.test('R-1'), true);
  assert.equal(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV'), true);
  for (const bad of ['01ARZ3NDEKTSV4RRFFQ69G5FA', '01arz3ndektsv4rrffq69g5fav', '01ARZ3NDEKTSV4RRFFQ69G5FAI', null,
    '8ZZZZZZZZZZZZZZZZZZZZZZZZZ', '80000000000000000000000000', 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ']) {
    assert.equal(isUlid(bad), false, String(bad));
  }
  for (const good of ['7ZZZZZZZZZZZZZZZZZZZZZZZZZ', '00000000000000000000000000', '01HZX9Q7M3T5V8W2K4N6P0R1S2']) {
    assert.equal(isUlid(good), true, good);
  }
});

const PATH_TABLE = [
  // [value, declared class, allow, expected issue codes]
  ['README.md', undefined, undefined, []],
  ['src/a.js', 'file', undefined, []],
  ['src/components', 'dir', undefined, []],
  ['akrs/tmp/handoff.md', 'ephemeral', undefined, []],
  ['src/**', 'glob', undefined, []],
  ['**/*.md', undefined, undefined, []],
  ['src/*.js', undefined, ['glob'], []],
  ['src/a b/c.md', 'file', undefined, []],
  [`${NFC_U}ber/\u65e5\u672c.md`, 'file', undefined, []],
  ['a!b', 'file', undefined, []],
  ['', 'file', undefined, ['invalid_path']],
  ['/abs/x', 'file', undefined, ['invalid_path']],
  ['C:/x', 'file', undefined, ['invalid_path']],
  ['C:x', 'file', undefined, ['invalid_path']],
  ['//server/share', 'file', undefined, ['invalid_path']],
  ['\\\\server\\share', 'file', undefined, ['invalid_path']],
  ['..', 'file', undefined, ['invalid_path']],
  ['../x', 'file', undefined, ['invalid_path']],
  ['a/../b', 'file', undefined, ['invalid_path']],
  ['a/./b', 'file', undefined, ['invalid_path']],
  ['./a', 'file', undefined, ['invalid_path']],
  ['a//b', 'file', undefined, ['invalid_path']],
  ['a/', 'dir', undefined, ['invalid_path']],
  ['a\\b', 'file', undefined, ['invalid_path']],
  ['a\u0000b', 'file', undefined, ['invalid_path']],
  ['a:b', 'file', undefined, ['invalid_path']],
  ['a.txt::$DATA', 'file', undefined, ['invalid_path']],
  ['a\u0001b', 'file', undefined, ['invalid_path']],
  ['a\u2028b', 'file', undefined, ['invalid_path']],
  ['a\ud800b', 'file', undefined, ['invalid_path']],
  [`${NFD_U}ber.md`, 'file', undefined, ['not_nfc']],
  ['a[1].md', undefined, undefined, ['invalid_glob']],
  ['a{b,c}', undefined, undefined, ['invalid_glob']],
  ['a**b', undefined, undefined, ['invalid_glob']],
  ['***', undefined, undefined, ['invalid_glob']],
  ['src/**.js', undefined, undefined, ['invalid_glob']],
  ['**a/b', undefined, undefined, ['invalid_glob']],
  ['src/*.js', 'file', undefined, ['class_mismatch']],
  ['src/?.js', 'dir', undefined, ['class_mismatch']],
  ['tmp/*', 'ephemeral', undefined, ['class_mismatch']],
  ['src/a.js', 'glob', undefined, ['class_mismatch']],
  ['src/a.js', 'folder', undefined, ['class_mismatch']],
  ['src/a.js', 'file', ['dir'], ['class_mismatch']],
  ['src/a.js', undefined, ['glob'], ['class_mismatch']],
  ['src/*.js', undefined, ['file', 'dir'], ['class_mismatch']],
  ['src/*.js', 'glob', ['file'], ['class_mismatch']],
  [7, 'file', undefined, ['invalid_path']],
  [null, 'file', undefined, ['invalid_path']],
];

test('F11 validateRepoPath enforces lexical safety, NFC, glob grammar, and path classes', () => {
  for (const [value, declared, allow, expected] of PATH_TABLE) {
    const options = {};
    if (declared !== undefined) options.class = declared;
    if (allow !== undefined) options.allow = allow;
    const issues = run(validateRepoPath, value, options);
    assert.deepEqual(codes(issues), expected, `${JSON.stringify(value)} class=${declared} allow=${allow}`);
    for (const entry of issues) assert.equal(entry.path, '$.x');
  }
  assert.deepEqual(run(validateRepoPath, 'a/b.md'), []);
});

test('F11 validateRepoPath accepts the four classes by default and every issue carries a message', () => {
  for (const [value, klass] of [['a.md', 'file'], ['a', 'dir'], ['a/*', 'glob'], ['a/tmp', 'ephemeral']]) {
    assert.deepEqual(run(validateRepoPath, value, { class: klass }), [], `${value} ${klass}`);
  }
  for (const entry of run(validateRepoPath, '../x')) assert.equal(typeof entry.message, 'string');
});

test('F11 validateLineRange accepts null or an inclusive 1-based [start,end] integer pair', () => {
  for (const good of [null, [1, 1], [1, 10], [5, 5], [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]]) {
    assert.deepEqual(run(validateLineRange, good), [], JSON.stringify(good));
  }
  for (const bad of [[0, 3], [5, 3], [1], [], [1, 2, 3], [1.5, 2], [-1, 2], ['1', '2'], [1, null], 'x', {}, 5, undefined, [1, 2 ** 53]]) {
    const issues = run(validateLineRange, bad);
    assert.equal(issues.length > 0, true, JSON.stringify(bad));
    assert.equal(codes(issues).every((code) => code === 'invalid_line_range' || code === 'invalid_type'), true);
  }
});

test('F11 validateArgv requires a non-empty array of non-empty NUL-free strings', () => {
  for (const good of [['npm', 'test'], ['node', '--test', 'a b'], ['x']]) {
    assert.deepEqual(run(validateArgv, good), [], JSON.stringify(good));
  }
  for (const bad of [[], '', 'npm test', [''], ['npm', ''], ['npm', 1], ['a\u0000b'], null, {}, [['npm']]]) {
    assert.equal(run(validateArgv, bad).length > 0, true, JSON.stringify(bad));
  }
});

test('Q4 validateArgv rejects lone surrogates in any entry but accepts paired astral characters', () => {
  const high = String.fromCharCode(0xd800);
  const low = String.fromCharCode(0xdc00);
  for (const bad of [[`a${high}`], [low], [`${low}${high}`], ['npm', `x${high}y`], [`${high}`, 'ok']]) {
    const issues = run(validateArgv, bad);
    assert.equal(issues.length > 0, true, JSON.stringify(bad));
    assert.equal(issues.every(({ code }) => code === 'invalid_argv'), true);
  }
  assert.deepEqual(run(validateArgv, ['echo', String.fromCodePoint(0x1f600), 'café']), []);
  assert.deepEqual(run(validateArgv, [`${high}${low}`]), []);
});

test('F4 validateIsoTimestamp, validateSha256, and validateIntegerRange wrap the shared formats', () => {
  assert.deepEqual(run(validateIsoTimestamp, '2026-10-03T10:00:00.000Z'), []);
  for (const bad of ['2026-10-03', '2026-10-03T10:00:00Z', '2026-10-03T10:00:00.000+01:00', 5, null]) {
    assert.equal(run(validateIsoTimestamp, bad).length, 1, String(bad));
  }
  assert.deepEqual(run(validateSha256, `sha256:${'a'.repeat(64)}`), []);
  for (const bad of [`sha256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(63)}`, 'a'.repeat(64), null]) {
    assert.equal(run(validateSha256, bad).length, 1, String(bad));
  }
  assert.deepEqual(run(validateIntegerRange, 5, { min: 0, max: 10 }), []);
  assert.deepEqual(run(validateIntegerRange, 0, { min: 0, max: 10 }), []);
  assert.deepEqual(run(validateIntegerRange, 10, { min: 0, max: 10 }), []);
  for (const bad of [-1, 11, 1.5, '5', null, Number.NaN, 2 ** 53]) {
    assert.equal(run(validateIntegerRange, bad, { min: 0, max: 10 }).length, 1, String(bad));
  }
});

test('Q24 issue paths convert to RFC 6901 pointers and finding details are deterministic JSON', () => {
  assert.equal(toJsonPointer('$'), '');
  assert.equal(toJsonPointer('$.reads[0].path'), '/reads/0/path');
  assert.equal(toJsonPointer('$.a[12][3].b'), '/a/12/3/b');
  assert.equal(toJsonPointer('$.a/b~c.d'), '/a~1b~0c/d');
  assert.throws(() => toJsonPointer('reads[0]'), TypeError);
  assert.throws(() => toJsonPointer(5), TypeError);

  const issues = [
    { path: '$.b[0]', code: 'invalid_value', message: 'z' },
    { path: '$.a', code: 'missing_key', message: 'a' },
    { path: '$.a', code: 'invalid_type', message: 'b' },
  ];
  const detail = issuesToFindingDetail(issues);
  assert.deepEqual(detail, {
    issues: [
      { pointer: '/a', code: 'invalid_type', message: 'b' },
      { pointer: '/a', code: 'missing_key', message: 'a' },
      { pointer: '/b/0', code: 'invalid_value', message: 'z' },
    ],
  });
  assert.deepEqual(issuesToFindingDetail([...issues].reverse()), detail);
  assert.deepEqual(issuesToFindingDetail([]), { issues: [] });
  assert.equal(JSON.stringify(detail), JSON.stringify(JSON.parse(JSON.stringify(detail))));
});

test('F16 the drafts, cache, and ops namespaces are excluded relative to the workflow root, case-folded', () => {
  assert.deepEqual(EXCLUDED_NAMESPACES, ['drafts', '.cache', '.ops']);
  for (const path of [
    'akrs/drafts/x.json', 'akrs/drafts', 'akrs/.cache/page/a.png', 'akrs/.ops/leases/r.json', 'AKRS/Drafts/x.json', 'akrs/.CACHE/x',
  ]) {
    assert.equal(isExcludedNamespace(path), true, path);
  }
  for (const path of [
    'akrs/roads/R1.json', 'akrs/drafts-old/x', 'akrs/draftsx', 'x/akrs/drafts/a', 'drafts/x', 'akrs', '', 'akrs/.opsy/x', 'akrs/memory/ui.md',
  ]) {
    assert.equal(isExcludedNamespace(path), false, path);
  }
  assert.equal(isExcludedNamespace('flow/work/drafts/a', { workflowRelative: 'flow/work' }), true);
  assert.equal(isExcludedNamespace('akrs/drafts/a', { workflowRelative: 'flow/work' }), false);
  assert.equal(isExcludedNamespace(5), false);
  assert.equal(isExcludedNamespace(null), false);
});

test('F11 path handling is platform independent: only forward-slash relative paths are accepted', async () => {
  const { default: nodePath } = await import('node:path');
  const joined = (flavor) => flavor.join('akrs', 'drafts', 'x.json');
  assert.equal(joined(nodePath.posix), 'akrs/drafts/x.json');
  assert.equal(joined(nodePath.win32), 'akrs\\drafts\\x.json');

  const verdict = (value) => {
    const issues = [];
    validateRepoPath(value, '$.p', issues);
    return issues.length === 0;
  };
  assert.equal(verdict(joined(nodePath.posix)), true);
  assert.equal(verdict(joined(nodePath.win32)), false);
  assert.equal(isExcludedNamespace(joined(nodePath.posix)), true);
  assert.equal(isExcludedNamespace(joined(nodePath.win32)), false);
});

test('Q24 appendKey/appendIndex write unambiguous issue paths: identifier keys as .key, everything else quoted', () => {
  assert.equal(appendKey('$', 'reads'), '$.reads');
  assert.equal(appendKey('$.a', '_b9'), '$.a._b9');
  assert.equal(appendIndex('$.a', 3), '$.a[3]');
  assert.equal(appendKey(appendIndex(appendKey('$', 'a'), 0), 'b'), '$.a[0].b');
  assert.equal(appendKey('$', ''), '$[""]');
  assert.equal(appendKey('$', 'a.b'), '$["a.b"]');
  assert.equal(appendKey('$', 'x[0]'), '$["x[0]"]');
  assert.equal(appendKey('$', '0'), '$["0"]');
  assert.equal(appendKey('$', 'a-b'), '$["a-b"]');
  assert.equal(appendKey('$', 'café'), '$["café"]');
  assert.equal(appendKey('$', 'q"uote'), '$["q\\"uote"]');
  assert.equal(appendKey('$', 'new\nline'), '$["new\\nline"]');
  assert.equal(appendKey('$', 'a\\b'), '$["a\\\\b"]');
  assert.throws(() => appendKey('$', 5), TypeError);
  assert.throws(() => appendIndex('$', -1), TypeError);
  assert.throws(() => appendIndex('$', 1.5), TypeError);
  assert.throws(() => appendIndex('$', '1'), TypeError);
});

test('Q24 toJsonPointer reads the quoted form and never throws on a path built with the helpers', () => {
  assert.equal(toJsonPointer('$[""]'), '/');
  assert.equal(toJsonPointer('$["a.b"]'), '/a.b');
  assert.equal(toJsonPointer('$["x[0]"]'), '/x[0]');
  assert.equal(toJsonPointer('$["a/b~c"].d[2]'), '/a~1b~0c/d/2');
  assert.equal(toJsonPointer('$["q\\"uote"]'), '/q"uote');
  assert.equal(toJsonPointer('$.a[""].b'), '/a//b');
  assert.equal(toJsonPointer('$["0"]'), '/0');
  assert.equal(toJsonPointer('$["a\\\\b"]'), '/a\\b');
  const keys = ['', '.', '..', '[', ']', '[0]', 'a.b', 'a[0]', '"', '\\', '/', '~', '~1', ' ', 'é', '\u{1F600}', '0', '-1', 'a b', 'ok', '_', '$',
    String.fromCharCode(0xd800), String.fromCharCode(0x2028), 'x'.repeat(300)];
  for (const first of keys) {
    for (const second of keys) {
      const path = appendIndex(appendKey(appendKey('$', first), second), 7);
      const expected = `/${first.replaceAll('~', '~0').replaceAll('/', '~1')}/${second.replaceAll('~', '~0').replaceAll('/', '~1')}/7`;
      assert.equal(toJsonPointer(path), expected, JSON.stringify([first, second]));
    }
  }
  assert.equal(toJsonPointer('$.a.b'), '/a/b');
});

test('Q24 toJsonPointer still rejects malformed paths with TypeError', () => {
  for (const bad of ['', '.a', '$.', '$..a', '$[', '$[a]', '$[-1]', '$["a"', '$["a"]x', '$["a]', '$[\'a\']', '$["\\x"]', '$.a[', '$.a]', '$ .a', '$"a"', '$[""', '$[1.5]']) {
    assert.throws(() => toJsonPointer(bad), TypeError, JSON.stringify(bad));
  }
});

test('Q24 issuesToFindingDetail handles issues on odd keys without throwing', () => {
  const issues = [
    { path: appendKey('$', ''), code: 'unknown_key', message: 'empty' },
    { path: appendKey('$', 'a.b'), code: 'unknown_key', message: 'dot' },
    { path: appendKey('$', 'x[0]'), code: 'unknown_key', message: 'index-like' },
  ];
  const detail = issuesToFindingDetail(issues);
  assert.deepEqual(detail.issues.map(({ pointer }) => pointer).sort(), ['/', '/a.b', '/x[0]']);
});

test('F11 excluded-namespace folding is conservative for non-1:1 case folds and unchanged for ASCII', () => {
  const longS = String.fromCodePoint(0x17f);
  const dotless = String.fromCodePoint(0x131);
  for (const path of [`akrs/draft${longS}/x.json`, `akrs/DRAFT${longS}`, `akrs/.cache/${longS}`, `akrs/.op${longS}/lease.json`, `akrs/.ops/${dotless}`]) {
    assert.equal(isExcludedNamespace(path), true, path);
  }
  for (const path of ['akrs/draftsx', 'akrs/roads/R1.json', `akrs/road${longS}/x`, `akrs/${dotless}/x`, 'akrs/drafts-old/x']) {
    assert.equal(isExcludedNamespace(path), false, path);
  }
  assert.equal(isExcludedNamespace('akrs/Drafts/x'), true);
  assert.equal(isExcludedNamespace('akrs/drafts/x', { workflowRelative: `akr${longS}` }), true);
});

test('Q8 IDs reject Windows device-name stems (text before the first dot, any case) because IDs become file names', () => {
  const devices = ['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`), ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)];
  for (const device of devices) {
    for (const id of [device, device.toLowerCase(), `${device[0]}${device.slice(1).toLowerCase()}`, `${device}.v1`, `${device.toLowerCase()}.a.b`]) {
      assert.equal(isId(id), false, id);
    }
  }
  for (const ok of ['con-1', 'console', 'nul1', 'com0', 'com10', 'lpt', 'aux-x', 'prn2', 'R-con', 'x.con', 'R1.nul', 'nulls', 'communication', 'Cony', 'a.aux', 'CON-1.x']) {
    assert.equal(isId(ok), true, ok);
  }
  assert.equal(isId('R-1'), true);
  assert.equal(isId('aux.v1'.toUpperCase()), false);
});
