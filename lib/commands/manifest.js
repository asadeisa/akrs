import { validateCommandManifest } from '../schemas/command-manifest.js';
import { ContractValidationError } from '../schemas/validation.js';
import { ROOT_OVERRIDE_FLAGS } from '../core/roots.js';
import { LOG_NEXT_COMMAND_BUILDERS } from '../store/log/next-commands.js';
import { SCOPE_NEXT_COMMAND_BUILDERS } from '../store/scope/next-commands.js';
import { EXECUTOR_NEXT_COMMAND_BUILDERS } from '../store/executors/next-commands.js';
import { SCAFFOLD_NEXT_COMMAND_BUILDERS } from '../store/scaffold/next-commands.js';
import { STATE_NEXT_COMMAND_BUILDERS } from '../store/state/next-commands.js';
import { VERIFICATION_NEXT_COMMAND_BUILDERS } from '../store/verification/next-commands.js';
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
const LOG_FLAGS = ['--kind', '--subject', '--outcome', '--deviations'].map((name) => Object.freeze({
  name, value_type: 'string', required: false, repeatable: false,
}));
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

const PATCH_FLAG = Object.freeze({ name: '--patch', value_type: 'boolean', required: false, repeatable: false });
const APPLY_FLAG = Object.freeze({ name: '--apply', value_type: 'boolean', required: false, repeatable: false });
const REASON_FLAG = Object.freeze({ name: '--reason', value_type: 'string', required: false, repeatable: false });
const REQUIRED_REASON_FLAG = Object.freeze({ name: '--reason', value_type: 'string', required: true, repeatable: false });
const stringFlag = (name, repeatable = false) => Object.freeze({ name, value_type: 'string', required: false, repeatable });
const PLAN_FLAG = Object.freeze({ name: '--plan', value_type: 'string', required: false, repeatable: false });

