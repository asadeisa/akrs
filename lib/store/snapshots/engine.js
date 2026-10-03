// F5 snapshot engine (P1-W02): hashes the declared inputs of a projection list, deterministically.
//
// - An inventory lists one entry per input: { projection, key, kind, value }. Values are content hashes or the
//   SNAPSHOT_VALUE_TOKENS tokens (or a Road status); file contents never enter the inventory.
// - The snapshot is sha256 over the compact JSON of { schema, projections, entries } where the objects are built
//   with a fixed key order and entries are sorted by (projection, key) code units, so it is deterministic
//   without a canonical spec.
// - Reads are lenient: only the fields a projection needs are read from Road/contract JSON, never schema-validated.
// - Consistency: the inventory is collected twice and compared; on a mismatch it is collected again and compared
//   with the previous round, up to `maxAttempts` comparison rounds, otherwise the result is `unstable`.
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { compareStrings, isId } from '../../schemas/common.js';
import { classifyPath, pathOverlap } from '../../schemas/glob.js';
import { contentHash, parseStrictJson } from '../canonical/index.js';
import { PathSafetyError, createPathService } from '../path-service.js';
import {
  COMMAND_SNAPSHOT_TABLE,
  EMPTY_SNAPSHOT,
  SNAPSHOT_PROJECTIONS,
} from './projections.js';

const MATERIAL_SCHEMA = 'akrs.snapshot-material/v1';
const ROAD_STATUSES = ['QUEUED', 'ACTIVE', 'DONE'];
const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const sha256 = (buffer) => `sha256:${createHash('sha256').update(buffer).digest('hex')}`;

// Text normalization (PRODUCT_INPUT_POLICY.text_normalization): valid UTF-8 without NUL is hashed with CRLF -> LF.
function decodeText(bytes) {
  if (bytes.includes(0)) return null;
  try {
    return DECODER.decode(bytes);
  } catch {
    return null;
  }
}

function hashBytes(bytes) {
  const text = decodeText(bytes);
  return text === null ? sha256(bytes) : sha256(Buffer.from(text.replaceAll('\r\n', '\n'), 'utf8'));
}

const hashText = (text) => sha256(Buffer.from(text, 'utf8'));

const isMissingError = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

