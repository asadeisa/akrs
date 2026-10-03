// JSONL record codec (F4, Q1, Q3): one compact canonical line per record; every record carries `id` (ULID)
// and `hash` = sha256 over the compact canonical record with `hash` omitted. Earlier lines are never rewritten.
import { isUlid } from '../../schemas/common.js';
import { contentHash } from './hash.js';
import { canonicalizeJsonCompact } from './json.js';
import { parseStrictJson } from './strict-json.js';

function withoutHash(spec) {
  if (!spec?.keys?.includes('id') || !spec.keys.includes('hash')) {
    throw new TypeError('invalid spec: a JSONL record spec must declare id and hash');
  }
  return { ...spec, keys: spec.keys.filter((key) => key !== 'hash') };
}

function recordHash(record, spec) {
  const { hash: _hash, ...rest } = record;
  return contentHash(canonicalizeJsonCompact(rest, withoutHash(spec)));
}

export function encodeJsonlRecord(record, spec) {
  withoutHash(spec);
  if (record !== null && typeof record === 'object' && Object.hasOwn(record, 'hash')) {
    throw new TypeError('hash is computed by the codec and must not be supplied');
  }
  if (!isUlid(record?.id)) throw new TypeError('record id must be a ULID');
  return `${canonicalizeJsonCompact({ ...record, hash: recordHash(record, spec) }, spec)}\n`;
}

// `declared` is semantic, not byte-level: it means the PARSED value re-canonicalizes to the declared hash. Key order,
// whitespace, set-array order, or a raw U+2028 inside a stored string can differ from the canonical bytes and still
// verify. Byte-exact canonical form is a separate check (re-encode and compare).
export function decodeJsonl(text, specLookup) {
  const issues = [];
  const records = [];
  if (typeof text !== 'string') {
    return { ok: false, records, issues: [{ path: '$', code: 'invalid_json', message: 'input must be a string' }] };
  }
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const seen = new Set();
  lines.forEach((content, index) => {
    const line = index + 1;
    const report = (code, message) => issues.push({ path: '$', line, code, message });
    if (content.trim() === '') {
      report('blank_line', 'blank lines are not allowed');
      return;
    }
    const parsed = parseStrictJson(content);
    if (!parsed.ok) {
      for (const entry of parsed.issues) report(entry.code, `${entry.message} (${entry.path})`);
      return;
    }
    const value = parsed.value;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      report('invalid_record', 'a record must be a JSON object');
      return;
    }
    const spec = specLookup(value);
    if (spec === null || spec === undefined) {
      report('unknown_record_type', 'no spec matches this record');
      return;
    }
    try {
      canonicalizeJsonCompact(value, spec);
    } catch (error) {
      report('invalid_record', error.message);
      return;
    }
    if (!isUlid(value.id)) {
      report('invalid_record', 'record id must be a ULID');
      return;
    }
    if (seen.has(value.id)) {
      report('duplicate_record_id', `duplicate record id: ${value.id}`);
      return;
    }
    seen.add(value.id);
    const state = recordHash(value, spec) === value.hash ? 'declared' : 'unverified';
    if (state === 'unverified') report('unverified_record', 'record hash does not match its content');
    records.push({ value, line, state });
  });
  return { ok: issues.length === 0, records, issues };
}
