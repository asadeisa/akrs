import { validateCommandManifest } from '../schemas/command-manifest.js';
import { ContractValidationError } from '../schemas/validation.js';
import { ROOT_OVERRIDE_FLAGS } from '../core/roots.js';
import { MEMORY_NEXT_COMMAND_BUILDERS } from '../store/memory/next-commands.js';
import { AUTHORING_NEXT_COMMAND_BUILDERS } from '../store/roads/next-commands.js';
import { COMMAND_SNAPSHOT_TABLE } from '../store/snapshots/projections.js';

export const OUTPUT_FORMAT_FLAGS = Object.freeze([
  Object.freeze({ name: '--json', value_type: 'boolean', required: false, repeatable: false }),
  Object.freeze({ name: '--jsonl', value_type: 'boolean', required: false, repeatable: false }),
  Object.freeze({ name: '--prompt', value_type: 'boolean', required: false, repeatable: false }),
]);

const snapshotInputs = (id) => [...COMMAND_SNAPSHOT_TABLE[id].inputs];

const metaCommand = ({ id, token, summary }) => ({
  id,
  tokens: [token],
  summary,
  input_schema: `akrs.command-input/${id}/v1`,
  positionals: [],
  flags: OUTPUT_FORMAT_FLAGS.map((flag) => ({ ...flag })),
  required_role: 'any',
  mutability: 'query',
  dry_run: false,
  idempotency: 'not_applicable',
  expected_snapshot: 'not_applicable',
  snapshot_inputs: snapshotInputs(id),
  streaming: 'none',
  output_schema: `akrs.command-output/${id}/v1`,
  statuses: ['ok'],
  exit_codes: [0, 2, 4],
  next_command_builder: 'none',
  mcp_tool: null,
  mcp_action: null,
});

const DRY_RUN_FLAG = Object.freeze({ name: '--dry-run', value_type: 'boolean', required: false, repeatable: false });
const FORCE_FLAG = Object.freeze({ name: '--force', value_type: 'boolean', required: false, repeatable: false });

const ROOT_FLAG = ROOT_OVERRIDE_FLAGS.filter(({ name }) => name === '--root');

const installCommand = ({
  id, summary, flags, exitCodes, idempotency, expectedSnapshot, statuses = ['ok', 'warning', 'noop'],
}) => ({
  id,
  tokens: [id],
  summary,
  input_schema: `akrs.command-input/${id}/v1`,
  positionals: [],
  flags: flags.map((flag) => ({ ...flag })),
  required_role: 'any',
  mutability: 'mutation',
  dry_run: true,
  idempotency,
  expected_snapshot: expectedSnapshot,
  snapshot_inputs: snapshotInputs(id),
  streaming: 'none',
  output_schema: `akrs.command-output/${id}/v1`,
  statuses,
  exit_codes: exitCodes,
  next_command_builder: 'none',
  mcp_tool: null,
  mcp_action: null,
});

const INPUT_FLAG = Object.freeze({ name: '--input', value_type: 'path', required: false, repeatable: false });
const REQUEST_ID_FLAG = Object.freeze({ name: '--request-id', value_type: 'string', required: false, repeatable: false });
const IF_SNAPSHOT_FLAG = Object.freeze({ name: '--if-snapshot', value_type: 'string', required: false, repeatable: false });
const CLASS_FLAG = Object.freeze({ name: '--class', value_type: 'string', required: false, repeatable: false });
const AGAIN_FLAG = Object.freeze({ name: '--again', value_type: 'boolean', required: false, repeatable: false });
const TO_DRAFT_FLAG = Object.freeze({ name: '--to-draft', value_type: 'string', required: false, repeatable: false });

// P1-W06: `road new` and `task new`: Leader creates, one input document through `--input` (a draft) or `--json -`,
// full proposed state revalidated under the lock (hence `revalidate`; `--if-snapshot` is the explicit guard).
const authoringWriter = ({ id, tokens, summary, mcpAction, extraFlags = [] }) => ({
  id,
  tokens,
  summary,
  input_schema: `akrs.command-input/${id}/v1`,
  positionals: [],
  flags: [
    INPUT_FLAG, DRY_RUN_FLAG, REQUEST_ID_FLAG, IF_SNAPSHOT_FLAG, ...extraFlags,
    ...ROOT_OVERRIDE_FLAGS, ...OUTPUT_FORMAT_FLAGS,
  ].map((flag) => ({ ...flag })),
  required_role: 'leader',
  mutability: 'mutation',
  dry_run: true,
  idempotency: 'journal',
  expected_snapshot: 'revalidate',
  snapshot_inputs: snapshotInputs(id),
  streaming: 'none',
  output_schema: `akrs.command-output/${id}/v1`,
  statuses: ['ok', 'warning', 'error', 'blocked', 'noop'],
  exit_codes: [0, 1, 2, 3, 4],
  next_command_builder: id,
  mcp_tool: 'akrs_write',
  mcp_action: mcpAction,
});