function splitLines(text) {
  if (text === '') return [];
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function parseJsonObject(bytes) {
  const text = decodeText(bytes);
  if (text === null) return undefined;
  const result = parseStrictJson(text);
  if (!result.ok || result.value === null || typeof result.value !== 'object' || Array.isArray(result.value)) {
    return undefined;
  }
  return result.value;
}

// ---- collection context -----------------------------------------------------------------------------------
function createContext({ paths, io }) {
  const workflow = paths.workflow_relative_path;
  const inventory = new Map();
  const reads = new Map();
  return {
    paths,
    io,
    workflow,
    repositoryRoot: paths.repository_root,
    inventory,
    reads,
    roadIndex: null,
    parsedRoads: new Map(),
    inWorkflow: (path) => (workflow === '' ? path : `${workflow}/${path}`),
  };
}

function add(ctx, projection, key, kind, value, unresolved = false) {
  const id = `${projection}\u0000${key}`;
  if (ctx.inventory.has(id)) return;
  ctx.inventory.set(id, { projection, key, kind, value, unresolved });
}

const absolute = (ctx, path) => (path === '' ? ctx.repositoryRoot : join(ctx.repositoryRoot, ...path.split('/')));

// One read per path per collection round; the hook runs after the bytes were read.
function readBytes(ctx, path) {
  if (!ctx.reads.has(path)) {
    ctx.reads.set(path, (async () => {
      let outcome;
      try {
        outcome = { state: 'ok', bytes: await readFile(absolute(ctx, path)) };
      } catch (error) {
        if (isMissingError(error)) return { state: 'missing' };
        if (error?.code === 'EISDIR') return { state: 'not_file' };
        throw error;
      }
      await ctx.io.afterRead?.(path);
      return outcome;
    })());
  }
  return ctx.reads.get(path);
}

// ---- walking --------------------------------------------------------------------------------------------
function isExcludedPath(ctx, path) {
  const prefix = ctx.workflow === '' ? '' : `${ctx.workflow}/`;
  if (!path.startsWith(prefix)) return false;
  const inside = path.slice(prefix.length).split('/');
  if (['.cache', '.ops', 'drafts'].includes(inside[0])) return true;
  return inside[0] === 'verifications' && inside[2] === 'evidence';
}

// Files beneath `start` (a repo-relative path, '' for the repository root), sorted, skipping symlinks, any `.git`
// segment, excluded namespaces, and the whole workflow root unless the walk starts inside it.
async function walkFiles(ctx, start) {
  let physical;
  if (start === '') {
    physical = ctx.repositoryRoot;
  } else {
    try {
      physical = (await ctx.paths.resolveRepositoryPath(start)).filesystem_path;
    } catch (error) {
      if (error instanceof PathSafetyError) return { unsafe: true, files: [] };
      throw error;
    }
  }
  let metadata;
  try {
    metadata = await lstat(physical);
  } catch (error) {
    if (isMissingError(error)) return { unsafe: false, files: [] };
    throw error;
  }
  if (metadata.isSymbolicLink()) return { unsafe: false, files: [] };
  if (metadata.isFile()) return { unsafe: false, files: [start] };
  if (!metadata.isDirectory()) return { unsafe: false, files: [] };
  const insideWorkflow = ctx.workflow === '' || start === ctx.workflow || start.startsWith(`${ctx.workflow}/`);
  const files = [];
  async function walk(directory, relative) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingError(error)) return;
      throw error;
    }
    entries.sort((left, right) => compareStrings(left.name, right.name));
    for (const entry of entries) {
      if (entry.name === '.git' || entry.isSymbolicLink()) continue;
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (!insideWorkflow && ctx.workflow !== '' && child === ctx.workflow) continue;
      if (isExcludedPath(ctx, child)) continue;
      if (entry.isDirectory()) await walk(join(directory, entry.name), child);
      else if (entry.isFile()) files.push(child);
    }
  }
  await walk(physical, start);
  return { unsafe: false, files };
}

async function hashedFile(ctx, projection, path, { kind = 'file', optional = true } = {}) {
  const file = await readBytes(ctx, path);
  if (file.state === 'ok') add(ctx, projection, path, kind, hashBytes(file.bytes));
  else add(ctx, projection, path, kind, file.state, file.state === 'not_file' || !optional);
}

async function namespaceWalk(ctx, projection, namespace) {
  const start = ctx.inWorkflow(namespace);
  const walked = await walkFiles(ctx, start);
  if (walked.unsafe) add(ctx, projection, start, 'file', 'unsafe', true);
  for (const path of walked.files) await hashedFile(ctx, projection, path);
}

// A declared singleton: containment checked by the path service, absent is legitimate.
async function singletonFile(ctx, projection, path, options) {
  let resolved;
  try {
    resolved = await ctx.paths.resolveRepositoryPath(path);
  } catch (error) {
    if (!(error instanceof PathSafetyError)) throw error;
    add(ctx, projection, path, 'file', 'unsafe', true);
    return;
  }
  if (!resolved.case_matches) {
    add(ctx, projection, path, 'file', 'case_mismatch', true);
    return;
  }
  await hashedFile(ctx, projection, path, options);
}

