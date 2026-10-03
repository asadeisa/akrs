// The lease store (F17, A1 3.1). Policy and decisions: policy.js. Plain store functions: nothing is printed and
// nothing exits; every write happens under the repository lock.
import { join } from 'node:path';
import { createDefaultProviders } from '../../core/providers.js';
import { SNAPSHOT_PATTERN, isId, isTimestamp, isUlid } from '../../schemas/common.js';
import { EXECUTOR_ROLES } from '../../schemas/executors.js';
import { compareCodePoints, canonicalizeJson, parseStrictJson } from '../canonical/index.js';
import {
  ensureOpsDirectory,
  inspectOpsDirectory,
  locateOps,
  readTextIfExists,
  removeFile,
  withLockOrHeld,
  writeFileAtomic,
} from '../ops-files.js';
import {
  INVENTORY_KEYS,
  LEASE_DIRECTORY,
  LEASE_ENV_VARIABLE,
  LEASE_FILE_SUFFIX,
  LEASE_FINDING_CODES,
  LEASE_KEYS,
  LEASE_KINDS,
  LEASE_SCHEMA,
} from './policy.js';

export const LEASE_SPEC = Object.freeze({
  keys: [...LEASE_KEYS],
  arrays: { inventory: { kind: 'ordered', item: { keys: [...INVENTORY_KEYS], arrays: {}, objects: {} } } },
  objects: {},
});

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const singleLine = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(value);
const isSha = (value) => typeof value === 'string' && SNAPSHOT_PATTERN.test(value);

function validateInventory(inventory, push) {
  if (!Array.isArray(inventory)) {
    push('$.inventory', 'invalid_type', 'must be an array');
    return;
  }
  inventory.forEach((entry, index) => {
    const path = `$.inventory[${index}]`;
    if (!isPlain(entry)) {
      push(path, 'invalid_type', 'must be an object');
      return;
    }
    for (const key of INVENTORY_KEYS) if (!Object.hasOwn(entry, key)) push(`${path}.${key}`, 'missing_key', `missing required key: ${key}`);
    for (const key of Object.keys(entry)) if (!INVENTORY_KEYS.includes(key)) push(`${path}.${key}`, 'unknown_key', `unknown key: ${key}`);
    if (Object.hasOwn(entry, 'projection') && !(typeof entry.projection === 'string' && /^[a-z][a-z0-9-]*$/.test(entry.projection))) {
      push(`${path}.projection`, 'invalid_format', 'must be a projection name');
    }
    if (Object.hasOwn(entry, 'key') && !singleLine(entry.key, 4096)) push(`${path}.key`, 'invalid_value', 'must be a single-line string');
    if (Object.hasOwn(entry, 'kind') && !(typeof entry.kind === 'string' && /^[a-z][a-z0-9_-]*$/.test(entry.kind))) {
      push(`${path}.kind`, 'invalid_format', 'must be an inventory kind');
    }
    if (Object.hasOwn(entry, 'value') && !singleLine(entry.value, 256)) push(`${path}.value`, 'invalid_value', 'must be a hash or token');
  });
}

export function validateLease(value) {
  const issues = [];
  const push = (path, code, message) => issues.push({ path, code, message });
  if (!isPlain(value)) {
    push('$', 'invalid_type', 'must be an object');
    return { ok: false, issues };
  }
  for (const key of LEASE_KEYS) if (!Object.hasOwn(value, key)) push(`$.${key}`, 'missing_key', `missing required key: ${key}`);
  for (const key of Object.keys(value)) if (!LEASE_KEYS.includes(key)) push(`$.${key}`, 'unknown_key', `unknown key: ${key}`);
  const has = (key) => Object.hasOwn(value, key);
  if (has('schema') && value.schema !== LEASE_SCHEMA) push('$.schema', 'invalid_value', `must be ${LEASE_SCHEMA}`);
  if (has('kind') && !LEASE_KINDS.includes(value.kind)) push('$.kind', 'invalid_value', `must be one of: ${LEASE_KINDS.join(', ')}`);
  if (has('target') && !isId(value.target)) push('$.target', 'invalid_format', 'must be a Road or Plan ID');
  if (has('holder') && !isId(value.holder)) push('$.holder', 'invalid_format', 'must be an executor ID');
  if (has('snapshot') && !isSha(value.snapshot)) push('$.snapshot', 'invalid_format', 'must be sha256:<64 lowercase hex>');
  if (has('inventory')) validateInventory(value.inventory, push);
  for (const key of ['acquired_at', 'refreshed_at']) {
    if (has(key) && !isTimestamp(value[key])) push(`$.${key}`, 'invalid_format', 'must be an RFC 3339 UTC timestamp with milliseconds');
  }
  if (has('request_id') && value.request_id !== null && !isUlid(value.request_id)) {
    push('$.request_id', 'invalid_format', 'must be null or a ULID');
  }
  return { ok: issues.length === 0, issues };
}

