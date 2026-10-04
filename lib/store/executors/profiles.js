import { CLASS_PROFILES } from './policy.js';

// Default profile of the class merged with its numeric overrides (a fresh object).
export function resolveProfile(cls, classOverrides = {}) {
  const base = CLASS_PROFILES[cls];
  if (base === undefined) throw new TypeError(`unknown executor class: ${String(cls)}`);
  return { ...base, write_classes: [...base.write_classes], ...(classOverrides?.[cls] ?? {}) };
}

export { CLASS_PROFILES };
