// Strict JSON reader (F4, Q26): hand-written so duplicate keys, prototype keys, lone surrogates, and
// non-integer numbers are rejected instead of silently accepted by JSON.parse.
import { appendIndex, appendKey } from '../../schemas/primitives.js';

export const MAX_INPUT_BYTES = 1024 * 1024;
export const MAX_DEPTH = 64;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor']);
const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

class SyntaxFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

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

export function parseStrictJson(text) {
  const issues = [];
  const report = (path, code, message) => issues.push({ path, code, message });
  const fail = (code, message) => ({ ok: false, value: undefined, issues: [{ path: '$', code, message }] });
  if (typeof text !== 'string') return fail('invalid_json', 'input must be a string');
  if (Buffer.byteLength(text) > MAX_INPUT_BYTES) return fail('too_large', `input exceeds ${MAX_INPUT_BYTES} bytes`);
  if (text.startsWith('\uFEFF')) return fail('bom', 'a byte order mark is not allowed');
  if (text.includes('\u0000')) return fail('nul_byte', 'NUL characters are not allowed');

  let position = 0;

  const syntax = (message) => {
    throw new SyntaxFailure('invalid_json', `${message} at offset ${position}`);
  };

  function skipWhitespace() {
    while (position < text.length) {
      const character = text[position];
      if (character === ' ' || character === '\t' || character === '\n' || character === '\r') position += 1;
      else break;
    }
  }

  function parseString(path) {
    position += 1;
    let output = '';
    for (;;) {
      if (position >= text.length) syntax('unterminated string');
      const character = text[position];
      const code = character.charCodeAt(0);
      if (character === '"') {
        position += 1;
        break;
      }
      if (code < 0x20) syntax('raw control character in string');
      if (character !== '\\') {
        output += character;
        position += 1;
        continue;
      }
      const escape = text[position + 1];
      if (escape === 'u') {
        const digits = text.slice(position + 2, position + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) syntax('invalid unicode escape');
        output += String.fromCharCode(Number.parseInt(digits, 16));
        position += 6;
      } else if (Object.hasOwn(ESCAPES, escape)) {
        output += ESCAPES[escape];
        position += 2;
      } else {
        syntax('invalid escape');
      }
    }
    if (hasLoneSurrogate(output)) report(path, 'lone_surrogate', 'string contains a lone surrogate');
    return output;
  }

  function parseNumber(path) {
    const match = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(position));
    if (!match) syntax('invalid number');
    position += match[0].length;
    const next = text[position];
    if (next !== undefined && /[0-9.eE+\-a-zA-Z_]/.test(next)) syntax('invalid number');
    const value = Number(match[0]);
    if (match[1] !== undefined || match[2] !== undefined || Object.is(value, -0) || !Number.isSafeInteger(value)) {
      report(path, 'invalid_number', 'only safe integers without fraction, exponent, or -0 are allowed');
      return null;
    }
    return value;
  }

  function parseValue(path, depth) {
    skipWhitespace();
    const character = text[position];
    if (character === '{') return parseObject(path, depth + 1);
    if (character === '[') return parseArray(path, depth + 1);
    if (character === '"') return parseString(path);
    if (character === '-' || (character >= '0' && character <= '9')) return parseNumber(path);
    for (const [word, value] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, position)) {
        position += word.length;
        return value;
      }
    }
    return syntax('unexpected token');
  }

  function parseArray(path, depth) {
    if (depth > MAX_DEPTH) throw new SyntaxFailure('too_deep', `nesting deeper than ${MAX_DEPTH}`);
    position += 1;
    const values = [];
    skipWhitespace();
    if (text[position] === ']') {
      position += 1;
      return values;
    }
    for (;;) {
      values.push(parseValue(appendIndex(path, values.length), depth));
      skipWhitespace();
      if (text[position] === ',') {
        position += 1;
      } else if (text[position] === ']') {
        position += 1;
        return values;
      } else {
        syntax('expected , or ]');
      }
    }
  }

  function parseObject(path, depth) {
    if (depth > MAX_DEPTH) throw new SyntaxFailure('too_deep', `nesting deeper than ${MAX_DEPTH}`);
    position += 1;
    const value = {};
    const seen = new Set();
    skipWhitespace();
    if (text[position] === '}') {
      position += 1;
      return value;
    }
    for (;;) {
      skipWhitespace();
      if (text[position] !== '"') syntax('expected a string key');
      const key = parseString(path);
      const keyPath = appendKey(path, key);
      skipWhitespace();
      if (text[position] !== ':') syntax('expected :');
      position += 1;
      const entry = parseValue(keyPath, depth);
      if (FORBIDDEN_KEYS.has(key)) {
        report(keyPath, 'forbidden_key', `key is not allowed: ${key}`);
      } else if (seen.has(key)) {
        report(keyPath, 'duplicate_key', `duplicate key: ${key}`);
      } else {
        seen.add(key);
        value[key] = entry;
      }
      skipWhitespace();
      if (text[position] === ',') {
        position += 1;
      } else if (text[position] === '}') {
        position += 1;
        return value;
      } else {
        syntax('expected , or }');
      }
    }
  }

  let value;
  try {
    value = parseValue('$', 0);
    skipWhitespace();
    if (position < text.length) syntax('unexpected trailing content');
  } catch (error) {
    if (!(error instanceof SyntaxFailure)) throw error;
    return fail(error.code, error.message);
  }
  if (issues.length > 0) return { ok: false, value: undefined, issues };
  return { ok: true, value, issues };
}