// ---- argument checks --------------------------------------------------------------------------------------
function checkKind(kind) {
  if (!LEASE_KINDS.includes(kind)) throw new TypeError(`kind must be one of: ${LEASE_KINDS.join(', ')}`);
  return kind;
}

function checkTarget(target) {
  if (!isId(target)) throw new TypeError('target must be a valid Road or Plan ID');
  return target;
}

function checkHolder(holder) {
  if (!isId(holder)) throw new TypeError('holder must be an executor ID');
  return holder;
}

function checkLeaseState({ snapshot, inventory, requestId }) {
  if (!isSha(snapshot)) throw new TypeError('snapshot must be a sha256 snapshot');
  const probe = [];
  validateInventory(inventory, (path, code, message) => probe.push(`${path} ${code}: ${message}`));
  if (probe.length > 0) throw new TypeError(`inventory is invalid: ${probe[0]}`);
  if (requestId !== null && !isUlid(requestId)) throw new TypeError('requestId must be null or a ULID');
}


// ---- files ------------------------------------------------------------------------------------------------
const segmentsFor = (kind) => [LEASE_DIRECTORY, kind];
const fileName = (target) => `${target}${LEASE_FILE_SUFFIX}`;

async function readLeaseFile(location, kind, target) {
  const directory = await inspectOpsDirectory(location, segmentsFor(kind));
  if (directory === null) return { status: 'none' };
  const text = await readTextIfExists(join(directory, fileName(target)));
  if (text === null) return { status: 'none' };
  const parsed = parseStrictJson(text);
  if (!parsed.ok) return { status: 'corrupt', reason: `unreadable JSON: ${parsed.issues[0].code}` };
  const verdict = validateLease(parsed.value);
  if (!verdict.ok) return { status: 'corrupt', reason: `${verdict.issues[0].path} ${verdict.issues[0].code}` };
  const lease = parsed.value;
  if (lease.kind !== kind || lease.target !== target) return { status: 'corrupt', reason: 'lease belongs to another target' };
  return { status: 'held', lease };
}

async function writeLeaseFile(location, lease) {
  const directory = await ensureOpsDirectory(location, segmentsFor(lease.kind));
  await writeFileAtomic(join(directory, fileName(lease.target)), canonicalizeJson(lease, LEASE_SPEC));
}

async function removeLeaseFile(location, kind, target) {
  const directory = await inspectOpsDirectory(location, segmentsFor(kind));
  if (directory !== null) await removeFile(join(directory, fileName(target)));
}

function heldByAnother(kind, target, holder, requestedBy) {
  return {
    code: LEASE_FINDING_CODES.held_by_another,
    severity: 'error',
    message: `${kind} ${target} is leased by ${holder}; claim it with an explicit takeover or ask the Leader to release it.`,
    file: null,
    line: null,
    detail: { kind, target, holder, requested_by: requestedBy },
  };
}

const lockBlocked = (locked) => ({ status: 'lock_blocked', finding: locked.finding, lock: locked });

// Shared prologue of every write: validated arguments, the lock, the location.
async function locked(options, command, fn) {
  const { repositoryRoot, workflowRoot, heldLock, lockOptions } = options;
  const result = await withLockOrHeld({ repositoryRoot, workflowRoot, heldLock, lockOptions, command }, async () => (
    fn(await locateOps({ repositoryRoot, workflowRoot }))
  ));
  return result.status === 'ok' ? result.value : lockBlocked(result);
}

const nowOf = (options) => (options.providers ?? createDefaultProviders()).now();

