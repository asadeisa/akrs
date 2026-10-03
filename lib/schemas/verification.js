// Verification contract `akrs.verification/v1` (A1 §7.3, Q21), the closed `scenario` vocabulary (Lock 20: no
// arbitrary JavaScript, no shell), the evidence reference (Q22, Q33) and the run record `akrs.run/v1`.
// The contract is keyed by the Plan ID; in the no-Plan tier it is keyed by the Road ID (Q13).
import { validateRepoPath } from './primitives.js';
import {
  MAX_PATH_LENGTH, MAX_PATH_SEGMENT_LENGTH, MAX_TIMEOUT_MS, READ_ENTRY_KEYS, checkArgv, embeddedBinaryReason, checkBoolean, checkEach, checkEnum, checkId, checkInteger, checkIdSet, checkName,
  checkSchemaValue, checkSet, checkSha, checkText, checkTextList, checkTimestamp, checkUlid, checkUnique, deepFreeze,
  isPlainObject, issue, present, resolveForm, resolveWorkflowRoot, validateClosedObject, validateJsonLiteral, validateMeta, validateReadList,
  validateTimeout,
} from './artifact-kit.js';
import { validationResult } from './validation.js';

export const VERIFICATION_SCHEMA = 'akrs.verification/v1';
export const RUN_SCHEMA = 'akrs.run/v1';
export const VERIFICATION_KEYS = Object.freeze([
  'schema', 'plan', 'roads', 'policy', 'reads', 'launch', 'setup', 'teardown', 'acceptance', 'measurements',
  'evidence_types', 'reachability', 'boundaries', 'timeout_ms', 'allowed_hosts', 'scenario', 'meta',
]);
export const VERIFICATION_INPUT_KEYS = Object.freeze(VERIFICATION_KEYS.filter((key) => key !== 'meta'));
export const VERIFICATION_POLICIES = Object.freeze(['none', 'checks', 'live', 'measured']);
export const EVIDENCE_TYPES = Object.freeze(['screenshot', 'console', 'network', 'a11y', 'timing', 'log', 'file']);
export const MEASUREMENT_DIRECTIONS = Object.freeze(['max', 'min']);
export const HTTP_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
export const MEASURE_METRICS = Object.freeze(['lcp', 'load', 'ttfb']);
export const SCENARIO_STEPS = Object.freeze([
  'goto', 'click', 'fill', 'press', 'wait_for', 'expect_text', 'expect_no_console_errors', 'http',
  'screenshot', 'measure', 'viewport',
]);
export const SCENARIO_STEP_KEYS = deepFreeze({
  goto: ['step', 'url', 'soft'],
  click: ['step', 'text', 'selector', 'role', 'name', 'soft'],
  fill: ['step', 'selector', 'value', 'soft'],
  press: ['step', 'key', 'soft'],
  wait_for: ['step', 'text', 'selector', 'url', 'timeout_ms', 'soft'],
  expect_text: ['step', 'text', 'soft'],
  expect_no_console_errors: ['step', 'soft'],
  http: ['step', 'method', 'url', 'headers', 'body', 'expect_status', 'expect_json', 'soft'],
  screenshot: ['step', 'name', 'soft'],
  measure: ['step', 'metric', 'budget_ms', 'soft'],
  viewport: ['step', 'width', 'height', 'soft'],
});
export const LAUNCH_KEYS = Object.freeze(['argv', 'url', 'ready']);
export const READY_KEYS = Object.freeze(['url', 'status', 'timeout_ms']);
export const COMMAND_KEYS = Object.freeze(['name', 'argv']);
export const MEASUREMENT_KEYS = Object.freeze(['name', 'unit', 'budget', 'direction']);
export const HEADER_KEYS = Object.freeze(['name', 'value']);
export const EXPECT_JSON_KEYS = Object.freeze(['pointer', 'equals']);
export const EVIDENCE_REF_KEYS = Object.freeze(['path', 'type', 'bytes', 'sha256']);
// The agent-authored Result names evidence by path and type; the CLI measures bytes and sha256 (A1 AX rule).
export const EVIDENCE_INPUT_KEYS = Object.freeze(['path', 'type']);
export const RUN_KEYS = Object.freeze([
  'schema', 'id', 'plan', 'snapshot', 'contract_hash', 'started_at', 'ended_at', 'status', 'steps', 'evidence', 'meta',
]);
export const RUN_STATUSES = Object.freeze(['passed', 'failed', 'blocked']);
export const RUN_STEP_STATUSES = Object.freeze(['passed', 'failed', 'skipped']);
export const RUN_STEP_KEYS = Object.freeze(['index', 'step', 'status', 'soft', 'duration_ms', 'detail', 'evidence']);