async function verificationsWalk(ctx) {
  const root = ctx.inWorkflow('verifications');
  let rootPhysical;
  try {
    rootPhysical = (await ctx.paths.resolveRepositoryPath(root)).filesystem_path;
  } catch (error) {
    if (!(error instanceof PathSafetyError)) throw error;
    add(ctx, 'verifications', root, 'file', 'unsafe', true);
    return;
  }
  let entries;
  try {
    entries = await readdir(rootPhysical, { withFileTypes: true });
  } catch (error) {
    if (isMissingError(error)) return;
    throw error;
  }
  entries.sort((left, right) => compareStrings(left.name, right.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const name of ['contract.json', 'handoff.jsonl', 'results.jsonl']) {
      const path = `${root}/${entry.name}/${name}`;
      let metadata;
      try {
        metadata = await lstat(absolute(ctx, path));
      } catch (error) {
        if (isMissingError(error)) continue;
        throw error;
      }
      if (metadata.isFile()) await hashedFile(ctx, 'verifications', path);
    }
  }
}

// ---- Roads ---------------------------------------------------------------------------------------------
async function indexRoads(ctx) {
  if (ctx.roadIndex === null) {
    const index = new Map();
    const walked = await walkFiles(ctx, ctx.inWorkflow('roads'));
    for (const path of walked.files) {
      if (!path.endsWith('.json')) continue;
      const id = basename(path).slice(0, -'.json'.length);
      if (!index.has(id)) index.set(id, []);
      index.get(id).push(path);
    }
    ctx.roadIndex = index;
  }
  return ctx.roadIndex;
}

// { state: 'missing' | 'ambiguous' | 'found', path?, json? (undefined when unparseable) }
async function loadRoad(ctx, id) {
  const index = await indexRoads(ctx);
  const paths = index.get(id) ?? [];
  if (paths.length === 0) return { state: 'missing' };
  if (paths.length > 1) return { state: 'ambiguous' };
  const [path] = paths;
  if (!ctx.parsedRoads.has(path)) {
    const file = await readBytes(ctx, path);
    ctx.parsedRoads.set(path, file.state === 'ok'
      ? { state: 'found', path, bytes: file.bytes, json: parseJsonObject(file.bytes) }
      : { state: 'missing' });
  }
  return ctx.parsedRoads.get(path);
}

// ---- declared reads / writes -----------------------------------------------------------------------------
function readDeclarations(value) {
  if (!Array.isArray(value)) return null;
  const declarations = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || typeof item.path !== 'string') return null;
    const { lines } = item;
    if (lines === null || lines === undefined) {
      declarations.push({ path: item.path, lines: null });
    } else if (Array.isArray(lines) && lines.length === 2 && Number.isInteger(lines[0]) && Number.isInteger(lines[1])
      && lines[0] >= 1 && lines[0] <= lines[1]) {
      declarations.push({ path: item.path, lines: [lines[0], lines[1]] });
    } else {
      return null;
    }
  }
  return declarations;
}

function writeDeclarations(value) {
  if (!Array.isArray(value)) return null;
  const declarations = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || typeof item.path !== 'string'
      || !['file', 'dir', 'glob', 'ephemeral'].includes(item.class)) return null;
    declarations.push({ path: item.path, class: item.class });
  }
  return declarations;
}

function ownWritePatterns(writes) {
  const patterns = [];
  for (const { path, class: pathClass } of writes) {
    if (pathClass === 'dir') patterns.push(`${path}/**`);
    else if (pathClass === 'ephemeral') patterns.push(path, `${path}/**`);
    else patterns.push(path);
  }
  return patterns;
}

const withinOwnWrites = (patterns, path) => patterns.some((pattern) => pathOverlap(path, pattern) === 'overlap');

