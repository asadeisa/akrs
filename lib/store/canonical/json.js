// Canonical JSON writer (F4, Q3, Q6): schema-declared key order, 2-space indent, LF, one final newline,
// integers only, JSON.stringify escaping plus escaped U+2028/U+2029. Authored array order is preserved;
// only arrays declared `set` are sorted (code point order) and must be unique.
//
// spec = { keys: [...ordered], arrays: { <key>: { kind: 'ordered'|'set', sortKey?, item?: spec } },
//          objects: { <key>: spec } }
// An array entry may also declare `nullable: true` (value null is written as null, e.g. `reads[].lines`).
// Extensions (all additive):
//   - discriminated items: `item: { discriminator, variants: { <value>: spec } }` on ordered arrays; the
//     discriminator is the first key of every variant and an unknown/missing value throws;
//   - `json: [keys]`: keys holding any canonical JSON value (object keys sorted by code point, arrays keep
//     order, integers only, no lone surrogates; index-like and __proto__/constructor keys are rejected);
//   - `optional: [keys]`: keys that may be absent (skipped); present ones follow declared key order.

export function compareCodePoints(left, right) {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = left.codePointAt(leftIndex);
    const rightPoint = right.codePointAt(rightIndex);
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
    leftIndex += leftPoint > 0xffff ? 2 : 1;
    rightIndex += rightPoint > 0xffff ? 2 : 1;
  }
  if (leftIndex < left.length) return 1;
  return rightIndex < right.length ? -1 : 0;
}

const ARRAY_KINDS = ['ordered', 'set'];
const INDEX_LIKE = /^(?:0|[1-9][0-9]*)$/;
const MAX_JSON_DEPTH = 64;
const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'constructor']); // the strict reader rejects them

function isPlain(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDiscriminated(item) {
  return isPlain(item) && item.discriminator !== undefined;
}

function checkDiscriminated(item, where) {
  if (typeof item.discriminator !== 'string' || !isPlain(item.variants) || Object.keys(item.variants).length === 0) {
    throw new TypeError(`invalid spec at ${where}: discriminated item needs a string discriminator and variants`);
  }
  for (const [name, variant] of Object.entries(item.variants)) {
    if (!isPlain(variant) || !Array.isArray(variant.keys) || variant.keys[0] !== item.discriminator) {
      throw new TypeError(`invalid spec at ${where}: variant ${name} must declare the discriminator as its first key`);
    }
    if (variant.keys.includes('__proto__')) throw new TypeError(`invalid spec at ${where}: __proto__ cannot be a key`);
  }
}

function checkKeyList(list, spec, where, label) {
  if (!Array.isArray(list) || new Set(list).size !== list.length || list.some((key) => !spec.keys.includes(key))) {
    throw new TypeError(`invalid spec at ${where}: ${label} must be a unique list of declared keys`);
  }
}

function checkSpec(spec, where) {
  if (!isPlain(spec) || !Array.isArray(spec.keys)) throw new TypeError(`invalid spec at ${where}: keys are required`);
  if (new Set(spec.keys).size !== spec.keys.length || spec.keys.some((key) => typeof key !== 'string' || INDEX_LIKE.test(key))) {
    throw new TypeError(`invalid spec at ${where}: keys must be unique non-index strings`);
  }
  if (spec.keys.includes('__proto__')) throw new TypeError(`invalid spec at ${where}: __proto__ cannot be a key`);
  for (const [key, array] of Object.entries(spec.arrays ?? {})) {
    if (!spec.keys.includes(key)) throw new TypeError(`invalid spec at ${where}: array ${key} is not a key`);
    if (!isPlain(array) || !ARRAY_KINDS.includes(array.kind)) throw new TypeError(`invalid spec at ${where}: array ${key} kind`);
    if (array.nullable !== undefined && typeof array.nullable !== 'boolean') {
      throw new TypeError(`invalid spec at ${where}: array ${key} nullable must be boolean`);
    }
    if (isDiscriminated(array.item)) {
      if (array.kind !== 'ordered' || array.sortKey !== undefined) {
        throw new TypeError(`invalid spec at ${where}: array ${key} discriminated items need an ordered array`);
      }
      checkDiscriminated(array.item, `${where}.${key}`);
    } else if (array.sortKey !== undefined && (array.kind !== 'set' || !isPlain(array.item) || !Array.isArray(array.item.keys) || !array.item.keys.includes(array.sortKey))) {
      throw new TypeError(`invalid spec at ${where}: array ${key} sortKey needs a set of items declaring it`);
    }
  }
  for (const key of Object.keys(spec.objects ?? {})) {
    if (!spec.keys.includes(key)) throw new TypeError(`invalid spec at ${where}: object ${key} is not a key`);
  }
  if (spec.optional !== undefined) checkKeyList(spec.optional, spec, where, 'optional');
  if (spec.json !== undefined) {
    checkKeyList(spec.json, spec, where, 'json');
    for (const key of spec.json) {
      if (spec.arrays?.[key] !== undefined || spec.objects?.[key] !== undefined) {
        throw new TypeError(`invalid spec at ${where}: json key ${key} cannot also be an array or object`);
      }
    }
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

function scalar(value, path) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) throw new TypeError(`lone surrogate in string at ${path}`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new TypeError(`not a canonical integer at ${path}`);
    return value;
  }
  throw new TypeError(`not a canonical scalar at ${path}`);
}

// `level` is the absolute document level of `value` (the root object is level 1), the same count the strict reader caps.
function jsonValue(value, path, level) {
  if (Array.isArray(value)) {
    if (level > MAX_JSON_DEPTH) throw new TypeError(`value too deep at ${path}`);
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError(`sparse array at ${path}[${index}]`);
      items.push(jsonValue(value[index], `${path}[${index}]`, level + 1));
    }
    return items;
  }
  if (value !== null && typeof value === 'object') {
    if (!isPlain(value)) throw new TypeError(`expected a plain object at ${path}`);
    if (level > MAX_JSON_DEPTH) throw new TypeError(`value too deep at ${path}`);
    const keys = Object.keys(value);
    for (const key of keys) {
      if (INDEX_LIKE.test(key)) throw new TypeError(`index-like object key at ${path}.${key}`);
      if (FORBIDDEN_JSON_KEYS.has(key)) throw new TypeError(`forbidden object key at ${path}.${key}`);
      if (hasLoneSurrogate(key)) throw new TypeError(`lone surrogate in key at ${path}`);
    }
    keys.sort(compareCodePoints);
    return Object.fromEntries(keys.map((key) => [key, jsonValue(value[key], `${path}.${key}`, level + 1)]));
  }
  return scalar(value, path);
}

