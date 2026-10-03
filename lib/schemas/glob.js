// Path classes and the restricted glob grammar (F11, Q10-Q12).
//
// Grammar: a path of `/`-separated segments. Inside a segment `*` matches zero or more characters and `?`
// exactly one; a segment that is exactly `**` matches zero or more whole segments. `[ ] { }`, `**` inside a
// larger segment, and every unsafe literal form (absolute, traversal, NUL, ADS, backslash, ...) are rejected.
// Comparison is NFC + case-folded; a pattern containing a character whose case fold is not a 1:1 code point
// map (e.g. dotted/dotless i, long s, sharp s, Kelvin sign, final sigma) is `unknown_potential`, never `disjoint`.
// `pathOverlap` decides intersection exactly for valid patterns and answers
// `unknown_potential` for anything outside the grammar or over the size budget; a `dir` entry `d` must be
// passed as `d/**` by callers that want containment.
import { validateRestrictedPath } from '../store/path-service.js';
import { issue } from './validation.js';

export const PATH_CLASSES = Object.freeze(['file', 'dir', 'glob', 'ephemeral']);

const MAX_PATTERN_LENGTH = 512;
const MAX_SEGMENT_LENGTH = 255; // UTF-16 units, like the common file system name limit
const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENTS = 64;

function hasLoneSurrogate(text) {
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

// A fold is 1:1 when lower- and upper-casing the code point each yield one code point and round-trip.
function isTrivialFold(character) {
  if (character.codePointAt(0) < 0x80) return true;
  const lower = character.toLowerCase();
  const upper = character.toUpperCase();
  return Array.from(lower).length === 1 && Array.from(upper).length === 1
    && upper.toLowerCase() === lower && lower.toUpperCase() === upper;
}

export function hasNonTrivialCaseFold(text) {
  if (typeof text !== 'string') return false;
  for (const character of text) {
    if (!isTrivialFold(character)) return true;
  }
  return false;
}

// Names Windows treats as devices in any directory, with or without an extension (CON, CON.txt, com1.tar.gz).
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function windowsHostileSegment(segment) {
  if (segment === '**') return null;
  if (/[. ]$/.test(segment)) return 'segments ending in a dot or space are forbidden';
  if (!/[*?]/.test(segment) && DEVICE_NAME.test(segment.split('.')[0])) return 'Windows device names are forbidden';
  return null;
}

// Returns { class: 'glob' | 'literal' } or { class: 'invalid', reason, message }.
export function inspectPath(value) {
  const invalid = (reason, message) => ({ class: 'invalid', reason, message });
  if (typeof value !== 'string' || value === '') return invalid('invalid_path', 'path must be a non-empty string');
  if (/[\u2028\u2029]/.test(value)) return invalid('invalid_path', 'line and paragraph separators are forbidden');
  if (hasLoneSurrogate(value)) return invalid('invalid_path', 'lone surrogates are forbidden');
  if (value.length > MAX_PATH_LENGTH) return invalid('invalid_path', `paths are limited to ${MAX_PATH_LENGTH} characters`);
  const segments = value.split('/');
  if (segments.some((segment) => segment.length > MAX_SEGMENT_LENGTH)) {
    return invalid('invalid_path', `path segments are limited to ${MAX_SEGMENT_LENGTH} characters`);
  }
  const neutral = segments
    .map((segment) => (segment === '**' ? 'a' : segment.replace(/[*?[\]{}]/g, 'a')))
    .join('/');
  try {
    validateRestrictedPath(neutral);
  } catch (error) {
    return invalid('invalid_path', error.message.replace(/^unsafe path ".*?": /, ''));
  }
  for (const segment of segments) {
    const hostile = windowsHostileSegment(segment);
    if (hostile !== null) return invalid('invalid_path', hostile);
  }
  if (value !== value.normalize('NFC')) return invalid('not_nfc', 'path must be Unicode NFC');
  if (/[[\]{}]/.test(value)) return invalid('invalid_glob', 'only * ? and whole-segment ** are supported');
  if (segments.some((segment) => segment !== '**' && segment.includes('**'))) {
    return invalid('invalid_glob', '** must be a whole path segment');
  }
  return { class: /[*?]/.test(value) ? 'glob' : 'literal' };
}

export function classifyPath(value) {
  const inspected = inspectPath(value);
  return inspected.class === 'invalid' ? { class: 'invalid', reason: inspected.reason } : { class: inspected.class };
}

export function validateGlobPattern(value, path, issues) {
  const inspected = inspectPath(value);
  if (inspected.class === 'invalid') issue(issues, path, inspected.reason, inspected.message);
}

// ---- exact overlap -------------------------------------------------------------------------------------
function tokenize(segment) {
  return Array.from(segment).map((character) => {
    if (character === '*') return { type: 'star' };
    if (character === '?') return { type: 'any' };
    return { type: 'lit', character };
  });
}

function parsePattern(value) {
  if (typeof value !== 'string' || value.length > MAX_PATTERN_LENGTH) return null;
  if (inspectPath(value).class === 'invalid' || hasNonTrivialCaseFold(value)) return null;
  const segments = value.toLowerCase().split('/');
  if (segments.length > MAX_SEGMENTS) return null;
  return segments.map((segment) => (segment === '**' ? { globstar: true } : { globstar: false, key: segment, tokens: tokenize(segment) }));
}

const FREE = ['dot', 'other'];
const intersectionCache = new Map();

// Is there a valid path segment (non-empty, not "." or "..") matched by both token lists?
function segmentsIntersect(left, right) {
  const cacheKey = `${left.key}\u0000${right.key}`;
  if (intersectionCache.has(cacheKey)) return intersectionCache.get(cacheKey);
  const first = left.tokens;
  const second = right.tokens;
  const seen = new Set(['0,0,0,1']);
  const stack = [[0, 0, 0, true]];
  const visit = (i, j, length, dots, characters) => {
    for (const character of characters) {
      const nextLength = Math.min(length + 1, 3);
      const nextDots = nextLength >= 3 ? false : dots && character === 'dot';
      const key = `${i},${j},${nextLength},${nextDots ? 1 : 0}`;
      if (!seen.has(key)) {
        seen.add(key);
        stack.push([i, j, nextLength, nextDots]);
      }
    }
  };
  const skip = (i, j, length, dots) => {
    const key = `${i},${j},${length},${dots ? 1 : 0}`;
    if (!seen.has(key)) {
      seen.add(key);
      stack.push([i, j, length, dots]);
    }
  };
  const charactersOf = (token) => (token.type === 'lit' ? [token.character === '.' ? 'dot' : 'other'] : FREE);
  let found = false;
  while (stack.length > 0 && !found) {
    const [i, j, length, dots] = stack.pop();
    if (i === first.length && j === second.length) {
      if (length >= 1 && !(dots && length <= 2)) found = true;
      continue;
    }
    const a = first[i];
    const b = second[j];
    if (a?.type === 'star') skip(i + 1, j, length, dots);
    if (b?.type === 'star') skip(i, j + 1, length, dots);
    if (a === undefined || b === undefined) continue;
    if (a.type === 'star' && b.type === 'star') visit(i, j, length, dots, FREE);
    else if (a.type === 'star') visit(i, j + 1, length, dots, charactersOf(b));
    else if (b.type === 'star') visit(i + 1, j, length, dots, charactersOf(a));
    else if (a.type === 'lit' && b.type === 'lit') {
      if (a.character === b.character) visit(i + 1, j + 1, length, dots, charactersOf(a));
    } else {
      visit(i + 1, j + 1, length, dots, a.type === 'lit' ? charactersOf(a) : b.type === 'lit' ? charactersOf(b) : FREE);
    }
  }
  intersectionCache.set(cacheKey, found);
  return found;
}

function sequencesIntersect(left, right) {
  const seen = new Set(['0,0']);
  const stack = [[0, 0]];
  const push = (i, j) => {
    const key = `${i},${j}`;
    if (!seen.has(key)) {
      seen.add(key);
      stack.push([i, j]);
    }
  };
  while (stack.length > 0) {
    const [i, j] = stack.pop();
    if (i === left.length && j === right.length) return true;
    const a = left[i];
    const b = right[j];
    if (a?.globstar) push(i + 1, j);
    if (b?.globstar) push(i, j + 1);
    if (a === undefined || b === undefined) continue;
    if (a.globstar && !b.globstar) push(i, j + 1);
    else if (b.globstar && !a.globstar) push(i + 1, j);
    else if (!a.globstar && !b.globstar && segmentsIntersect(a, b)) push(i + 1, j + 1);
  }
  return false;
}

export function pathOverlap(left, right) {
  const first = parsePattern(left);
  const second = parsePattern(right);
  if (first === null || second === null) return 'unknown_potential';
  return sequencesIntersect(first, second) ? 'overlap' : 'disjoint';
}

export function isProvablyDisjoint(left, right) {
  return pathOverlap(left, right) === 'disjoint';
}