async function windowEntries(ctx, projection, declarations, patterns) {
  for (const { path, lines } of declarations) {
    const windowKey = lines === null ? path : `${path}#L${lines[0]}-${lines[1]}`;
    const kind = lines === null ? 'file' : 'window';
    let resolved;
    try {
      resolved = await ctx.paths.resolveRepositoryPath(path);
    } catch (error) {
      if (!(error instanceof PathSafetyError)) throw error;
      add(ctx, projection, path, kind, 'unsafe', true);
      continue;
    }
    if (!resolved.case_matches) {
      add(ctx, projection, windowKey, kind, 'case_mismatch', true);
      continue;
    }
    if (withinOwnWrites(patterns, path)) continue;
    if (!resolved.exists) {
      add(ctx, projection, windowKey, kind, 'missing', true);
      continue;
    }
    const metadata = await stat(resolved.filesystem_path);
    if (metadata.isDirectory()) {
      if (lines !== null) {
        add(ctx, projection, windowKey, kind, 'not_file', true);
        continue;
      }
      const walked = await walkFiles(ctx, path);
      for (const file of walked.files) {
        if (!withinOwnWrites(patterns, file)) await hashedFile(ctx, projection, file, { optional: true });
      }
      continue;
    }
    const file = await readBytes(ctx, path);
    if (file.state !== 'ok') {
      add(ctx, projection, windowKey, kind, file.state, true);
    } else if (lines === null) {
      add(ctx, projection, windowKey, kind, hashBytes(file.bytes));
    } else {
      const text = decodeText(file.bytes);
      if (text === null) {
        add(ctx, projection, windowKey, kind, 'not_text', true);
        continue;
      }
      const all = splitLines(text);
      if (lines[1] > all.length) add(ctx, projection, windowKey, kind, 'out_of_range', true);
      else add(ctx, projection, windowKey, kind, hashText(all.slice(lines[0] - 1, lines[1]).join('\n')));
    }
  }
}

function staticPrefix(pattern) {
  const prefix = [];
  for (const segment of pattern.split('/')) {
    if (segment.includes('*') || segment.includes('?')) break;
    prefix.push(segment);
  }
  return prefix.join('/');
}

async function productEntries(ctx, projection, writes, seen) {
  const include = async (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    await hashedFile(ctx, projection, path);
  };
  for (const { path, class: pathClass } of writes) {
    if (pathClass === 'ephemeral') continue;
    if (pathClass === 'glob') {
      const classified = classifyPath(path);
      if (classified.class === 'invalid') {
        add(ctx, projection, path, 'file', 'unsafe', true);
        continue;
      }
      const prefix = staticPrefix(path);
      if (prefix !== '') {
        try {
          await ctx.paths.resolveRepositoryPath(prefix);
        } catch (error) {
          if (!(error instanceof PathSafetyError)) throw error;
          add(ctx, projection, path, 'file', 'unsafe', true);
          continue;
        }
      }
      const walked = await walkFiles(ctx, prefix);
      for (const file of walked.files) {
        if (pathOverlap(file, path) !== 'disjoint') await include(file);
      }
      continue;
    }
    let resolved;
    try {
      resolved = await ctx.paths.resolveRepositoryPath(path);
    } catch (error) {
      if (!(error instanceof PathSafetyError)) throw error;
      add(ctx, projection, path, 'file', 'unsafe', true);
      continue;
    }
    if (!resolved.case_matches) {
      add(ctx, projection, path, 'file', 'case_mismatch', true);
      continue;
    }
    if (pathClass === 'file') {
      await include(path);
      continue;
    }
    const walked = await walkFiles(ctx, path);
    for (const file of walked.files) await include(file);
  }
}

// ---- JSONL records ----------------------------------------------------------------------------------------
async function recordEntries(ctx, projection, path, accepts) {
  let resolved;
  try {
    resolved = await ctx.paths.resolveRepositoryPath(path);
  } catch (error) {
    if (!(error instanceof PathSafetyError)) throw error;
    add(ctx, projection, path, 'file', 'unsafe', true);
    return;
  }
  if (!resolved.case_matches) {
    add(ctx, projection, path, 'file', 'case_mismatch', true);
    return;
  }
  const file = await readBytes(ctx, path);
  if (file.state === 'missing') return;
  if (file.state !== 'ok') {
    add(ctx, projection, path, 'file', file.state, true);
    return;
  }
  const text = decodeText(file.bytes);
  if (text === null) {
    add(ctx, projection, path, 'file', 'not_text', true);
    return;
  }
  let ordinal = 0;
  for (const line of splitLines(text)) {
    if (line.trim() === '') continue;
    const parsed = parseStrictJson(line);
    if (!accepts(parsed.ok ? parsed.value : undefined)) continue;
    ordinal += 1;
    add(ctx, projection, `${path}#${ordinal}`, 'record', hashText(line));
  }
}