const bare = (keys, extra = {}) => ({ keys: [...keys], arrays: {}, objects: {}, ...extra });
export const EVIDENCE_REF_SPEC = deepFreeze(bare(EVIDENCE_REF_KEYS));
const COMMAND_SPEC = bare(COMMAND_KEYS, { arrays: { argv: { kind: 'ordered' } } });

// One codec variant per step kind, chosen by the leading `step` key.
export const SCENARIO_VARIANTS = deepFreeze(Object.fromEntries(SCENARIO_STEPS.map((name) => {
  const keys = SCENARIO_STEP_KEYS[name];
  if (name !== 'http') return [name, bare(keys)];
  return [name, {
    keys: [...keys],
    arrays: { headers: { kind: 'set', sortKey: 'name', item: bare(HEADER_KEYS) } },
    objects: { expect_json: { keys: [...EXPECT_JSON_KEYS], json: ['equals'], arrays: {}, objects: {} } },
  }];
})));

// Canonical codec spec (the CLI-owned `meta` key is appended by `storedSpec`).
export const VERIFICATION_SPEC = deepFreeze({
  keys: [...VERIFICATION_INPUT_KEYS],
  arrays: {
    roads: { kind: 'set' },
    reads: { kind: 'ordered', item: { keys: [...READ_ENTRY_KEYS], arrays: { lines: { kind: 'ordered', nullable: true } }, objects: {} } },
    setup: { kind: 'ordered', item: COMMAND_SPEC },
    teardown: { kind: 'ordered', item: COMMAND_SPEC },
    acceptance: { kind: 'ordered' },
    measurements: { kind: 'ordered', item: bare(MEASUREMENT_KEYS) },
    evidence_types: { kind: 'set' },
    reachability: { kind: 'ordered' },
    boundaries: { kind: 'ordered' },
    allowed_hosts: { kind: 'set' },
    scenario: { kind: 'ordered', item: { discriminator: 'step', variants: SCENARIO_VARIANTS } },
  },
  objects: {
    launch: {
      keys: [...LAUNCH_KEYS],
      arrays: { argv: { kind: 'ordered' } },
      objects: { ready: bare(READY_KEYS) },
    },
  },
});

export const RUN_SPEC = deepFreeze({
  keys: RUN_KEYS.filter((key) => key !== 'meta'),
  arrays: {
    steps: {
      kind: 'ordered',
      item: bare(RUN_STEP_KEYS, {
        arrays: { evidence: { kind: 'set', sortKey: 'path', item: EVIDENCE_REF_SPEC } },
      }),
    },
    evidence: { kind: 'set', sortKey: 'path', item: EVIDENCE_REF_SPEC },
  },
  objects: {},
});