const manifest = {
  schema_version: 'akrs.command-manifest/v1',
  commands: [
    metaCommand({
      id: 'help',
      token: '--help',
      summary: 'Show manifest-backed command help.',
    }),
    metaCommand({
      id: 'version',
      token: '--version',
      summary: 'Show CLI, doctrine, and schema versions.',
    }),
    {
      id: 'validate',
      tokens: ['validate'],
      summary: 'Validate with explicit coverage and stable findings.',
      input_schema: 'akrs.command-input/validate/v1',
      positionals: [],
      flags: [
        ...ROOT_OVERRIDE_FLAGS.map((flag) => ({ ...flag })),
        ...OUTPUT_FORMAT_FLAGS.map((flag) => ({ ...flag })),
      ],
      required_role: 'any',
      mutability: 'query',
      dry_run: false,
      idempotency: 'not_applicable',
      expected_snapshot: 'not_applicable',
      snapshot_inputs: snapshotInputs('validate'),
      streaming: 'none',
      output_schema: 'akrs.command-output/validate/v1',
      statuses: ['ok', 'warning', 'error'],
      exit_codes: [0, 1, 2, 3, 4],
      next_command_builder: 'none',
      mcp_tool: 'akrs_status',
      mcp_action: 'validate',
    },
    {
      id: 'explain',
      tokens: ['explain'],
      summary: 'Explain one permanent finding code.',
      input_schema: 'akrs.command-input/explain/v1',
      positionals: [{ name: 'code', required: true, variadic: false }],
      flags: OUTPUT_FORMAT_FLAGS.map((flag) => ({ ...flag })),
      required_role: 'any',
      mutability: 'query',
      dry_run: false,
      idempotency: 'not_applicable',
      expected_snapshot: 'not_applicable',
      snapshot_inputs: snapshotInputs('explain'),
      streaming: 'none',
      output_schema: 'akrs.command-output/explain/v1',
      statuses: ['ok'],
      exit_codes: [0, 2, 4],
      next_command_builder: 'none',
      mcp_tool: 'akrs_status',
      mcp_action: 'explain',
    },
    installCommand({
      id: 'init',
      summary: 'Install the packaged doctrine into docs/akrs; replace an existing copy only with --force.',
      flags: [...ROOT_FLAG, DRY_RUN_FLAG, FORCE_FLAG, ...OUTPUT_FORMAT_FLAGS],
      exitCodes: [0, 1, 2, 4],
      idempotency: 'journal',
      expectedSnapshot: 'revalidate',
    }),
    installCommand({
      id: 'sync',
      summary: 'Refresh docs/akrs from the packaged doctrine, preserving local edits.',
      flags: [...ROOT_FLAG, DRY_RUN_FLAG, ...OUTPUT_FORMAT_FLAGS],
      exitCodes: [0, 1, 2, 4],
      idempotency: 'journal',
      expectedSnapshot: 'revalidate',
    }),
    installCommand({
      id: 'postinstall',
      summary: 'Sync docs/akrs after a dependency install; never overwrites local edits and always exits 0.',
      flags: OUTPUT_FORMAT_FLAGS,
      exitCodes: [0],
      idempotency: 'none',
      expectedSnapshot: 'not_applicable',
      statuses: ['ok', 'warning', 'error', 'noop'],
    }),
    authoringWriter({
      id: 'road-new',
      tokens: ['road', 'new'],
      summary: 'Create a Road from an input document (--input draft or --json -); the draft is removed on success.',
      mcpAction: 'road_new',
    }),
    authoringWriter({
      id: 'task-new',
      tokens: ['task', 'new'],
      summary: 'Scaffold the narrative Task of an existing Road from an input document (--input draft or --json -).',
      mcpAction: 'task_new',
    }),
    // P1-W08: `memory add` appends one validated record; an exact duplicate is a noop that offers `--again`.
    authoringWriter({
      id: 'memory-add',
      tokens: ['memory', 'add'],
      summary: 'Append one validated Memory record (--input draft or --json -); an exact duplicate is a noop unless --again.',
      mcpAction: 'memory_add',
      extraFlags: [AGAIN_FLAG],
    }),
    // A query: `--to-draft <name>` is its one declared scratch write (a draft, excluded from snapshots and outside
    // the transaction namespace), see TEMPLATE_DRAFT_POLICY. One entry, no separate command ID.
    {
      id: 'template',
      tokens: ['template'],
      summary: 'Show the skeleton and field guide of a template kind; --to-draft <name> saves the skeleton as a draft.',
      input_schema: 'akrs.command-input/template/v1',
      positionals: [{ name: 'kind', required: true, variadic: false }],
      flags: [CLASS_FLAG, TO_DRAFT_FLAG, ...ROOT_OVERRIDE_FLAGS, ...OUTPUT_FORMAT_FLAGS].map((flag) => ({ ...flag })),
      required_role: 'any',
      mutability: 'query',
      dry_run: false,
      idempotency: 'not_applicable',
      expected_snapshot: 'not_applicable',
      snapshot_inputs: snapshotInputs('template'),
      streaming: 'none',
      output_schema: 'akrs.command-output/template/v1',
      statuses: ['ok', 'error'],
      exit_codes: [0, 1, 2, 3, 4],
      next_command_builder: 'template',
      mcp_tool: 'akrs_road',
      mcp_action: 'template',
    },
  ],
};