// ---- projections ------------------------------------------------------------------------------------------
const ROAD_FIELD_PROJECTIONS = ['road-deps', 'road-handoffs', 'road-reads', 'road-task', 'road-writes'];

async function dependencyStatus(ctx, id) {
  const dep = await loadRoad(ctx, id);
  if (dep.state !== 'found') return dep.state;
  const status = dep.json?.status;
  return ROAD_STATUSES.includes(status) ? status : 'unparseable';
}

async function roadProjections(ctx, wanted, roadId) {
  const requested = (name) => wanted.has(name);
  const road = await loadRoad(ctx, roadId);
  if (road.state !== 'found') {
    for (const name of wanted) add(ctx, name, roadId, 'status', road.state, true);
    return;
  }
  if (requested('road')) add(ctx, 'road', road.path, 'file', hashBytes(road.bytes));
  const fields = road.json;
  if (fields === undefined) {
    for (const name of ROAD_FIELD_PROJECTIONS) {
      if (requested(name)) add(ctx, name, roadId, 'status', 'unparseable', true);
    }
  } else {
    const writes = writeDeclarations(fields.writes ?? []);
    const unparseable = (name) => add(ctx, name, roadId, 'status', 'unparseable', true);

    if (requested('road-deps')) {
      const deps = fields.deps ?? [];
      if (!Array.isArray(deps) || deps.some((dep) => typeof dep !== 'string')) unparseable('road-deps');
      else {
        for (const dep of deps) {
          const status = await dependencyStatus(ctx, dep);
          add(ctx, 'road-deps', dep, 'status', status, !ROAD_STATUSES.includes(status));
        }
      }
    }
    if (requested('road-reads')) {
      const declarations = readDeclarations(fields.reads ?? []);
      if (declarations === null) unparseable('road-reads');
      else await windowEntries(ctx, 'road-reads', declarations, ownWritePatterns(writes ?? []));
    }
    if (requested('road-task')) {
      const task = fields.task ?? null;
      if (task !== null && typeof task !== 'string') {
        unparseable('road-task');
      } else if (task !== null) {
        await singletonFile(ctx, 'road-task', ctx.inWorkflow(`tasks/${task}.md`), { optional: false });
      }
    }
    if (requested('road-writes')) {
      if (writes === null) unparseable('road-writes');
      else await productEntries(ctx, 'road-writes', writes, new Set());
    }
    if (requested('road-handoffs')) {
      const plan = fields.plan ?? roadId;
      if (typeof plan !== 'string') {
        unparseable('road-handoffs');
      } else {
        await recordEntries(ctx, 'road-handoffs', ctx.inWorkflow(`verifications/${plan}/handoff.jsonl`),
          (record) => record?.road === roadId);
      }
    }
  }
  const scopePath = ctx.inWorkflow(`scope/${roadId}.jsonl`);
  if (requested('road-scope-requests')) {
    await recordEntries(ctx, 'road-scope-requests', scopePath, (record) => record?.type === 'request');
  }
  if (requested('road-scope-resolutions')) {
    await recordEntries(ctx, 'road-scope-resolutions', scopePath, (record) => record?.type !== 'request');
  }
}