// ---- helpers -------------------------------------------------------------------------------------------
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const POINTER_PATTERN = /^(?:\/(?:[^~/\u0000-\u001f\u007f]|~[01])*)*$/;
const HEADER_NAME = /^[a-z0-9][a-z0-9-]*$/;
const KEY_NAME = /^[!-~]{1,32}$/;
const SHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ABSOLUTE_URL = /^(https?):\/\/([^/?#]*)([/?#]\S*)?$/i;

function parseAuthority(authority) {
  if (authority === '' || authority.includes('@')) return null;
  const bracketed = /^(\[[0-9A-Fa-f:.]+\])(?::([0-9]{1,5}))?$/.exec(authority);
  const plain = /^([^:[\]]+)(?::([0-9]{1,5}))?$/.exec(authority);
  const match = bracketed ?? plain;
  if (match === null) return null;
  if (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return null;
  return { host: match[1].toLowerCase() };
}

function isLoopback(host) {
  // `*.localhost` is not guaranteed to resolve to loopback on every resolver: it needs allowed_hosts
  if (host === 'localhost' || host === '[::1]') return true;
  const octets = /^127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(host);
  return octets !== null && octets.slice(1).every((part) => Number(part) <= 255);
}

// Loopback hosts are always allowed; any other host must be listed in the contract `allowed_hosts` (Q21).
function checkUrl(value, path, issues, { allowedHosts = [], allowRelative = true } = {}) {
  if (typeof value !== 'string') {
    issue(issues, path, 'invalid_type', 'must be a URL string');
    return false;
  }
  if (allowRelative && value.startsWith('/') && !value.startsWith('//') && /^[^\s\\\u0000-\u001f]+$/.test(value)) return true;
  const match = ABSOLUTE_URL.exec(value);
  const parsed = match === null ? null : parseAuthority(match[2]);
  if (parsed === null || /[\u0000-\u001f\\]/.test(value)) {
    issue(issues, path, 'invalid_value', allowRelative
      ? 'must be an http(s) URL without credentials, or a path starting with a single /'
      : 'must be an http(s) URL without credentials');
    return false;
  }
  const listed = allowedHosts.includes(parsed.host);
  if (!isLoopback(parsed.host) && !listed) {
    issue(issues, path, 'invalid_value', `host ${parsed.host} is neither loopback nor listed in allowed_hosts`);
    return false;
  }
  return true;
}

function exactlyOne(flags) {
  return flags.filter(Boolean).length === 1;
}

// ---- evidence reference (Q33) ----------------------------------------------------------------------------
export function validateEvidenceRef(value, path, issues, options = {}) {
  const { plan = null } = options;
  const workflowRoot = resolveWorkflowRoot(options);
  if (!validateClosedObject(value, options.input === true ? EVIDENCE_INPUT_KEYS : EVIDENCE_REF_KEYS, path, issues)) return;
  if (present(value, 'path')) {
    const pathPath = `${path}.path`;
    if (typeof value.path !== 'string') {
      issue(issues, pathPath, 'invalid_type', 'must be a string');
    } else {
      const before = issues.length;
      validateRepoPath(value.path, pathPath, issues, { allow: ['file'] });
      if (issues.length === before) {
        const binary = embeddedBinaryReason(value.path);
        if (binary !== null) issue(issues, pathPath, 'embedded_binary', `must be a file path, not an embedded payload: ${binary}`);
        else if (value.path.length > MAX_PATH_LENGTH || value.path.split('/').some((segment) => segment.length > MAX_PATH_SEGMENT_LENGTH)) {
          issue(issues, pathPath, 'invalid_value', `must be at most ${MAX_PATH_LENGTH} characters with segments of at most ${MAX_PATH_SEGMENT_LENGTH}`);
        }
      }
      if (issues.length === before) {
        const base = `${workflowRoot}/verifications/`;
        const directory = typeof plan === 'string' ? `${base}${plan}/evidence/` : null;
        const inside = directory === null
          ? value.path.startsWith(base) && /^[^/]+\/evidence\/./.test(value.path.slice(base.length))
          : value.path.startsWith(directory) && value.path.length > directory.length;
        if (!inside) {
          issue(issues, pathPath, 'invalid_value', `evidence must live under ${directory ?? `${base}<plan>/evidence/`}`);
        }
      }
    }
  }
  if (present(value, 'type')) checkEnum(value.type, EVIDENCE_TYPES, `${path}.type`, issues);
  if (present(value, 'bytes')) checkInteger(value.bytes, `${path}.bytes`, issues, { min: 0 });
  if (present(value, 'sha256')) checkSha(value.sha256, `${path}.sha256`, issues);
}

export function validateEvidenceList(value, path, issues, { plan, sorted, workflowRoot, input = false }) {
  if (!checkEach(value, path, issues, (entry, entryPath) => validateEvidenceRef(entry, entryPath, issues, { plan, workflowRoot, input }))) return;
  checkSet(value, path, issues, {
    sorted,
    keyOf: (entry) => (isPlainObject(entry) && typeof entry.path === 'string' ? entry.path : null),
    keyPath: '.path',
    fold: true,
  });
}

// ---- scenario steps (Q21) --------------------------------------------------------------------------------
function validateHeaders(value, path, issues, sorted) {
  const ok = checkEach(value, path, issues, (entry, entryPath) => {
    if (!validateClosedObject(entry, HEADER_KEYS, entryPath, issues)) return;
    if (present(entry, 'name') && (typeof entry.name !== 'string' || !HEADER_NAME.test(entry.name))) {
      issue(issues, `${entryPath}.name`, 'invalid_format', 'header names are lower-case tokens');
    }
    if (present(entry, 'value')) {
      if (typeof entry.value !== 'string') issue(issues, `${entryPath}.value`, 'invalid_type', 'must be a string');
      else if (/[\u0000-\u001f\u007f]/.test(entry.value)) issue(issues, `${entryPath}.value`, 'invalid_value', 'header values are single-line text');
      else checkText(entry.value, `${entryPath}.value`, issues, { allowEmpty: true });
    }
  });
  if (!ok) return;
  checkSet(value, path, issues, {
    sorted, keyOf: (entry) => (isPlainObject(entry) && typeof entry.name === 'string' ? entry.name : null), keyPath: '.name',
  });
}

function validateHttpStep(value, path, issues, options) {
  if (present(value, 'method')) checkEnum(value.method, HTTP_METHODS, `${path}.method`, issues);
  if (present(value, 'url')) checkUrl(value.url, `${path}.url`, issues, options);
  if (present(value, 'headers')) validateHeaders(value.headers, `${path}.headers`, issues, options.sorted === true);
  if (present(value, 'body')) checkText(value.body, `${path}.body`, issues, { nullable: true, allowEmpty: true });
  if (present(value, 'expect_status')) checkInteger(value.expect_status, `${path}.expect_status`, issues, { min: 100, max: 599, nullable: true });
  if (present(value, 'expect_json') && value.expect_json !== null
    && validateClosedObject(value.expect_json, EXPECT_JSON_KEYS, `${path}.expect_json`, issues)) {
    const expectation = value.expect_json;
    if (present(expectation, 'pointer') && (typeof expectation.pointer !== 'string' || !POINTER_PATTERN.test(expectation.pointer))) {
      issue(issues, `${path}.expect_json.pointer`, 'invalid_format', 'must be an RFC 6901 JSON Pointer');
    }
    if (present(expectation, 'equals')) validateJsonLiteral(expectation.equals, `${path}.expect_json.equals`, issues);
  }
  if (present(value, 'expect_status') && present(value, 'expect_json') && value.expect_status === null && value.expect_json === null) {
    issue(issues, path, 'invalid_value', 'an http step needs expect_status or expect_json');
  }
}

const STEP_RULES = {
  goto(value, path, issues, options) {
    if (present(value, 'url')) checkUrl(value.url, `${path}.url`, issues, options);
  },
  click(value, path, issues) {
    for (const key of ['text', 'selector', 'role', 'name']) {
      if (present(value, key)) checkText(value[key], `${path}.${key}`, issues, { nullable: true, singleLine: true });
    }
    const has = (key) => value[key] !== null && value[key] !== undefined;
    if (!exactlyOne([has('text'), has('selector'), has('role') || has('name')]) || has('role') !== has('name')) {
      issue(issues, path, 'invalid_value', 'a click targets exactly one of: text, selector, or role together with name');
    }
  },
  fill(value, path, issues) {
    if (present(value, 'selector')) checkText(value.selector, `${path}.selector`, issues, { singleLine: true });
    if (present(value, 'value')) checkText(value.value, `${path}.value`, issues, { allowEmpty: true });
  },
  press(value, path, issues) {
    if (present(value, 'key') && (typeof value.key !== 'string' || !KEY_NAME.test(value.key))) {
      issue(issues, `${path}.key`, 'invalid_value', 'must be a key name of 1-32 printable characters without spaces');
    }
  },
  wait_for(value, path, issues) {
    for (const key of ['text', 'selector', 'url']) {
      if (present(value, key)) checkText(value[key], `${path}.${key}`, issues, { nullable: true, singleLine: true });
    }
    if (present(value, 'timeout_ms')) checkInteger(value.timeout_ms, `${path}.timeout_ms`, issues, { min: 1, max: MAX_TIMEOUT_MS, nullable: true });
    const has = (key) => value[key] !== null && value[key] !== undefined;
    if (!exactlyOne([has('text'), has('selector'), has('url')])) {
      issue(issues, path, 'invalid_value', 'wait_for names exactly one of: text, selector, url');
    }
  },
  expect_text(value, path, issues) {
    if (present(value, 'text')) checkText(value.text, `${path}.text`, issues);
  },
  expect_no_console_errors() {},
  http: validateHttpStep,
  screenshot(value, path, issues) {
    if (present(value, 'name') && (typeof value.name !== 'string' || !SHOT_NAME.test(value.name))) {
      issue(issues, `${path}.name`, 'invalid_format', 'must be 1-64 letters, digits, _ or - starting with a letter or digit');
    }
  },
  measure(value, path, issues) {
    if (present(value, 'metric')) checkEnum(value.metric, MEASURE_METRICS, `${path}.metric`, issues);
    if (present(value, 'budget_ms')) checkInteger(value.budget_ms, `${path}.budget_ms`, issues, { min: 1, nullable: true });
  },
  viewport(value, path, issues) {
    for (const key of ['width', 'height']) {
      if (present(value, key)) checkInteger(value[key], `${path}.${key}`, issues, { min: 1, max: 10000 });
    }
  },
};

export function validateScenarioStep(value, path, issues, options = {}) {
  if (!isPlainObject(value)) {
    issue(issues, path, 'invalid_type', 'must be an object');
    return;
  }
  if (!Object.hasOwn(value, 'step')) {
    issue(issues, `${path}.step`, 'missing_key', 'missing required key: step');
    return;
  }
  if (typeof value.step !== 'string' || !SCENARIO_STEPS.includes(value.step)) {
    issue(issues, `${path}.step`, 'unknown_step', `unknown step; the vocabulary is: ${SCENARIO_STEPS.join(', ')}`);
    return;
  }
  validateClosedObject(value, SCENARIO_STEP_KEYS[value.step], path, issues);
  if (present(value, 'soft')) checkBoolean(value.soft, `${path}.soft`, issues);
  STEP_RULES[value.step](value, path, issues, options);
}

// ---- contract ----------------------------------------------------------------------------------------------
function validateReady(value, path, issues, options) {
  if (value === null) return;
  if (!validateClosedObject(value, READY_KEYS, path, issues)) return;
  if (present(value, 'url')) checkUrl(value.url, `${path}.url`, issues, options);
  if (present(value, 'status')) checkInteger(value.status, `${path}.status`, issues, { min: 100, max: 599 });
  if (present(value, 'timeout_ms')) validateTimeout(value.timeout_ms, `${path}.timeout_ms`, issues);
}

function validateLaunch(value, path, issues, options) {
  if (value === null) return;
  if (!validateClosedObject(value, LAUNCH_KEYS, path, issues)) return;
  if (present(value, 'argv')) checkArgv(value.argv, `${path}.argv`, issues);
  if (present(value, 'url')) checkUrl(value.url, `${path}.url`, issues, { ...options, allowRelative: false });
  if (present(value, 'ready')) validateReady(value.ready, `${path}.ready`, issues, options);
}

function validateCommands(value, path, issues) {
  if (!checkEach(value, path, issues, (entry, entryPath) => {
    if (!validateClosedObject(entry, COMMAND_KEYS, entryPath, issues)) return;
    if (present(entry, 'name')) checkName(entry.name, `${entryPath}.name`, issues);
    if (present(entry, 'argv')) checkArgv(entry.argv, `${entryPath}.argv`, issues);
  })) return;
  checkUnique(value, path, issues, (entry) => (typeof entry?.name === 'string' ? entry.name : null), '.name');
}

function validateMeasurements(value, path, issues) {
  if (!checkEach(value, path, issues, (entry, entryPath) => {
    if (!validateClosedObject(entry, MEASUREMENT_KEYS, entryPath, issues)) return;
    if (present(entry, 'name')) checkName(entry.name, `${entryPath}.name`, issues);
    if (present(entry, 'unit')) checkText(entry.unit, `${entryPath}.unit`, issues, { singleLine: true });
    if (present(entry, 'budget')) checkInteger(entry.budget, `${entryPath}.budget`, issues, { min: 0 });
    if (present(entry, 'direction')) checkEnum(entry.direction, MEASUREMENT_DIRECTIONS, `${entryPath}.direction`, issues);
  })) return;
  checkUnique(value, path, issues, (entry) => (typeof entry?.name === 'string' ? entry.name : null), '.name');
}

function validateHosts(value, path, issues, sorted) {
  const ok = checkEach(value, path, issues, (entry, entryPath) => {
    if (typeof entry !== 'string' || entry.length > 253 || !HOST_PATTERN.test(entry)) {
      issue(issues, entryPath, 'invalid_format', 'must be a lower-case host name without scheme, port or path');
    }
  });
  if (ok) checkSet(value, path, issues, { sorted });
}

function validatePolicyRules(value, issues) {
  if (!present(value, 'policy') || !VERIFICATION_POLICIES.includes(value.policy)) return;
  const live = value.policy === 'live' || value.policy === 'measured';
  if (present(value, 'launch')) {
    if (live && value.launch === null) issue(issues, '$.launch', 'invalid_value', `a ${value.policy} contract needs a launch`);
    if (!live && value.launch !== null) issue(issues, '$.launch', 'invalid_value', `a ${value.policy} contract starts nothing; launch must be null`);
  }
  if (!live && Array.isArray(value.scenario) && value.scenario.length > 0) {
    issue(issues, '$.scenario', 'invalid_value', `a ${value.policy} contract runs no scenario`);
  }
  if (Array.isArray(value.measurements)) {
    if (value.policy === 'measured' && value.measurements.length === 0) {
      issue(issues, '$.measurements', 'invalid_value', 'a measured contract declares at least one measurement');
    }
    if (!live && value.measurements.length > 0) {
      issue(issues, '$.measurements', 'invalid_value', `a ${value.policy} contract takes no measurements`);
    }
  }
}

export function validateVerification(value, options = {}) {
  const form = resolveForm(options, ['stored', 'input']);
  const sorted = form === 'stored';
  const issues = [];
  if (!validateClosedObject(value, sorted ? VERIFICATION_KEYS : VERIFICATION_INPUT_KEYS, '$', issues)) {
    return validationResult(issues);
  }
  if (present(value, 'schema')) checkSchemaValue(value.schema, VERIFICATION_SCHEMA, '$.schema', issues);
  if (present(value, 'plan')) checkId(value.plan, '$.plan', issues);
  if (present(value, 'roads')) checkIdSet(value.roads, '$.roads', issues, { sorted, nonEmpty: true });
  if (present(value, 'policy')) checkEnum(value.policy, VERIFICATION_POLICIES, '$.policy', issues);
  if (present(value, 'reads')) validateReadList(value.reads, '$.reads', issues);
  const allowedHosts = Array.isArray(value.allowed_hosts)
    ? value.allowed_hosts.filter((entry) => typeof entry === 'string').map((entry) => entry.toLowerCase())
    : [];
  const urlOptions = { allowedHosts, sorted };
  if (present(value, 'launch')) validateLaunch(value.launch, '$.launch', issues, urlOptions);
  if (present(value, 'setup')) validateCommands(value.setup, '$.setup', issues);
  if (present(value, 'teardown')) validateCommands(value.teardown, '$.teardown', issues);
  if (present(value, 'acceptance')) checkTextList(value.acceptance, '$.acceptance', issues);
  if (present(value, 'measurements')) validateMeasurements(value.measurements, '$.measurements', issues);
  if (present(value, 'evidence_types')) {
    if (checkEach(value.evidence_types, '$.evidence_types', issues, (entry, path) => checkEnum(entry, EVIDENCE_TYPES, path, issues))) {
      checkSet(value.evidence_types, '$.evidence_types', issues, { sorted });
    }
  }
  if (present(value, 'reachability')) checkTextList(value.reachability, '$.reachability', issues);
  if (present(value, 'boundaries')) checkTextList(value.boundaries, '$.boundaries', issues);
  if (present(value, 'timeout_ms')) validateTimeout(value.timeout_ms, '$.timeout_ms', issues);
  if (present(value, 'allowed_hosts')) validateHosts(value.allowed_hosts, '$.allowed_hosts', issues, sorted);
  if (present(value, 'scenario')) {
    checkEach(value.scenario, '$.scenario', issues, (entry, path) => validateScenarioStep(entry, path, issues, urlOptions));
  }
  validatePolicyRules(value, issues);
  if (sorted && present(value, 'meta')) validateMeta(value.meta, '$.meta', issues);
  return validationResult(issues);
}

// ---- run record ---------------------------------------------------------------------------------------------
function validateRunStep(value, path, issues, index, evidenceOptions) {
  if (!validateClosedObject(value, RUN_STEP_KEYS, path, issues)) return;
  if (present(value, 'index') && checkInteger(value.index, `${path}.index`, issues, { min: 0 }) && value.index !== index) {
    issue(issues, `${path}.index`, 'invalid_value', `step indexes are consecutive from 0; expected ${index}`);
  }
  if (present(value, 'step') && (typeof value.step !== 'string' || !SCENARIO_STEPS.includes(value.step))) {
    issue(issues, `${path}.step`, 'unknown_step', `unknown step; the vocabulary is: ${SCENARIO_STEPS.join(', ')}`);
  }
  if (present(value, 'status')) checkEnum(value.status, RUN_STEP_STATUSES, `${path}.status`, issues);
  if (present(value, 'soft')) checkBoolean(value.soft, `${path}.soft`, issues);
  if (present(value, 'duration_ms')) checkInteger(value.duration_ms, `${path}.duration_ms`, issues, { min: 0 });
  if (present(value, 'detail')) checkText(value.detail, `${path}.detail`, issues, { nullable: true });
  if (present(value, 'evidence')) validateEvidenceList(value.evidence, `${path}.evidence`, issues, { ...evidenceOptions, sorted: true });
}

export function validateRun(value, options = {}) {
  resolveForm(options, ['stored']);
  const workflowRoot = resolveWorkflowRoot(options);
  const issues = [];
  if (!validateClosedObject(value, RUN_KEYS, '$', issues)) return validationResult(issues);
  if (present(value, 'schema')) checkSchemaValue(value.schema, RUN_SCHEMA, '$.schema', issues);
  if (present(value, 'id')) checkUlid(value.id, '$.id', issues);
  const planOk = present(value, 'plan') && checkId(value.plan, '$.plan', issues);
  const evidenceOptions = { plan: planOk ? value.plan : null, workflowRoot };
  if (present(value, 'snapshot')) checkSha(value.snapshot, '$.snapshot', issues);
  if (present(value, 'contract_hash')) checkSha(value.contract_hash, '$.contract_hash', issues);
  if (present(value, 'started_at')) checkTimestamp(value.started_at, '$.started_at', issues);
  if (present(value, 'ended_at')) checkTimestamp(value.ended_at, '$.ended_at', issues);
  if (typeof value.started_at === 'string' && typeof value.ended_at === 'string' && value.ended_at < value.started_at
    && !issues.some((entry) => entry.path === '$.started_at' || entry.path === '$.ended_at')) {
    issue(issues, '$.ended_at', 'invalid_value', 'a run cannot end before it starts');
  }
  const statusOk = present(value, 'status') && checkEnum(value.status, RUN_STATUSES, '$.status', issues);
  if (statusOk && Array.isArray(value.steps)) {
    const hardFailure = value.steps.some((entry) => isPlainObject(entry) && entry.status === 'failed' && entry.soft === false);
    if (value.status === 'passed' && hardFailure) {
      issue(issues, '$.status', 'invalid_value', 'a passed run has no failed hard (soft: false) step');
    } else if (value.status === 'failed' && !hardFailure) {
      issue(issues, '$.status', 'invalid_value', 'a failed run has at least one failed hard (soft: false) step');
    }
  }
  if (present(value, 'steps')) {
    checkEach(value.steps, '$.steps', issues, (entry, path) => validateRunStep(entry, path, issues, Number(/\[(\d+)\]$/.exec(path)[1]), evidenceOptions));
  }
  if (present(value, 'evidence')) validateEvidenceList(value.evidence, '$.evidence', issues, { ...evidenceOptions, sorted: true });
  if (present(value, 'meta')) validateMeta(value.meta, '$.meta', issues);
  return validationResult(issues);
}
