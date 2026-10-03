// Content hash and CLI-owned `meta` (F4, Q1, Q28): meta = { generator, content_hash } where the hash is
// sha256 over the canonical bytes with `meta.content_hash` omitted. A mismatch is `unverified`, never accepted.
import { createHash } from 'node:crypto';
import { SNAPSHOT_PATTERN } from '../../schemas/common.js';
import { canonicalizeJson } from './json.js';

const META_SPEC = Object.freeze({ keys: ['generator', 'content_hash'], arrays: {}, objects: {} });
const META_BASE_SPEC = Object.freeze({ keys: ['generator'], arrays: {}, objects: {} });

export function contentHash(text) {
  if (typeof text !== 'string') throw new TypeError('contentHash requires a string');
  return `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`;
}

export function storedSpec(spec) {
  if (spec?.keys?.includes('meta')) throw new TypeError('specs must not declare the CLI-owned meta key');
  return { ...spec, keys: [...spec.keys, 'meta'], objects: { ...spec.objects, meta: META_SPEC } };
}

function checkGenerator(generator) {
  if (typeof generator !== 'string' || generator === '' || /[\u0000-\u001f\u007f]/.test(generator)) {
    throw new TypeError('generator must be a non-empty single-line string');
  }
}

function hashBase(value, spec, generator) {
  const stored = storedSpec(spec);
  const baseSpec = { ...stored, objects: { ...stored.objects, meta: META_BASE_SPEC } };
  return contentHash(canonicalizeJson({ ...value, meta: { generator } }, baseSpec));
}

export function withMeta(value, { schema, generator, spec }) {
  if (value?.schema !== schema) throw new TypeError(`artifact schema must be ${String(schema)}`);
  if (Object.hasOwn(value, 'meta')) throw new TypeError('artifact already has meta');
  checkGenerator(generator);
  return { ...value, meta: { generator, content_hash: hashBase(value, spec, generator) } };
}

// `declared` is semantic, not byte-level: it means the PARSED value re-canonicalizes to the declared hash. Key order,
// whitespace, set-array order, or a raw U+2028 inside a stored string can differ from the canonical bytes and still
// verify. Byte-exact canonical form is a separate check (re-encode and compare).
export function verifyMeta(value, { spec }) {
  try {
    const meta = value?.meta;
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return 'unverified';
    if (Object.keys(meta).sort().join() !== 'content_hash,generator') return 'unverified';
    checkGenerator(meta.generator);
    if (typeof meta.content_hash !== 'string' || !SNAPSHOT_PATTERN.test(meta.content_hash)) return 'unverified';
    const { meta: _meta, ...rest } = value;
    return hashBase(rest, spec, meta.generator) === meta.content_hash ? 'declared' : 'unverified';
  } catch {
    return 'unverified';
  }
}