function variantFor(item, discriminated, path) {
  if (!isPlain(item)) throw new TypeError(`expected an object at ${path}`);
  const name = item[discriminated.discriminator];
  if (typeof name !== 'string' || !Object.hasOwn(discriminated.variants, name)) {
    throw new TypeError(`unknown or missing ${discriminated.discriminator} discriminator at ${path}`);
  }
  return discriminated.variants[name];
}

function orderObject(value, spec, path, level = 1) {
  checkSpec(spec, path);
  if (level > MAX_JSON_DEPTH) throw new TypeError(`value too deep at ${path}`);
  if (!isPlain(value)) throw new TypeError(`expected an object at ${path}`);
  for (const key of Object.keys(value)) {
    if (!spec.keys.includes(key)) throw new TypeError(`unknown key at ${path}.${key}`);
  }
  const ordered = {};
  for (const key of spec.keys) {
    if (!Object.hasOwn(value, key)) {
      if (spec.optional?.includes(key)) continue;
      throw new TypeError(`missing key at ${path}.${key}`);
    }
    const entry = value[key];
    const keyPath = `${path}.${key}`;
    const array = spec.arrays?.[key];
    const nested = spec.objects?.[key];
    if (spec.json?.includes(key)) ordered[key] = jsonValue(entry, keyPath, level + 1);
    else if (array !== undefined) ordered[key] = orderArray(entry, array, keyPath, level + 1);
    else if (nested !== undefined) ordered[key] = entry === null ? null : orderObject(entry, nested, keyPath, level + 1);
    else if (Array.isArray(entry)) throw new TypeError(`undeclared array at ${keyPath}`);
    else ordered[key] = scalar(entry, keyPath);
  }
  return ordered;
}

function orderArray(value, array, path, level) {
  if (value === null && array.nullable === true) return null;
  if (!Array.isArray(value)) throw new TypeError(`expected an array at ${path}`);
  if (level > MAX_JSON_DEPTH) throw new TypeError(`value too deep at ${path}`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError(`sparse array at ${path}[${index}]`);
  }
  const items = value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (array.item === undefined) {
      if (Array.isArray(item) || (item !== null && typeof item === 'object')) {
        throw new TypeError(`object item needs an item spec at ${itemPath}`);
      }
      return scalar(item, itemPath);
    }
    return orderObject(item, isDiscriminated(array.item) ? variantFor(item, array.item, itemPath) : array.item, itemPath, level + 1);
  });
  if (array.kind === 'ordered') return items;
  const keyOf = (item) => {
    const key = array.sortKey === undefined ? item : item[array.sortKey];
    if (typeof key !== 'string') throw new TypeError(`set members must be sorted by a string at ${path}`);
    return key;
  };
  const sorted = [...items].sort((left, right) => compareCodePoints(keyOf(left), keyOf(right)));
  for (let index = 1; index < sorted.length; index += 1) {
    if (keyOf(sorted[index - 1]) === keyOf(sorted[index])) throw new TypeError(`duplicate set member at ${path}`);
  }
  return sorted;
}

function escapeSeparators(text) {
  return text.replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

export function canonicalizeJson(value, spec) {
  return `${escapeSeparators(JSON.stringify(orderObject(value, spec, '$'), null, 2))}\n`;
}

// Compact single-line form used for JSONL records (no trailing newline).
export function canonicalizeJsonCompact(value, spec) {
  return escapeSeparators(JSON.stringify(orderObject(value, spec, '$')));
}
