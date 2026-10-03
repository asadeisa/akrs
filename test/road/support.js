// Shared helpers for the P1-W06 Road and Task writer tests: a clean temp repository with source files, canonical
// Road seeding that does not depend on the code under test, deterministic providers, byte-tree digests, and a
// catalog check that every emitted finding detail fits its documented data_schema.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runCliAdapter } from '../../bin/cli-adapter.js';
import { commandManifest } from '../../lib/commands/manifest.js';
import { commandHandlers } from '../../lib/commands/meta.js';
import { getFindingDefinition } from '../../lib/findings/catalog.js';
import { ROAD_SPEC } from '../../lib/schemas/road.js';
import { canonicalizeJson, storedSpec, withMeta } from '../../lib/store/canonical/index.js';
import { createTempRepository } from '../helpers/temp-repository.js';
import { fakeProviders, ulid } from '../idempotency/support.js';
import { treeDigest } from '../transactions/support.js';

export { fakeProviders, treeDigest, ulid };
export const KNOWN_COMMANDS = commandManifest.commands.map(({ id }) => id);
export const GENERATOR = 'akrs/2.0.0-alpha.0';

const lines = (count, prefix) => `${Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n')}\n`;

// Product files every Road below may read. SOT/09-use-cases.md has 50 lines.
export const SOURCE_FILES = Object.freeze({
  'SOT/09-use-cases.md': lines(50, 'use-case line'),
  'SOT/02-rules.md': lines(10, 'rule line'),
  'app/config/payment-status.ts': lines(30, 'status line'),
  'src/own.js': lines(5, 'own line'),
  'akrs/.gitkeep': '',
});

export async function createRepo(testContext, { files = {} } = {}) {
  const repository = await createTempRepository(testContext, { prefix: 'akrs-road-' });
  for (const [path, content] of Object.entries({ ...SOURCE_FILES, ...files })) await repository.write(path, content);
  return {
    ...repository,
    options: { repositoryRoot: repository.root, workflowRoot: repository.path('akrs') },
    read: (path) => readFile(repository.path(path), 'utf8'),
    digest: (exclude) => treeDigest(repository, exclude === undefined ? undefined : { exclude }),
  };
}

// A complete, valid Road INPUT document (no `status`, no `meta`).
export function roadInput(overrides = {}) {
  return {
    schema: 'akrs.road/v1',
    id: 'R-P6-1',
    plan: 'P6',
    task: 'T-P6-1',
    deps: [],
    reads: [
      { path: 'SOT/09-use-cases.md', lines: [28, 41], why: 'canonical paid-state rule' },
      { path: 'SOT/02-rules.md', lines: [2, 4], why: null },
    ],
    writes: [{ path: 'app/pages/admin.vue', class: 'file', action: 'create' }],
    forbidden: ['server/**'],
    checks: [{ name: 'unit', argv: ['npm', 'test', '--', 'admin.spec.ts'], timeout_ms: 120000 }],
    acceptance: ['The declared user path works from the committed build.'],
    boundaries: ['No backend route change.'],
    on_landing: null,
    complexity: 3,
    executor_class: 'weak',
    steps: ['Create app/pages/admin.vue with the admin route.', 'Run the unit check.'],
    scope_policy: { auto_reads: [], auto_writes: [] },
    oversize_reason: null,
    ...overrides,
  };
}

// The same document, shaped as the CLI stores it: status QUEUED plus meta.
export function storedRoad(input) {
  return withMeta({ ...input, status: 'QUEUED' }, { schema: 'akrs.road/v1', generator: GENERATOR, spec: ROAD_SPEC });
}

export const roadText = (stored) => canonicalizeJson(stored, storedSpec(ROAD_SPEC));

// Writes a canonical Road file without going through the writer under test.
export async function seedRoad(repo, input, { folder = 'roads', status = 'QUEUED' } = {}) {
  const complete = roadInput({ plan: null, task: null, ...input });
  const stored = withMeta({ ...complete, status }, { schema: 'akrs.road/v1', generator: GENERATOR, spec: ROAD_SPEC });
  const path = `akrs/${folder}/${complete.id}.json`;
  await repo.write(path, roadText(stored));
  return path;
}

export const seedPlan = (repo, id) => repo.write(`akrs/plans/${id}.json`, `${JSON.stringify({
  schema: 'akrs.plan/v1', id, title: `Plan ${id}`, questions: [], seams: [],
}, null, 2)}\n`);

export const draftDocument = (repo, name, document) => repo.write(`akrs/drafts/${name}.json`, `${JSON.stringify(document, null, 2)}\n`);

export const pointersOf = (packet) => packet.findings.map(({ detail }) => detail.pointer).filter((pointer) => pointer !== undefined).sort();
export const codesOf = (packet) => [...new Set(packet.findings.map(({ code }) => code))].sort();

// ---- finding detail vs the catalog's data_schema ------------------------------------------------------------------
function conforms(value, schema, path, problems) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  if (!types.includes(actual)) {
    problems.push(`${path}: expected ${types.join('|')}, got ${actual}`);
    return;
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) problems.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (actual === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) problems.push(`${path}.${key}: required`);
    for (const [key, entry] of Object.entries(value)) {
      if (schema.properties?.[key] === undefined) {
        if (schema.additionalProperties === false) problems.push(`${path}.${key}: not allowed`);
      } else {
        conforms(entry, schema.properties[key], `${path}.${key}`, problems);
      }
    }
  }
  if (actual === 'array' && schema.items !== undefined) {
    value.forEach((entry, index) => conforms(entry, schema.items, `${path}[${index}]`, problems));
  }
}

export function assertFindingsMatchCatalog(packet) {
  for (const finding of packet.findings) {
    const definition = getFindingDefinition(finding.code);
    assert.notEqual(definition, null, `${finding.code} is in the catalog`);
    const problems = [];
    conforms(finding.detail, definition.data_schema, 'detail', problems);
    assert.deepEqual(problems, [], `${finding.code} detail matches its data_schema: ${JSON.stringify(finding.detail)}`);
  }
}

export const authoringOptions = (repo, extra = {}) => ({
  ...repo.options,
  providers: fakeProviders(),
  knownCommands: KNOWN_COMMANDS,
  ...extra,
});

// ---- in-process CLI -------------------------------------------------------------------------------------------
// Runs one argv through the real adapter, manifest and handlers (no child process). `stdin` feeds `--json -`.
export function runCommand(repo, argv, { stdin, providers = fakeProviders(), cwd = repo.root, root = true } = {}) {
  return runCliAdapter({
    argv: [...argv, ...(!root || argv.includes('--root') ? [] : ['--root', repo.root])],
    cwd,
    manifest: commandManifest,
    handlers: commandHandlers,
    providers,
    readStdin: async () => (stdin === undefined ? Buffer.alloc(0) : Buffer.from(stdin)),
  });
}

// The root overrides a retry command carries so that it runs against the same workflow.
export function stripRoots(args) {
  const kept = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root' || args[index] === '--workflow-root') index += 1;
    else kept.push(args[index]);
  }
  return kept;
}