// P1-W07: Road changes and the scope loop. All are journaled, transactional mutations (dry-run capable).
const changeWriter = ({
  id, tokens, summary, positionals = [], flags, role, expectedSnapshot = 'revalidate', mcp = [null, null], inputSchema = `akrs.command-input/${id}/v1`,
}) => ({
  id,
  tokens,
  summary,
  input_schema: inputSchema,
  positionals: positionals.map((entry) => ({ ...entry })),
  flags: [...flags, DRY_RUN_FLAG, REQUEST_ID_FLAG, IF_SNAPSHOT_FLAG, ...ROOT_OVERRIDE_FLAGS, ...OUTPUT_FORMAT_FLAGS].map((flag) => ({ ...flag })),
  required_role: role,
  mutability: 'mutation',
  dry_run: true,
  idempotency: 'journal',
  expected_snapshot: expectedSnapshot,
  snapshot_inputs: snapshotInputs(id),
  streaming: 'none',
  output_schema: `akrs.command-output/${id}/v1`,
  statuses: ['ok', 'warning', 'error', 'blocked', 'noop'],
  exit_codes: [0, 1, 2, 3, 4],
  next_command_builder: id,
  mcp_tool: mcp[0],
  mcp_action: mcp[1],
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
    // P1-W09: `log append` records one closure in the segmented ledger; flat flags (a closure has four fields).
    {
      id: 'log-append',
      tokens: ['log', 'append'],
      summary: 'Append one closure record (--kind road|plan --subject <id> --outcome DONE|BLOCKED [--deviations <text>]) to the segmented ledger.',
      input_schema: 'akrs.command-input/log-append/v1',
      positionals: [],
      flags: [
        ...LOG_FLAGS, DRY_RUN_FLAG, REQUEST_ID_FLAG, IF_SNAPSHOT_FLAG, ...ROOT_OVERRIDE_FLAGS, ...OUTPUT_FORMAT_FLAGS,
      ].map((flag) => ({ ...flag })),
      required_role: 'leader',
      mutability: 'mutation',
      dry_run: true,
      idempotency: 'journal',
      expected_snapshot: 'revalidate',
      snapshot_inputs: snapshotInputs('log-append'),
      streaming: 'none',
      output_schema: 'akrs.command-output/log-append/v1',
      statuses: ['ok', 'warning', 'error', 'blocked', 'noop'],
      exit_codes: [0, 1, 2, 3, 4],
      next_command_builder: 'log-append',
      mcp_tool: null,
      mcp_action: null,
    },
    changeWriter({
      id: 'road-update',
      tokens: ['road', 'update'],
      summary: 'Replace a Road with a complete object (--input draft or --json -, needs --if-snapshot) or expand a closed --patch; removals need a reason.',
      positionals: [{ name: 'id', required: true, variadic: false }],
      flags: [INPUT_FLAG, PATCH_FLAG, REASON_FLAG],
      role: 'leader',
      expectedSnapshot: 'required',
      mcp: ['akrs_write', 'road_update'],
    }),
    changeWriter({
      id: 'road-move',
      tokens: ['road', 'move'],
      summary: 'Report (default) or --apply the relocation of a Road to another Plan folder, retargeting only declared references.',
      positionals: [{ name: 'id', required: true, variadic: false }],
      flags: [PLAN_FLAG, APPLY_FLAG],
      role: 'leader',
    }),
    changeWriter({
      id: 'scope-request',
      tokens: ['scope', 'request'],
      summary: 'Ask for more reads or writes (--input draft or --json -); a request grants nothing unless the Road envelope covers it.',
      flags: [INPUT_FLAG],
      role: 'any',
      mcp: ['akrs_scope', 'request'],
    }),
    changeWriter({
      id: 'scope-approve',
      tokens: ['scope', 'approve'],
      summary: 'Approve a pending scope request (a Road with one pending request, or a request ID) through a guarded Road update.',
      positionals: [{ name: 'target', required: true, variadic: false }],
      flags: [REASON_FLAG],
      role: 'leader',
      mcp: ['akrs_scope', 'approve'],
    }),
    changeWriter({
      id: 'scope-reject',
      tokens: ['scope', 'reject'],
      summary: 'Reject a pending scope request with a reason; nothing is granted.',
      positionals: [{ name: 'target', required: true, variadic: false }],
      flags: [REQUIRED_REASON_FLAG],
      role: 'leader',
      mcp: ['akrs_scope', 'reject'],
    }),
    {
      id: 'scope-list',
      tokens: ['scope', 'list'],
      summary: 'List scope requests with their state (pending, approved, rejected), for one Road or all.',
      input_schema: 'akrs.command-input/scope-list/v1',
      positionals: [{ name: 'road', required: false, variadic: false }],
      flags: [...ROOT_OVERRIDE_FLAGS, ...OUTPUT_FORMAT_FLAGS].map((flag) => ({ ...flag })),
      required_role: 'any',
      mutability: 'query',
      dry_run: false,
      idempotency: 'not_applicable',
      expected_snapshot: 'not_applicable',
      snapshot_inputs: snapshotInputs('scope-list'),
      streaming: 'none',
      output_schema: 'akrs.command-output/scope-list/v1',
      statuses: ['ok', 'error'],
      exit_codes: [0, 1, 2, 3, 4],
      next_command_builder: 'scope-list',
      mcp_tool: 'akrs_scope',
      mcp_action: 'list',
    },
    // P1-W10: the Tester sources. The positional is the Plan ID (the Road ID in the no-Plan tier).
    changeWriter({
      id: 'test-define',
      tokens: ['test', 'define'],
      summary: 'Create or replace the Plan verification contract (--input draft or --json -); replacing needs --if-snapshot.',
      positionals: [{ name: 'plan', required: true, variadic: false }],
      flags: [INPUT_FLAG],
      role: 'leader',
      mcp: ['akrs_write', 'verification_define'],
    }),
    changeWriter({
      id: 'test-handoff',
      tokens: ['test', 'handoff'],
      summary: 'Hand a finished Road to the Tester: --road, --result, --reach (repeat), --expect, or --input/--json -; a duplicate is a noop unless --again.',
      positionals: [{ name: 'plan', required: true, variadic: false }],
      flags: [INPUT_FLAG, stringFlag('--road'), stringFlag('--result'), stringFlag('--reach', true), stringFlag('--expect'), AGAIN_FLAG],
      role: 'worker',
      mcp: ['akrs_test', 'handoff'],
    }),
    // P1-W11: the canonical State and its disposable render, both journaled transactional mutations.
    changeWriter({
      id: 'state-set',
      tokens: ['state', 'set'],
      summary: 'Set the Leader-owned State fields (--mode --role --plan --phase --task --next, --clear <field>) and re-render STATE.md in the same transaction.',
      flags: [stringFlag('--mode'), stringFlag('--role'), PLAN_FLAG, stringFlag('--phase'), stringFlag('--task'), stringFlag('--next'), stringFlag('--clear', true), stringFlag('--by')],
      role: 'leader',
      mcp: ['akrs_write', 'state_set'],
    }),
    changeWriter({
      id: 'state-render',
      tokens: ['state', 'render'],
      summary: 'Rewrite STATE.md from the canonical artifacts only (state.json, Roads, scope requests, closure log, verification); never reads the old STATE.md.',
      flags: [],
      role: 'leader',
    }),
    // P1-W13: `init --scaffold` is selected by its second token (the longest token match wins over `init`).
    changeWriter({
      id: 'init-scaffold',
      tokens: ['init', '--scaffold'],
      summary: 'Create the minimal v2 workflow (Road, Task, State, verification contract) in one transaction; --plan <id> selects the Plan tier, --force replaces exactly those files.',
      flags: [PLAN_FLAG, stringFlag('--road'), FORCE_FLAG],
      role: 'leader',
    }),
    // P1-W15: executor classes (the user's own classification) and route fit.
    changeWriter({
      id: 'executor-set',
      tokens: ['executor', 'set'],
      summary: 'Record the user\'s classification of an executor (<id> --role --class --label --answer) and/or tune class numbers (--override <class>.<knob>=<n>, --clear-override).',
      positionals: [{ name: 'id', required: false, variadic: false }],
      flags: [stringFlag('--role'), stringFlag('--class'), stringFlag('--label'), stringFlag('--answer'), stringFlag('--override', true), stringFlag('--clear-override', true)],
      role: 'leader',
      mcp: ['akrs_write', 'executor_set'],
    }),
    changeWriter({
      id: 'executor-remove',
      tokens: ['executor', 'remove'],
      summary: 'Remove one declared executor by ID.',
      positionals: [{ name: 'id', required: true, variadic: false }],
      flags: [],
      role: 'leader',
    }),
    {
      id: 'executor-list',
      tokens: ['executor', 'list'],
      summary: 'List the declared executors, class overrides and the effective class profiles; warns when nothing is classified.',
      input_schema: 'akrs.command-input/executor-list/v1',
      positionals: [],
      flags: [...ROOT_OVERRIDE_FLAGS, ...OUTPUT_FORMAT_FLAGS].map((flag) => ({ ...flag })),
      required_role: 'any',
      mutability: 'query',
      dry_run: false,
      idempotency: 'not_applicable',
      expected_snapshot: 'not_applicable',
      snapshot_inputs: snapshotInputs('executor-list'),
      streaming: 'none',
      output_schema: 'akrs.command-output/executor-list/v1',
      statuses: ['ok', 'warning', 'error'],
      exit_codes: [0, 1, 2, 3, 4],
      next_command_builder: 'none',
      mcp_tool: null,
      mcp_action: null,
    },
    // A query: `--write-drafts` is its one declared scratch write (drafts, outside the transaction namespace), like `template --to-draft`.
    {
      id: 'road-fit',
      tokens: ['road', 'fit'],
      summary: 'Report a Road\'s load against its class profile: fits | split_required | reads_over_budget with deterministic split suggestions (--write-drafts saves them as drafts).',
      input_schema: 'akrs.command-input/road-fit/v1',
      positionals: [{ name: 'id', required: false, variadic: false }],
      flags: [
        stringFlag('--input'),
        stringFlag('--class'),
        { name: '--write-drafts', value_type: 'boolean', required: false, repeatable: false },
        ...ROOT_OVERRIDE_FLAGS,
        ...OUTPUT_FORMAT_FLAGS,
      ].map((flag) => ({ ...flag })),
      required_role: 'any',
      mutability: 'query',
      dry_run: false,
      idempotency: 'not_applicable',
      expected_snapshot: 'not_applicable',
      snapshot_inputs: snapshotInputs('road-fit'),
      streaming: 'none',
      output_schema: 'akrs.command-output/road-fit/v1',
      statuses: ['ok', 'warning', 'error'],
      exit_codes: [0, 1, 2, 3, 4],
      next_command_builder: 'none',
      mcp_tool: 'akrs_road',
      mcp_action: 'fit',
    },
    // P1-W12: report-only git commands. `audit` is `audit --git --road <id>`; `doctor` reports the control-plane posture.
    {
      id: 'audit',
      tokens: ['audit'],
      summary: 'Report-only git audit of one Road: undeclared, declared, missing, pre-existing, workflow, test, evidence changes (--git --road <id> [--pre-existing <path>]).',
      input_schema: 'akrs.command-input/audit/v1',
      positionals: [],
      flags: [
        { name: '--git', value_type: 'boolean', required: false, repeatable: false },
        stringFlag('--road'),
        stringFlag('--pre-existing', true),
        ...ROOT_OVERRIDE_FLAGS,
        ...OUTPUT_FORMAT_FLAGS,
      ].map((flag) => ({ ...flag })),
      required_role: 'any',
      mutability: 'query',
      dry_run: false,
      idempotency: 'not_applicable',
      expected_snapshot: 'not_applicable',
      snapshot_inputs: snapshotInputs('audit'),
      streaming: 'none',
      output_schema: 'akrs.command-output/audit/v1',
      statuses: ['ok', 'warning', 'error'],
      exit_codes: [0, 1, 2, 3, 4],
      next_command_builder: 'none',
      mcp_tool: null,
      mcp_action: null,
    },
    {
      id: 'doctor',
      tokens: ['doctor'],
      summary: 'Report the control-plane git posture (tracked, ignored, mixed, not_git) with the files that make it so.',
      input_schema: 'akrs.command-input/doctor/v1',
      positionals: [],
      flags: [...ROOT_OVERRIDE_FLAGS, ...OUTPUT_FORMAT_FLAGS].map((flag) => ({ ...flag })),
      required_role: 'any',
      mutability: 'query',
      dry_run: false,
      idempotency: 'not_applicable',
      expected_snapshot: 'not_applicable',
      snapshot_inputs: snapshotInputs('doctor'),
      streaming: 'none',
      output_schema: 'akrs.command-output/doctor/v1',
      statuses: ['ok', 'warning', 'error'],
      exit_codes: [0, 1, 2, 3, 4],
      next_command_builder: 'none',
      mcp_tool: null,
      mcp_action: null,
    },
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

// F14 reserved the scope commands until P1-W07 shipped their handlers; they now live in `commands` and nothing is reserved.
manifest.reserved_commands = [];

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
  ...LOG_NEXT_COMMAND_BUILDERS,
  ...SCOPE_NEXT_COMMAND_BUILDERS,
  ...VERIFICATION_NEXT_COMMAND_BUILDERS,
  ...STATE_NEXT_COMMAND_BUILDERS,
  ...EXECUTOR_NEXT_COMMAND_BUILDERS,
  ...SCAFFOLD_NEXT_COMMAND_BUILDERS,
});