const reservedScopeCommand = ({ id, token, mutability, positionals, flags, inputSchema }) => ({
  id,
  tokens: ['scope', token],
  owner_packet: 'P1-W07',
  mutability,
  positionals,
  flags,
  input_schema: inputSchema,
  store: 'scope/{road}.jsonl',
});

const reasonFlag = (required) => ({ name: '--reason', value_type: 'string', required, repeatable: false });
const targetPositional = { name: 'target', required: true, variadic: false };

// F14 (A1): frozen before P1-W07 ships the handlers; not dispatched and not listed in help until then.
// `target` is a Road ID when exactly one request is pending on it, otherwise a request ID.
manifest.reserved_commands = [
  reservedScopeCommand({
    id: 'scope-request',
    token: 'request',
    mutability: 'mutation',
    positionals: [],
    flags: [{ name: '--input', value_type: 'path', required: true, repeatable: false }, ...OUTPUT_FORMAT_FLAGS],
    inputSchema: 'akrs.scope-request/v1',
  }),
  reservedScopeCommand({
    id: 'scope-approve',
    token: 'approve',
    mutability: 'mutation',
    positionals: [targetPositional],
    flags: [reasonFlag(false), ...OUTPUT_FORMAT_FLAGS],
    inputSchema: null,
  }),
  reservedScopeCommand({
    id: 'scope-reject',
    token: 'reject',
    mutability: 'mutation',
    positionals: [targetPositional],
    flags: [reasonFlag(true), ...OUTPUT_FORMAT_FLAGS],
    inputSchema: null,
  }),
  reservedScopeCommand({
    id: 'scope-list',
    token: 'list',
    mutability: 'query',
    positionals: [{ name: 'road', required: false, variadic: false }],
    flags: OUTPUT_FORMAT_FLAGS,
    inputSchema: null,
  }),
];

const result = validateCommandManifest(manifest);
if (!result.ok) throw new ContractValidationError('command manifest', result.issues);

function freezeEntry(entry) {
  return Object.freeze({
    ...entry,
    tokens: Object.freeze([...entry.tokens]),
    positionals: Object.freeze(entry.positionals.map((value) => Object.freeze({ ...value }))),
    flags: Object.freeze(entry.flags.map((value) => Object.freeze({ ...value }))),
    snapshot_inputs: Object.freeze([...entry.snapshot_inputs]),
    statuses: Object.freeze([...entry.statuses]),
    exit_codes: Object.freeze([...entry.exit_codes]),
  });
}

function freezeReserved(entry) {
  return Object.freeze({
    ...entry,
    tokens: Object.freeze([...entry.tokens]),
    positionals: Object.freeze(entry.positionals.map((value) => Object.freeze({ ...value }))),
    flags: Object.freeze(entry.flags.map((value) => Object.freeze({ ...value }))),
  });
}

export const commandManifest = Object.freeze({
  schema_version: manifest.schema_version,
  commands: Object.freeze(manifest.commands.map(freezeEntry)),
  reserved_commands: Object.freeze(manifest.reserved_commands.map(freezeReserved)),
});

export const nextCommandBuilders = Object.freeze({
  none: () => [],
  ...AUTHORING_NEXT_COMMAND_BUILDERS,
  ...MEMORY_NEXT_COMMAND_BUILDERS,
});