// ---- public API -------------------------------------------------------------------------------------------
export async function readLease({ repositoryRoot, workflowRoot, kind, target } = {}) {
  checkKind(kind);
  checkTarget(target);
  return readLeaseFile(await locateOps({ repositoryRoot, workflowRoot }), kind, target);
}

export async function claimLease(options = {}) {
  const { kind, target, holder, snapshot, inventory, requestId = null, takeover = false } = options;
  checkKind(kind);
  checkTarget(target);
  checkHolder(holder);
  checkLeaseState({ snapshot, inventory, requestId });
  if (typeof takeover !== 'boolean') throw new TypeError('takeover must be a boolean');
  return locked(options, 'lease-claim', async (location) => {
    const existing = await readLeaseFile(location, kind, target);
    const now = nowOf(options);
    const fresh = {
      schema: LEASE_SCHEMA, kind, target, holder, snapshot, inventory: inventory.map((entry) => ({ ...entry })),
      acquired_at: now, refreshed_at: now, request_id: requestId,
    };
    if (existing.status === 'none') {
      await writeLeaseFile(location, fresh);
      return { status: 'claimed', lease: fresh };
    }
    if (existing.status === 'corrupt') {
      if (!takeover) return { status: 'corrupt', reason: existing.reason };
      await writeLeaseFile(location, fresh);
      return { status: 'taken_over', lease: fresh, previous_holder: null };
    }
    const current = existing.lease;
    if (current.holder === holder) {
      const same = current.snapshot === snapshot && JSON.stringify(current.inventory) === JSON.stringify(fresh.inventory);
      if (same) return { status: 'noop', refreshed: false, lease: current };
      const advanced = { ...current, snapshot, inventory: fresh.inventory, refreshed_at: now, request_id: requestId };
      await writeLeaseFile(location, advanced);
      return { status: 'noop', refreshed: true, lease: advanced };
    }
    if (!takeover) {
      return { status: 'blocked', holder: current.holder, finding: heldByAnother(kind, target, current.holder, holder) };
    }
    await writeLeaseFile(location, fresh);
    return { status: 'taken_over', lease: fresh, previous_holder: current.holder };
  });
}

export async function refreshLease(options = {}) {
  const { kind, target, holder, snapshot, inventory, requestId = null } = options;
  checkKind(kind);
  checkTarget(target);
  checkHolder(holder);
  checkLeaseState({ snapshot, inventory, requestId });
  return locked(options, 'lease-refresh', async (location) => {
    const existing = await readLeaseFile(location, kind, target);
    if (existing.status === 'none') return { status: 'none' };
    if (existing.status === 'corrupt') return { status: 'corrupt', reason: existing.reason };
    const current = existing.lease;
    if (current.holder !== holder) {
      return { status: 'blocked', holder: current.holder, finding: heldByAnother(kind, target, current.holder, holder) };
    }
    const refreshed = {
      ...current, snapshot, inventory: inventory.map((entry) => ({ ...entry })), refreshed_at: nowOf(options), request_id: requestId,
    };
    await writeLeaseFile(location, refreshed);
    return { status: 'refreshed', lease: refreshed };
  });
}

export async function releaseLease(options = {}) {
  const { kind, target, leader = false } = options;
  const holder = options.holder ?? null;
  checkKind(kind);
  checkTarget(target);
  if (typeof leader !== 'boolean') throw new TypeError('leader must be a boolean');
  if (holder !== null) checkHolder(holder);
  else if (!leader) throw new TypeError('releaseLease needs the holder or leader: true');
  return locked(options, 'lease-release', async (location) => {
    const existing = await readLeaseFile(location, kind, target);
    if (existing.status === 'none') return { status: 'noop' };
    if (existing.status === 'corrupt') {
      if (!leader) return { status: 'corrupt', reason: existing.reason };
      await removeLeaseFile(location, kind, target);
      return { status: 'released', previous_holder: null };
    }
    const current = existing.lease;
    if (!leader && current.holder !== holder) {
      return { status: 'blocked', holder: current.holder, finding: heldByAnother(kind, target, current.holder, holder) };
    }
    await removeLeaseFile(location, kind, target);
    return { status: 'released', previous_holder: current.holder };
  });
}

// ---- freshness --------------------------------------------------------------------------------------------
const keyOf = ({ projection, key }) => `${projection}:${key}`;
const emptyDelta = () => ({ changed: [], added: [], removed: [] });

