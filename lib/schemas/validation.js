export class ContractValidationError extends TypeError {
  constructor(label, issues) {
    super(`${label} failed validation`);
    this.name = 'ContractValidationError';
    this.issues = issues;
  }
}

export function issue(issues, path, code, message) {
  issues.push({ path, code, message });
}

export function validationResult(issues) {
  return { ok: issues.length === 0, issues };
}

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateClosedObject(value, keys, path, issues) {
  if (!isPlainObject(value)) {
    issue(issues, path, 'invalid_type', 'must be an object');
    return false;
  }

  const allowed = new Set(keys);
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      issue(issues, `${path}.${key}`, 'missing_key', `missing required key: ${key}`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issue(issues, `${path}.${key}`, 'unknown_key', `unknown key: ${key}`);
    }
  }
  return true;
}

export function validateJsonValue(value, path, issues) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) issue(issues, path, 'invalid_value', 'number must be finite');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateJsonValue(entry, `${path}[${index}]`, issues));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      validateJsonValue(entry, `${path}.${key}`, issues);
    }
    return;
  }
  issue(issues, path, 'invalid_type', 'must contain JSON-compatible values only');
}

export function assertValid(label, result) {
  if (!result.ok) throw new ContractValidationError(label, result.issues);
}
