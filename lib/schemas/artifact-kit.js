// Shared building blocks for the closed artifact validators (P1-W01 Stream B).
// Every helper pushes `{ path, code, message }` issues and never throws on bad data; only unknown option
// values (a programming error) throw. Codes: invalid_type (wrong JSON type), invalid_value (right type,
// outside the allowed set or a cross-field rule), invalid_format (ID/ULID/hash/timestamp grammar),
// duplicate_value, invalid_order, embedded_binary, invalid_envelope; paths come from `primitives.js`.
import { compareCodePoints } from '../store/canonical/json.js';
import { SNAPSHOT_PATTERN, isId, isUlid } from './common.js';
import { inspectPath, pathOverlap } from './glob.js';
import {
  appendIndex, appendKey, validateArgv, validateIsoTimestamp, validateLineRange, validateRepoPath,
} from './primitives.js';
import { isPlainObject, issue } from './validation.js';

export { appendIndex, appendKey, compareCodePoints, isPlainObject, issue };

// Closed object check (same contract as validation.js `validateClosedObject`), but every issue path is built
// with `appendKey`, so agent-controlled key names (empty, dotted, bracketed, non-ASCII) stay unambiguous (Q24).
export function validateClosedObject(value, keys, path, issues) {
  if (!isPlainObject(value)) {
    issue(issues, path, 'invalid_type', 'must be an object');
    return false;
  }
  const allowed = new Set(keys);
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) issue(issues, appendKey(path, key), 'missing_key', `missing required key: ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issue(issues, appendKey(path, key), 'unknown_key', `unknown key: ${key}`);
  }
  return true;
}

export const READ_ENTRY_KEYS = Object.freeze(['path', 'lines', 'why']);
export const WRITE_ENTRY_KEYS = Object.freeze(['path', 'class', 'action']);
export const WRITE_ACTIONS = Object.freeze(['create', 'modify', 'delete']);
export const WRITE_CLASSES = Object.freeze(['file', 'dir', 'glob', 'ephemeral']);
export const OPERATION_KEYS = Object.freeze(['request', 'run']);
export const META_KEYS = Object.freeze(['generator', 'content_hash']);
export const MAX_TEXT_LENGTH = 100000;
export const MAX_TIMEOUT_MS = 3600000;
// `expect_json.equals` sits 4 containers deep in a contract; the strict reader allows 64 absolute levels.
export const MAX_JSON_LITERAL_DEPTH = 48;
export const MAX_PATH_SEGMENT_LENGTH = 255;
export const MAX_PATH_LENGTH = 1024;

// Q30: namespaces resolve from the discovered workflow root (default `akrs`); SOT/** is fixed (Q12).
export const DEFAULT_WORKFLOW_ROOT = 'akrs';
export const SOURCE_OF_TRUTH_GLOB = 'SOT/**';

const SEPARATORS = new RegExp("[\u0000-\u001f\u007f\u2028\u2029]");
const GENERATOR_PATTERN = /^akrs\/[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?$/;
const BASE64_RUN = /[A-Za-z0-9+/]{512,}={0,2}/;
const DATA_URI = /\bdata:[a-z][a-z0-9.+-]*\/[a-z0-9.+-]+\s*[;,]/i;

// `options.workflowRoot`: a normalized repository-relative literal directory; anything else is a programming error.
export function resolveWorkflowRoot(options) {
  const root = options?.workflowRoot === undefined ? DEFAULT_WORKFLOW_ROOT : options.workflowRoot;
  if (typeof root !== 'string' || inspectPath(root).class !== 'literal') {
    throw new TypeError(`invalid workflowRoot: ${typeof root === 'string' ? JSON.stringify(root) : String(root)}`);
  }
  return root;
}

export function resolveForm(options, forms, fallback = 'stored') {
  const form = options?.form ?? fallback;
  if (!forms.includes(form)) throw new TypeError(`unknown form: ${String(form)}`);
  return form;
}

export function hasLoneSurrogate(text) {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// Q33: NUL, data: URIs, and base64-looking runs over 512 characters never belong in artifact text.
export function embeddedBinaryReason(text) {
  if (text.includes('\u0000')) return 'contains a NUL character';
  if (DATA_URI.test(text)) return 'contains a data: URI';
  if (BASE64_RUN.test(text)) return 'contains a base64-looking run longer than 512 characters';
  return null;
}

export function checkSchemaValue(value, expected, path, issues) {
  if (value !== expected) issue(issues, path, 'invalid_value', `must be ${JSON.stringify(expected)}`);
}

export function checkLiteral(value, expected, path, issues) {
  if (value !== expected) issue(issues, path, 'invalid_value', `must be ${JSON.stringify(expected)}`);
}

export function checkEnum(value, values, path, issues) {
  if (!values.includes(value)) issue(issues, path, 'invalid_value', `must be one of: ${values.join(', ')}`);
  return values.includes(value);
}

export function checkBoolean(value, path, issues) {
  if (typeof value !== 'boolean') issue(issues, path, 'invalid_type', 'must be a boolean');
}

export function checkInteger(value, path, issues, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, nullable = false } = {}) {
  if (value === null && nullable) return true;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    issue(issues, path, 'invalid_type', nullable ? 'must be null or an integer' : 'must be an integer');
    return false;
  }
  if (Object.is(value, -0) || value < min || value > max) {
    issue(issues, path, 'invalid_value', `must be an integer from ${min} to ${max}`);
    return false;
  }
  return true;
}

export function checkText(value, path, issues, { nullable = false, allowEmpty = false, singleLine = false } = {}) {
  if (value === null && nullable) return true;
  if (typeof value !== 'string') {
    issue(issues, path, 'invalid_type', nullable ? 'must be null or a string' : 'must be a string');
    return false;
  }
  if (hasLoneSurrogate(value)) {
    issue(issues, path, 'invalid_value', 'must not contain a lone surrogate');
    return false;
  }
  const binary = embeddedBinaryReason(value);
  if (binary !== null) {
    issue(issues, path, 'embedded_binary', `must be text, not an embedded payload: ${binary}`);
    return false;
  }
  if (!allowEmpty && value.trim() === '') {
    issue(issues, path, 'invalid_value', 'must not be empty or blank');
    return false;
  }
  if (singleLine && SEPARATORS.test(value)) {
    issue(issues, path, 'invalid_value', 'must be a single line');
    return false;
  }
  if (value.length > MAX_TEXT_LENGTH) {
    issue(issues, path, 'invalid_value', `must be at most ${MAX_TEXT_LENGTH} characters`);
    return false;
  }
  return true;
}

// A short single-line label (check, step, measurement and executor-owned names).
export function checkName(value, path, issues) {
  if (typeof value !== 'string') {
    issue(issues, path, 'invalid_type', 'must be a string');
    return false;
  }
  if (!checkText(value, path, issues, { singleLine: true })) return false;
  if (value.length > 64 || value !== value.trim()) {
    issue(issues, path, 'invalid_value', 'must be at most 64 characters without surrounding whitespace');
    return false;
  }
  return true;
}

export function checkId(value, path, issues, { nullable = false } = {}) {
  if (value === null && nullable) return true;
  if (typeof value !== 'string') {
    issue(issues, path, 'invalid_type', nullable ? 'must be null or an ID string' : 'must be an ID string');
    return false;
  }
  if (!isId(value)) {
    issue(issues, path, 'invalid_format', 'must be an ID: ASCII letters and digits joined by - or ., at most 64 characters');
    return false;
  }
  return true;
}

export function checkUlid(value, path, issues, { nullable = false } = {}) {
  if (value === null && nullable) return true;
  if (!isUlid(value)) {
    issue(issues, path, 'invalid_format', 'must be a 26-character ULID');
    return false;
  }
  return true;
}

export function checkSha(value, path, issues, { nullable = false } = {}) {
  if (value === null && nullable) return true;
  if (typeof value !== 'string' || !SNAPSHOT_PATTERN.test(value)) {
    issue(issues, path, 'invalid_format', 'must be sha256:<64 lowercase hex>');
    return false;
  }
  return true;
}

export function checkTimestamp(value, path, issues, { nullable = false } = {}) {
  if (value === null && nullable) return true;
  validateIsoTimestamp(value, path, issues);
  return true;
}

export function hasHoles(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return true;
  }
  return false;
}

// Q4: paths and IDs collide case-folded. Upper-then-lower folds the non-1:1 cases (ss/sharp s, dotless i, long s)
// that a plain lower-case fold misses, so those collide conservatively.
export function foldKey(text) {
  return text.normalize('NFC').toUpperCase().toLowerCase();
}

export function checkArray(value, path, issues) {
  if (!Array.isArray(value)) {
    issue(issues, path, 'invalid_type', 'must be an array');
    return false;
  }
  if (hasHoles(value)) {
    issue(issues, path, 'invalid_type', 'must not be a sparse array');
    return false;
  }
  return true;
}

// Runs `check(entry, entryPath)` on every element of an array; returns whether the array shape was valid.
export function checkEach(value, path, issues, check) {
  if (!checkArray(value, path, issues)) return false;
  value.forEach((entry, index) => check(entry, `${path}[${index}]`));
  return true;
}

export function checkTextList(value, path, issues, { nonEmpty = false, singleLine = false } = {}) {
  if (!checkEach(value, path, issues, (entry, entryPath) => checkText(entry, entryPath, issues, { singleLine }))) return;
  if (nonEmpty && value.length === 0) issue(issues, path, 'invalid_value', 'must not be empty');
}

// Duplicate detection over an array; `keyOf(entry)` returns a string, or null when the entry has no usable key.
export function checkUnique(value, path, issues, keyOf, keyPath = '') {
  if (!Array.isArray(value)) return true;
  const seen = new Set();
  let unique = true;
  value.forEach((entry, index) => {
    const key = keyOf(entry);
    if (key === null || key === undefined) return;
    if (seen.has(key)) {
      issue(issues, `${path}[${index}]${keyPath}`, 'duplicate_value', 'duplicate entry');
      unique = false;
    }
    seen.add(key);
  });
  return unique;
}

// Stored artifacts hold sets sorted by code point order (Q6); input forms accept any order.
export function checkSortedBy(value, path, issues, keyOf) {
  if (!Array.isArray(value) || hasHoles(value)) return;
  const keys = value.map(keyOf);
  if (keys.some((key) => typeof key !== 'string')) return;
  for (let index = 1; index < keys.length; index += 1) {
    if (compareCodePoints(keys[index - 1], keys[index]) > 0) {
      issue(issues, path, 'invalid_order', 'set entries must be sorted by code point order in the stored form');
      return;
    }
  }
}

// A set: unique entries, and sorted when `sorted` (the stored form).
// `fold`: uniqueness is case-folded (paths, IDs); ordering always uses the raw code point order.
export function checkSet(value, path, issues, { sorted, keyOf = (entry) => entry, keyPath = '', fold = false }) {
  if (!Array.isArray(value) || hasHoles(value)) return;
  const unique = checkUnique(value, path, issues, (entry) => {
    const key = keyOf(entry);
    if (typeof key !== 'string') return null;
    return fold ? foldKey(key) : key;
  }, keyPath);
  if (sorted && unique) checkSortedBy(value, path, issues, keyOf);
}

export function checkIdSet(value, path, issues, { sorted, nonEmpty = false, exclude = null }) {
  const ok = checkEach(value, path, issues, (entry, entryPath) => {
    if (checkId(entry, entryPath, issues) && exclude !== null && entry === exclude) {
      issue(issues, entryPath, 'invalid_value', 'must not reference itself');
    }
  });
  if (!ok) return;
  if (nonEmpty && value.length === 0) issue(issues, path, 'invalid_value', 'must not be empty');
  checkSet(value, path, issues, { sorted, fold: true });
}

export function validateReadEntry(value, path, issues) {
  if (!validateClosedObject(value, READ_ENTRY_KEYS, path, issues)) return;
  if (Object.hasOwn(value, 'path')) validateRepoPath(value.path, `${path}.path`, issues, { allow: ['file', 'dir', 'ephemeral'] });
  if (Object.hasOwn(value, 'lines')) {
    validateLineRange(value.lines, `${path}.lines`, issues);
    if (value.lines !== null && typeof value.path === 'string' && inspectPath(value.path).class === 'glob') {
      issue(issues, `${path}.lines`, 'invalid_value', 'a glob read has no line window; lines must be null');
    }
  }
  if (Object.hasOwn(value, 'why')) checkText(value.why, `${path}.why`, issues, { nullable: true });
}

export function readEntryKey(entry) {
  if (!isPlainObject(entry) || typeof entry.path !== 'string') return null;
  const window = Array.isArray(entry.lines) && entry.lines.every((line) => Number.isSafeInteger(line)) ? entry.lines.join('-') : 'all';
  return `${foldKey(entry.path)}\u0000${window}`;
}

export function validateReadList(value, path, issues) {
  if (!checkEach(value, path, issues, (entry, entryPath) => validateReadEntry(entry, entryPath, issues))) return;
  checkUnique(value, path, issues, readEntryKey);
}

export function validateWriteEntry(value, path, issues) {
  if (!validateClosedObject(value, WRITE_ENTRY_KEYS, path, issues)) return;
  const classOk = !Object.hasOwn(value, 'class') || checkEnum(value.class, WRITE_CLASSES, `${path}.class`, issues);
  if (Object.hasOwn(value, 'action')) checkEnum(value.action, WRITE_ACTIONS, `${path}.action`, issues);
  if (Object.hasOwn(value, 'path')) {
    validateRepoPath(value.path, `${path}.path`, issues, classOk && Object.hasOwn(value, 'class') ? { class: value.class } : {});
  }
}

export function writePathKey(entry) {
  return isPlainObject(entry) && typeof entry.path === 'string' ? foldKey(entry.path) : null;
}

export function validateWriteList(value, path, issues, { sorted }) {
  if (!checkEach(value, path, issues, (entry, entryPath) => validateWriteEntry(entry, entryPath, issues))) return;
  const unique = checkUnique(value, path, issues, writePathKey, '.path');
  if (sorted && unique) checkSortedBy(value, path, issues, (entry) => (isPlainObject(entry) ? entry.path : null));
}

export function validateOperationRef(value, path, issues) {
  if (!validateClosedObject(value, OPERATION_KEYS, path, issues)) return;
  if (Object.hasOwn(value, 'request')) checkUlid(value.request, `${path}.request`, issues);
  if (Object.hasOwn(value, 'run')) checkUlid(value.run, `${path}.run`, issues);
}

export function validateMeta(value, path, issues) {
  if (!validateClosedObject(value, META_KEYS, path, issues)) return;
  if (Object.hasOwn(value, 'generator') && (typeof value.generator !== 'string' || !GENERATOR_PATTERN.test(value.generator))) {
    issue(issues, `${path}.generator`, 'invalid_format', 'must look like akrs/<semver>');
  }
  if (Object.hasOwn(value, 'content_hash')) checkSha(value.content_hash, `${path}.content_hash`, issues);
}

// Envelope entries (Q12) must be provably disjoint from the control namespaces.
export function validateEnvelopeEntry(value, path, issues, workflowRoot = DEFAULT_WORKFLOW_ROOT) {
  const before = issues.length;
  validateRepoPath(value, path, issues);
  if (issues.length !== before) return;
  for (const excluded of [`${workflowRoot}/**`, SOURCE_OF_TRUTH_GLOB]) {
    if (pathOverlap(value, excluded) !== 'disjoint') {
      issue(issues, path, 'invalid_envelope', `must be provably disjoint from ${excluded}`);
      return;
    }
  }
}

export function validateEnvelopeList(value, path, issues, { sorted, workflowRoot = DEFAULT_WORKFLOW_ROOT }) {
  if (!checkEach(value, path, issues, (entry, entryPath) => validateEnvelopeEntry(entry, entryPath, issues, workflowRoot))) return;
  checkSet(value, path, issues, { sorted, fold: true });
}

// A path list whose entries are any valid path or glob (e.g. `forbidden`).
export function validatePathSet(value, path, issues, { sorted }) {
  if (!checkEach(value, path, issues, (entry, entryPath) => validateRepoPath(entry, entryPath, issues))) return;
  checkSet(value, path, issues, { sorted, fold: true });
}

// argv per the shared primitive, plus lone surrogates (which the canonical writer cannot encode).
export function checkArgv(value, path, issues) {
  if (Array.isArray(value) && hasHoles(value)) {
    issue(issues, path, 'invalid_argv', 'must not be a sparse array');
    return;
  }
  validateArgv(value, path, issues);
  if (!Array.isArray(value)) return;
  value.forEach((entry, index) => {
    if (typeof entry === 'string' && entry !== '' && hasLoneSurrogate(entry)) {
      issue(issues, `${path}[${index}]`, 'invalid_argv', 'must not contain a lone surrogate');
    }
  });
}

export function validateTimeout(value, path, issues) {
  return checkInteger(value, path, issues, { min: 1, max: MAX_TIMEOUT_MS });
}

// An object whose keys are all optional (but closed): reports unknown keys and a wrong container type.
export function validateOptionalKeys(value, keys, path, issues) {
  if (!isPlainObject(value)) {
    issue(issues, path, 'invalid_type', 'must be an object');
    return false;
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issue(issues, appendKey(path, key), 'unknown_key', `unknown key: ${key}`);
  }
  return true;
}

// A value that must be canonical JSON (integers only), e.g. `http.expect_json.equals`.
export function validateJsonLiteral(value, path, issues, depth = 0) {
  if (depth > MAX_JSON_LITERAL_DEPTH) {
    issue(issues, path, 'invalid_value', 'is nested too deeply');
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) issue(issues, path, 'invalid_value', 'must not contain a lone surrogate');
    else if (value.includes('\u0000')) issue(issues, path, 'embedded_binary', 'must not contain a NUL character');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) issue(issues, path, 'invalid_type', 'numbers must be integers');
    return;
  }
  if (Array.isArray(value)) {
    if (hasHoles(value)) {
      issue(issues, path, 'invalid_type', 'must not be a sparse array');
      return;
    }
    value.forEach((entry, index) => validateJsonLiteral(entry, appendIndex(path, index), issues, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      // index-like and prototype keys cannot round-trip through the canonical writer and the strict reader
      if (/^(?:0|[1-9][0-9]*)$/.test(key) || key === '__proto__' || key === 'constructor') {
        issue(issues, appendKey(path, key), 'invalid_value', 'object keys must not be integer-like or prototype names');
      }
      if (hasLoneSurrogate(key)) issue(issues, appendKey(path, key), 'invalid_value', 'object keys must not contain a lone surrogate');
      if (key.includes('\u0000')) issue(issues, appendKey(path, key), 'embedded_binary', 'object keys must not contain a NUL character');
      validateJsonLiteral(entry, appendKey(path, key), issues, depth + 1);
    }
    return;
  }
  issue(issues, path, 'invalid_type', 'must be a JSON value');
}

export function present(value, key) {
  return isPlainObject(value) && Object.hasOwn(value, key);
}

export function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