async function planProjections(ctx, wanted, planId) {
  const requested = (name) => wanted.has(name);
  const verification = `verifications/${planId}`;
  const contractPath = ctx.inWorkflow(`${verification}/contract.json`);
  const marker = (name, value) => add(ctx, name, planId, 'status', value, true);

  if (requested('plan')) await singletonFile(ctx, 'plan', ctx.inWorkflow(`plans/${planId}.json`));
  if (requested('plan-handoffs')) {
    await singletonFile(ctx, 'plan-handoffs', ctx.inWorkflow(`${verification}/handoff.jsonl`));
  }
  if (requested('plan-results')) {
    await singletonFile(ctx, 'plan-results', ctx.inWorkflow(`${verification}/results.jsonl`));
  }

  const needsContract = ['plan-contract', 'plan-product', 'plan-reads', 'plan-roads'].some(requested);
  if (!needsContract) return;
  if (requested('plan-contract')) await singletonFile(ctx, 'plan-contract', contractPath, { optional: false });
  const file = await readBytes(ctx, contractPath);
  const contract = file.state === 'ok' ? parseJsonObject(file.bytes) : undefined;
  const state = file.state !== 'ok' ? 'missing' : contract === undefined ? 'unparseable' : 'ok';

  if (requested('plan-reads')) {
    const declarations = state === 'ok' ? readDeclarations(contract.reads ?? []) : null;
    if (state !== 'ok') marker('plan-reads', state);
    else if (declarations === null) marker('plan-reads', 'unparseable');
    else await windowEntries(ctx, 'plan-reads', declarations, []);
  }
  if (!requested('plan-roads') && !requested('plan-product')) return;
  if (state === 'missing') {
    for (const name of ['plan-roads', 'plan-product']) if (requested(name)) marker(name, 'missing');
    return;
  }
  const ids = new Set();
  const index = await indexRoads(ctx);
  for (const [id, paths] of index) {
    for (const path of paths) {
      const bytes = await readBytes(ctx, path);
      const json = bytes.state === 'ok' ? parseJsonObject(bytes.bytes) : undefined;
      if (json?.plan === planId) ids.add(id);
    }
  }
  if (index.has(planId)) ids.add(planId);
  let malformed = state !== 'ok';
  if (state === 'ok') {
    const listed = contract.roads ?? [];
    if (Array.isArray(listed) && listed.every((id) => typeof id === 'string')) for (const id of listed) ids.add(id);
    else malformed = true;
  }
  if (malformed) {
    for (const name of ['plan-roads', 'plan-product']) if (requested(name)) marker(name, 'unparseable');
  }
  const seen = new Set();
  for (const id of [...ids].sort(compareStrings)) {
    const road = await loadRoad(ctx, id);
    if (road.state !== 'found') {
      if (requested('plan-roads')) add(ctx, 'plan-roads', id, 'status', road.state, true);
      continue;
    }
    if (requested('plan-roads')) add(ctx, 'plan-roads', road.path, 'file', hashBytes(road.bytes));
    if (requested('plan-product')) {
      const writes = road.json === undefined ? null : writeDeclarations(road.json.writes ?? []);
      if (writes === null) add(ctx, 'plan-product', id, 'status', 'unparseable', true);
      else await productEntries(ctx, 'plan-product', writes, seen);
    }
  }
}

async function collect(ctx, projections, target) {
  const wanted = new Set(projections);
  if (wanted.has('executors')) await singletonFile(ctx, 'executors', ctx.inWorkflow('executors.json'));
  if (wanted.has('state')) await singletonFile(ctx, 'state', ctx.inWorkflow('state.json'));
  if (wanted.has('state-render')) await singletonFile(ctx, 'state-render', ctx.inWorkflow('STATE.md'));
  for (const name of ['log', 'memory', 'plans', 'roads', 'scope', 'tasks']) {
    if (wanted.has(name)) await namespaceWalk(ctx, name, name);
  }
  if (wanted.has('verifications')) await verificationsWalk(ctx);

  const roadWanted = new Set(projections.filter((name) => SNAPSHOT_PROJECTIONS[name].scope === 'road'));
  if (roadWanted.size > 0) await roadProjections(ctx, roadWanted, target.road);
  const planWanted = new Set(projections.filter((name) => SNAPSHOT_PROJECTIONS[name].scope === 'plan'));
  if (planWanted.size > 0) await planProjections(ctx, planWanted, target.plan);

  const entries = [...ctx.inventory.values()].sort((left, right) => compareStrings(left.projection, right.projection)
    || compareStrings(left.key, right.key));
  const inventory = entries.map(({ projection, key, kind, value }) => ({ projection, key, kind, value }));
  const unresolved = entries.filter((entry) => entry.unresolved)
    .map(({ projection, key, value }) => ({ projection, key, value }));
  const material = JSON.stringify({
    schema: MATERIAL_SCHEMA,
    projections,
    entries: inventory.map(({ projection, key, kind, value }) => ({ projection, key, kind, value })),
  });
  return { snapshot: contentHash(material), inventory, unresolved };
}

