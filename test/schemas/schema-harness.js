import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const fixtureRoot = fileURLToPath(new URL('../fixtures/schemas/', import.meta.url));

export const clone = (value) => structuredClone(value);

export async function loadFixtures(kind, group) {
  const directory = `${fixtureRoot}${kind}/${group}`;
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(names.map(async (name) => ({
    name: name.slice(0, -'.json'.length),
    value: JSON.parse(await readFile(`${directory}/${name}`, 'utf8')),
  })));
}

// ----- path helpers over '$.a[0].b' style issue paths (relative: 'a[0].b', '' = root)
export function parsePath(path) {
  const segments = [];
  for (const part of path.split('.')) {
    if (part === '') continue;
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (match[1] !== '') segments.push(match[1]);
    for (const index of match[2].matchAll(/\[(\d+)\]/g)) segments.push(Number(index[1]));
  }
  return segments;
}

export function getAt(value, path) {
  return parsePath(path).reduce((node, segment) => node[segment], value);
}

export function setAt(value, path, replacement) {
  const segments = parsePath(path);
  if (segments.length === 0) return replacement;
  const parent = getAt(value, segments.slice(0, -1).reduce(
    (text, segment) => (typeof segment === 'number' ? `${text}[${segment}]` : `${text}.${segment}`), ''));
  parent[segments.at(-1)] = replacement;
  return value;
}

export function deleteAt(value, path) {
  const segments = parsePath(path);
  const parent = getAt(value, segments.slice(0, -1).reduce(
    (text, segment) => (typeof segment === 'number' ? `${text}[${segment}]` : `${text}.${segment}`), ''));
  delete parent[segments.at(-1)];
  return value;
}

const join = (base, key) => (typeof key === 'number' ? `${base}[${key}]` : base === '' ? key : `${base}.${key}`);

// every container/leaf path of a value, e.g. ['', 'reads', 'reads[0]', 'reads[0].path', ...]
export function allPaths(value, base = '', skip = new Set()) {
  const paths = base === '' ? [] : [base];
  if (skip.has(base)) return paths;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => paths.push(...allPaths(entry, join(base, index), skip)));
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) paths.push(...allPaths(value[key], join(base, key), skip));
  }
  return paths;
}

export function objectPaths(value, base = '', skip = new Set()) {
  const paths = [];
  if (Array.isArray(value)) {
    value.forEach((entry, index) => paths.push(...objectPaths(entry, join(base, index), skip)));
  } else if (value !== null && typeof value === 'object') {
    paths.push(base);
    if (!skip.has(base)) {
      for (const key of Object.keys(value)) paths.push(...objectPaths(value[key], join(base, key), skip));
    }
  }
  return paths;
}

