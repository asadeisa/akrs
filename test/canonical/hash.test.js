import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  canonicalizeJson,
  contentHash,
  storedSpec,
  verifyMeta,
  withMeta,
} from '../../lib/store/canonical/index.js';
import { SAMPLE_SPEC } from './support.js';

const SNAPSHOT = /^sha256:[0-9a-f]{64}$/;

function artifact() {
  return {
    schema: 'akrs.sample/v1',
    id: 'R-9',
    deps: ['R-2', 'R-1'],
    reads: [{ path: 'docs/a.md', lines: [1, 2], why: null }],
    writes: [{ path: 'src/a.js', class: 'file', action: 'create' }],
    checks: ['one', 'two'],
    nested: { a: 1, b: true },
    note: 'hello \u{1F600}',
  };
}

test('F4 contentHash is sha256 of the UTF-8 bytes in the sha256:<hex> form', () => {
  assert.equal(contentHash('abc'), 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(contentHash(''), 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(contentHash('é'), `sha256:${createHash('sha256').update(Buffer.from('é', 'utf8')).digest('hex')}`);
  assert.match(contentHash('x'), SNAPSHOT);
  assert.throws(() => contentHash(5), TypeError);
  assert.throws(() => contentHash(Buffer.from('x')), TypeError);
});

test('F4 storedSpec appends the CLI-owned meta key last and refuses a declared meta', () => {
  const stored = storedSpec(SAMPLE_SPEC);
  assert.deepEqual(stored.keys, [...SAMPLE_SPEC.keys, 'meta']);
  assert.deepEqual(stored.objects.meta.keys, ['generator', 'content_hash']);
  assert.deepEqual(SAMPLE_SPEC.keys.includes('meta'), false);
  assert.throws(() => storedSpec({ ...SAMPLE_SPEC, keys: [...SAMPLE_SPEC.keys, 'meta'] }), TypeError);
});

test('F4 withMeta hashes the canonical bytes with meta.content_hash omitted', () => {
  const stored = withMeta(artifact(), { schema: 'akrs.sample/v1', generator: 'akrs/2.0.0', spec: SAMPLE_SPEC });
  assert.deepEqual(Object.keys(stored.meta), ['generator', 'content_hash']);
  assert.equal(stored.meta.generator, 'akrs/2.0.0');
  assert.match(stored.meta.content_hash, SNAPSHOT);

  const baseSpec = storedSpec(SAMPLE_SPEC);
  baseSpec.objects.meta = { keys: ['generator'], arrays: {}, objects: {} };
  const base = canonicalizeJson({ ...artifact(), meta: { generator: 'akrs/2.0.0' } }, baseSpec);
  assert.equal(stored.meta.content_hash, contentHash(base));
  const bytes = canonicalizeJson(stored, storedSpec(SAMPLE_SPEC));
  assert.equal(bytes.endsWith('  }\n}\n'), true);
  assert.equal(artifact().meta, undefined);
});

test('F4 withMeta is closed: schema must match, generator must be text, meta must not exist yet', () => {
  const options = { schema: 'akrs.sample/v1', generator: 'akrs/2.0.0', spec: SAMPLE_SPEC };
  assert.throws(() => withMeta(artifact(), { ...options, schema: 'akrs.sample/v2' }), /schema/);
  assert.throws(() => withMeta(artifact(), { ...options, generator: '' }), /generator/);
  assert.throws(() => withMeta(artifact(), { ...options, generator: 5 }), /generator/);
  assert.throws(() => withMeta(artifact(), { ...options, generator: 'a\nb' }), /generator/);
  assert.throws(() => withMeta({ ...artifact(), meta: { generator: 'x', content_hash: contentHash('') } }, options), /meta/);
  assert.throws(() => withMeta({ ...artifact(), extra: 1 }, options), /unknown key/);
});

test('F4 verifyMeta returns declared for untouched artifacts and unverified for every mismatch', () => {
  const options = { schema: 'akrs.sample/v1', generator: 'akrs/2.0.0', spec: SAMPLE_SPEC };
  const stored = withMeta(artifact(), options);
  assert.equal(verifyMeta(stored, { spec: SAMPLE_SPEC }), 'declared');

  const copy = () => structuredClone(stored);
  const tampered = [
    (value) => { value.note = 'tampered'; },
    (value) => { value.id = 'R-10'; },
    (value) => { value.reads[0].lines = [1, 3]; },
    (value) => { value.checks.reverse(); },
    (value) => { value.meta.content_hash = contentHash('other'); },
    (value) => { value.meta.generator = 'akrs/other'; },
    (value) => { delete value.meta; },
    (value) => { value.meta = null; },
    (value) => { value.meta.extra = 1; },
    (value) => { value.meta.content_hash = 'sha256:ZZ'; },
    (value) => { value.unknown = 1; },
    (value) => { delete value.note; },
    (value) => { value.note = 1.5; },
  ];
  for (const mutate of tampered) {
    const value = copy();
    mutate(value);
    assert.equal(verifyMeta(value, { spec: SAMPLE_SPEC }), 'unverified', mutate.toString());
  }
  assert.equal(verifyMeta(null, { spec: SAMPLE_SPEC }), 'unverified');
  assert.equal(verifyMeta('x', { spec: SAMPLE_SPEC }), 'unverified');
});

test('F4 verification is independent of key insertion order and set-array order', () => {
  const options = { schema: 'akrs.sample/v1', generator: 'akrs/2.0.0', spec: SAMPLE_SPEC };
  const stored = withMeta(artifact(), options);
  const reordered = Object.fromEntries(Object.entries(stored).reverse());
  reordered.deps = [...stored.deps].reverse();
  assert.equal(verifyMeta(reordered, { spec: SAMPLE_SPEC }), 'declared');
});