// ---- public API -----------------------------------------------------------------------------------------
function checkProjections(projections, target) {
  if (!Array.isArray(projections)) throw new TypeError('projections must be an array');
  if (target === null || typeof target !== 'object' || Array.isArray(target)) throw new TypeError('target must be an object');
  for (const key of ['road', 'plan']) {
    if (target[key] !== undefined && !isId(target[key])) throw new TypeError(`target.${key} must be a valid ID`);
  }
  for (const name of projections) {
    if (typeof name !== 'string' || !Object.hasOwn(SNAPSHOT_PROJECTIONS, name)) {
      throw new TypeError(`unknown snapshot projection: ${String(name)}`);
    }
    const { engine, scope } = SNAPSHOT_PROJECTIONS[name];
    if (engine !== 'snapshots') throw new TypeError(`projection ${name} is computed by ${engine}, not the snapshot engine`);
    if (scope !== 'global' && target[scope] === undefined) throw new TypeError(`projection ${name} requires target.${scope}`);
  }
  return [...new Set(projections)].sort(compareStrings);
}

export async function computeSnapshot({
  repositoryRoot, workflowRoot, projections, target = {}, io = {}, maxAttempts = 3,
} = {}) {
  const sorted = checkProjections(projections, target);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');
  if (sorted.length === 0) {
    return deepFreeze({
      status: 'ok', snapshot: EMPTY_SNAPSHOT, attempts: 1, projections: [], inventory: [], unresolved: [],
    });
  }
  const paths = await createPathService({ repositoryRoot, workflowRoot });
  const run = () => collect(createContext({ paths, io: io ?? {} }), sorted, target);
  let previous = await run();
  for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
    const next = await run();
    if (next.snapshot === previous.snapshot) {
      return deepFreeze({ status: 'ok', snapshot: next.snapshot, attempts, projections: sorted, inventory: next.inventory, unresolved: next.unresolved });
    }
    previous = next;
  }
  return deepFreeze({
    status: 'unstable',
    snapshot: null,
    attempts: maxAttempts,
    projections: sorted,
    inventory: previous.inventory,
    unresolved: previous.unresolved,
  });
}

export async function commandSnapshot(commandId, {
  repositoryRoot, workflowRoot, target = {}, io = {}, maxAttempts = 3,
} = {}) {
  if (typeof commandId !== 'string' || !Object.hasOwn(COMMAND_SNAPSHOT_TABLE, commandId)) {
    throw new TypeError(`unknown snapshot command: ${String(commandId)}`);
  }
  return computeSnapshot({
    repositoryRoot, workflowRoot, projections: COMMAND_SNAPSHOT_TABLE[commandId].inputs, target, io, maxAttempts,
  });
}

// Read-only commands report one stable measurement as both ends of the snapshot; unstable reads report null.
export async function captureReadSnapshot(commandId, options) {
  const result = await commandSnapshot(commandId, options);
  return deepFreeze({
    status: result.status,
    snapshot: { before: result.snapshot, after: result.snapshot },
    inventory: result.inventory,
    unresolved: result.unresolved,
  });
}
