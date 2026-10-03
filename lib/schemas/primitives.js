// Shared artifact primitives (F4, F11, F16, Q24): validators push `{ path, code, message }` issues.
import { SNAPSHOT_PATTERN, compareStrings, isTimestamp } from './common.js';
import { PATH_CLASSES, inspectPath } from './glob.js';
import { issue } from './validation.js';

// Relative to the workflow root (Q30); excluded from snapshots and the git audit.
export const EXCLUDED_NAMESPACES = Object.freeze(['drafts', '.cache', '.ops']);

// Two folds are compared so that non-1:1 case folds (long s, dotless i, sharp s, ...) count as colliding.
const foldPlain = (text) => text.normalize('NFC').toLowerCase();
const foldWide = (text) => foldPlain(text).toUpperCase().toLowerCase();

export function isExcludedNamespace(path, { workflowRelative = 'akrs' } = {}) {
  if (typeof path !== 'string' || typeof workflowRelative !== 'string') return false;
  return [foldPlain, foldWide].some((fold) => {
    const folded = fold(path);
    return EXCLUDED_NAMESPACES.some((namespace) => {
      const prefix = `${fold(workflowRelative)}/${namespace}`;
      return folded === prefix || folded.startsWith(`${prefix}/`);
    });
  });
}

export function validateRepoPath(value, path, issues, { allow = PATH_CLASSES, class: declared } = {}) {
  const permitted = Array.isArray(allow) ? allow : PATH_CLASSES;
  const inspected = inspectPath(value);
  if (inspected.class === 'invalid') {
    issue(issues, path, inspected.reason, inspected.message);
    return;
  }
  const isGlob = inspected.class === 'glob';
  if (declared !== undefined) {
    if (!PATH_CLASSES.includes(declared) || !permitted.includes(declared)) {
      issue(issues, path, 'class_mismatch', `path class is not allowed here: ${String(declared)}`);
    } else if (declared === 'glob' && !isGlob) {
      issue(issues, path, 'class_mismatch', 'a glob path needs a * or ? metacharacter');
    } else if (declared !== 'glob' && isGlob) {
      issue(issues, path, 'class_mismatch', `a ${declared} path cannot contain glob metacharacters`);
    }
    return;
  }
  const fits = isGlob ? permitted.includes('glob') : permitted.some((entry) => entry !== 'glob');
  if (!fits) issue(issues, path, 'class_mismatch', `${isGlob ? 'glob' : 'literal'} paths are not allowed here`);
}

export function validateLineRange(value, path, issues) {
  if (value === null) return;
  if (!Array.isArray(value)) {
    issue(issues, path, 'invalid_type', 'must be null or [start, end]');
    return;
  }
  const valid = value.length === 2
    && value.every((entry) => Number.isSafeInteger(entry) && entry >= 1)
    && value[0] <= value[1];
  if (!valid) issue(issues, path, 'invalid_line_range', 'must be [start, end] with 1 <= start <= end');
}

export function validateArgv(value, path, issues) {
  if (!Array.isArray(value) || value.length === 0) {
    issue(issues, path, 'invalid_argv', 'must be a non-empty array of strings');
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry === '' || entry.includes('\u0000') || !entry.isWellFormed()) {
      issue(issues, `${path}[${index}]`, 'invalid_argv', 'must be a non-empty well-formed string without NUL');
    }
  });
}

export function validateIsoTimestamp(value, path, issues) {
  if (!isTimestamp(value)) issue(issues, path, 'invalid_format', 'must be an RFC 3339 UTC timestamp with milliseconds');
}

export function validateSha256(value, path, issues) {
  if (typeof value !== 'string' || !SNAPSHOT_PATTERN.test(value)) {
    issue(issues, path, 'invalid_format', 'must be sha256:<64 lowercase hex>');
  }
}

export function validateIntegerRange(value, path, issues, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    issue(issues, path, 'invalid_value', `must be an integer from ${min} to ${max}`);
  }
}

// Issue paths are unambiguous (Q24): `$` is the root, identifier keys are written `.key`, every other key
// (empty, dotted, bracketed, non-ASCII, ...) is written `[<JSON string>]`, array indices are `[n]`.
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g');

export function appendKey(path, key) {
  if (typeof path !== 'string' || typeof key !== 'string') throw new TypeError('appendKey needs a string path and key');
  if (PLAIN_KEY.test(key)) return `${path}.${key}`;
  const quoted = JSON.stringify(key).replace(SEPARATORS, (char) => `\\u${char.charCodeAt(0).toString(16)}`);
  return `${path}[${quoted}]`;
}

export function appendIndex(path, index) {
  if (typeof path !== 'string' || !Number.isSafeInteger(index) || index < 0) {
    throw new TypeError('appendIndex needs a string path and a non-negative integer index');
  }
  return `${path}[${index}]`;
}

const escapePointerToken = (token) => token.replaceAll('~', '~0').replaceAll('/', '~1');

export function toJsonPointer(issuePath) {
  if (typeof issuePath !== 'string' || !issuePath.startsWith('$')) {
    throw new TypeError('issue paths must start with $');
  }
  const tokens = [];
  let position = 1;
  while (position < issuePath.length) {
    const rest = issuePath.slice(position);
    let match;
    if (rest[0] === '.') {
      match = /^\.([^.[\]"]+)/.exec(rest);
      if (!match) throw new TypeError(`invalid issue path: ${issuePath}`);
      tokens.push(match[1]);
    } else if ((match = /^\[([0-9]+)\]/.exec(rest))) {
      tokens.push(match[1]);
    } else if ((match = /^\[("(?:[^"\\]|\\.)*")\]/.exec(rest))) {
      try {
        tokens.push(JSON.parse(match[1]));
      } catch {
        throw new TypeError(`invalid issue path: ${issuePath}`);
      }
    } else {
      throw new TypeError(`invalid issue path: ${issuePath}`);
    }
    position += match[0].length;
  }
  return tokens.map((token) => `/${escapePointerToken(token)}`).join('');
}

export function issuesToFindingDetail(issues) {
  const items = issues.map(({ path, code, message }) => ({ pointer: toJsonPointer(path), code, message }));
  items.sort((left, right) => compareStrings(left.pointer, right.pointer)
    || compareStrings(left.code, right.code)
    || compareStrings(left.message, right.message));
  return { issues: items };
}