export const issuePath = (path) => (path === '' ? '$' : `$.${path}`.replace(/\.\[/g, '['));
const under = (candidate, path) => candidate === path
  || candidate.startsWith(`${path}.`) || candidate.startsWith(`${path}[`);
const normalizeIndexes = (path) => path.replace(/\[\d+\]/g, '[]');
// the nearest ancestor (or the path itself) that is validated as one atomic unit, or null
function atomicAncestor(where, unitPaths) {
  for (let end = where.length; end > 1; end -= 1) {
    const prefix = where.slice(0, end);
    if (unitPaths.includes(normalizeIndexes(prefix).replace(/^\$\.?/, ''))) return prefix;
  }
  return null;
}

export function describeIssues(result) {
  return JSON.stringify(result.issues);
}

/**
 * Generic closed-schema contract tests driven by the valid fixtures.
 *
 * config = {
 *   title, kind, validate(value, options) -> {ok, issues}, options (validate options),
 *   keys: expected closed key list (the frozen contract),
 *   closedPaths: expected closed-object paths in the primary fixture ('' = root),
 *   primary: fixture name used for mutations,
 *   skipPaths: paths whose subtree is free-form (not mutated),
 *   optionalKeys: { path: [keys that may be absent] },
 *   atomicPaths: ['reads[].lines', ...] arrays validated as one unit (the issue is reported at the array path),
 * }
 */
export function defineClosedSchemaTests(config) {
  const {
    title, kind, validate, options = {}, keys, closedPaths, primary, skipPaths = [], optionalKeys = {}, atomicPaths = [],
  } = config;
  const skip = new Set(skipPaths);
  const valid = loadFixtures(kind, 'valid');

  test(`${title}: frozen key list`, async () => {
    const fixtures = await valid;
    const base = fixtures.find(({ name }) => name === primary).value;
    assert.deepEqual(Object.keys(base), keys);
    assert.deepEqual(objectPaths(base, '', skip).sort(), [...closedPaths].sort(),
      'the primary valid fixture must exercise every closed object level');
  });

  test(`${title}: every valid fixture is accepted`, async () => {
    for (const { name, value } of await valid) {
      const result = validate(clone(value), options);
      assert.equal(result.ok, true, `${name}: ${describeIssues(result)}`);
    }
  });

  test(`${title}: every missing key is rejected at every closed level`, async () => {
    const base = (await valid).find(({ name }) => name === primary).value;
    for (const path of closedPaths) {
      const optional = new Set(optionalKeys[path] ?? []);
      for (const key of Object.keys(getAt(base, path))) {
        if (optional.has(key)) continue;
        const candidate = clone(base);
        deleteAt(candidate, join(path, key));
        const result = validate(candidate, options);
        const expected = issuePath(join(path, key));
        assert.equal(result.ok, false, `delete ${expected}`);
        assert.equal(
          result.issues.some((entry) => entry.code === 'missing_key' && entry.path === expected),
          true,
          `delete ${expected}: ${describeIssues(result)}`,
        );
      }
    }
  });

  test(`${title}: unknown keys are rejected at every closed level`, async () => {
    const base = (await valid).find(({ name }) => name === primary).value;
    for (const path of closedPaths) {
      const candidate = clone(base);
      setAt(candidate, join(path, 'zz_unknown'), true);
      const result = validate(candidate, options);
      const expected = issuePath(join(path, 'zz_unknown'));
      assert.equal(
        result.issues.some((entry) => entry.code === 'unknown_key' && entry.path === expected),
        true,
        `${expected}: ${describeIssues(result)}`,
      );
    }
  });

  test(`${title}: type mutations are rejected where they occur`, async () => {
    const base = (await valid).find(({ name }) => name === primary).value;
    for (const path of allPaths(base, '', skip)) {
      if (skip.has(path)) continue;
      for (const bad of [{ zz: 1 }, 4.5]) {
        const candidate = clone(base);
        setAt(candidate, path, bad);
        const result = validate(candidate, options);
        const where = issuePath(path);
        assert.equal(result.ok, false, `${where} <- ${JSON.stringify(bad)}`);
        const unit = atomicAncestor(where, atomicPaths);
        assert.equal(
          result.issues.some((entry) => under(entry.path, where) || (unit !== null && entry.path === unit)),
          true,
          `${where} <- ${JSON.stringify(bad)}: ${describeIssues(result)}`,
        );
      }
    }
  });

  test(`${title}: every invalid fixture reports its expected issue`, async () => {
    for (const { name, value: fixture } of await loadFixtures(kind, 'invalid')) {
      const result = validate(clone(fixture.value), fixture.options ?? options);
      assert.equal(result.ok, false, `${name} must be rejected`);
      for (const expected of fixture.expect) {
        assert.equal(
          result.issues.some((entry) => entry.code === expected.code && entry.path === expected.path),
          true,
          `${name}: expected ${expected.code} at ${expected.path}; got ${describeIssues(result)}`,
        );
      }
    }
  });
}

export function assertEnum(validate, base, path, values, options = {}) {
  for (const value of values) {
    const candidate = setAt(clone(base), path, value);
    const result = validate(candidate, options);
    assert.equal(result.ok, true, `${path}=${value}: ${describeIssues(result)}`);
  }
  const variants = new Set();
  for (const value of values) {
    variants.add(value.toLowerCase());
    variants.add(value.toUpperCase());
    variants.add(`${value} `);
  }
  variants.add('zz_not_a_value');
  for (const variant of variants) {
    if (values.includes(variant)) continue;
    const result = validate(setAt(clone(base), path, variant), options);
    assert.equal(result.ok, false, `${path}=${JSON.stringify(variant)} must be rejected`);
    assert.equal(
      result.issues.some((entry) => entry.path === issuePath(path)),
      true,
      `${path}=${JSON.stringify(variant)}: ${describeIssues(result)}`,
    );
  }
}

export function expectIssue(result, code, path) {
  assert.equal(result.ok, false, `expected ${code} at ${path}, but the value was accepted`);
  assert.equal(
    result.issues.some((entry) => entry.code === code && entry.path === path),
    true,
    `expected ${code} at ${path}; got ${describeIssues(result)}`,
  );
}