function deltaOf(leaseInventory, currentInventory) {
  const before = new Map(leaseInventory.map((entry) => [keyOf(entry), entry.value]));
  const after = new Map(currentInventory.map((entry) => [keyOf(entry), entry.value]));
  const delta = emptyDelta();
  for (const [key, value] of after) {
    if (!before.has(key)) delta.added.push(key);
    else if (before.get(key) !== value) delta.changed.push(key);
  }
  for (const key of before.keys()) if (!after.has(key)) delta.removed.push(key);
  for (const list of Object.values(delta)) list.sort(compareCodePoints);
  return delta;
}

// `lease` is a stored lease (or null); `current` a computeSnapshot result over the same lease projection.
export function checkLease({ lease, current } = {}) {
  const snapshot = current?.snapshot ?? null;
  if (lease === null || lease === undefined) return { state: 'none', delta: emptyDelta(), snapshot, reason: null };
  if (current?.status !== 'ok' || snapshot === null) {
    return { state: 'stale', delta: deltaOf(lease.inventory, current?.inventory ?? lease.inventory), snapshot: null, reason: 'unstable' };
  }
  if (snapshot === lease.snapshot) return { state: 'fresh', delta: emptyDelta(), snapshot, reason: null };
  return { state: 'stale', delta: deltaOf(lease.inventory, current.inventory), snapshot, reason: null };
}

// The finding a stale holder mutation returns (AKRS-C013, source "lease"); the delta says what to re-read.
export function leaseStaleFinding(check, lease) {
  return {
    code: LEASE_FINDING_CODES.stale,
    severity: 'error',
    message: 'The lease contract changed since this holder last read it; re-read it with the work command and retry.',
    file: null,
    line: null,
    detail: { source: 'lease', expected: lease.snapshot, current: check.snapshot, delta: check.delta },
  };
}

// ---- holder and expected-snapshot resolution ----------------------------------------------------------------
export function resolveHolder({ flag, env = process.env, executors, role } = {}) {
  if (!EXECUTOR_ROLES.includes(role)) throw new TypeError(`role must be one of: ${EXECUTOR_ROLES.join(', ')}`);
  if (!Array.isArray(executors)) throw new TypeError('executors must be an array');
  const ofRole = executors.filter((entry) => entry?.role === role).map((entry) => entry.id).sort(compareCodePoints);
  const choices = (reason, supplied, source) => ({ status: 'choices', reason, choices: ofRole, supplied, source });
  const present = (value) => typeof value === 'string' && value !== '';
  let supplied = null;
  let source = null;
  if (present(flag)) {
    supplied = flag;
    source = 'flag';
  } else if (present(env?.[LEASE_ENV_VARIABLE])) {
    supplied = env[LEASE_ENV_VARIABLE];
    source = 'env';
  }
  if (supplied !== null) {
    const known = executors.find((entry) => entry?.id === supplied);
    if (known === undefined) return choices('unknown_executor', supplied, source);
    if (known.role !== role) return choices('wrong_role', supplied, source);
    return { status: 'resolved', holder: supplied, source };
  }
  if (ofRole.length === 1) return { status: 'resolved', holder: ofRole[0], source: 'only_executor_of_role' };
  return choices(ofRole.length === 0 ? 'none' : 'multiple', null, null);
}

// An explicit --if-snapshot wins over the lease. `current` is { command, lease }: the measurement of the command
// row (what an explicit snapshot is compared against) and of the lease projection (what a lease implies).
export function resolveExpectedSnapshot({ explicit = null, lease = null, current = {} } = {}) {
  if (explicit !== null && explicit !== undefined) {
    if (!isSha(explicit)) throw new TypeError('explicit expected snapshot must be a sha256 snapshot');
    const measured = current.command;
    return {
      snapshot: explicit, source: 'explicit', compare_against: 'command', matches: measured === undefined ? null : measured === explicit,
    };
  }
  if (lease !== null && lease !== undefined) {
    const measured = current.lease;
    return {
      snapshot: lease.snapshot, source: 'lease', compare_against: 'lease', matches: measured === undefined ? null : measured === lease.snapshot,
    };
  }
  return { snapshot: null, source: 'none', compare_against: null, matches: null };
}
