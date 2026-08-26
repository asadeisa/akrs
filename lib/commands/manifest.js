import { validateCommandManifest } from '../schemas/command-manifest.js';
import { ContractValidationError } from '../schemas/validation.js';
import { ROOT_OVERRIDE_FLAGS } from '../core/roots.js';

export const OUTPUT_FORMAT_FLAGS = Object.freeze([
  Object.freeze({ name: '--json', value_type: 'boolean', required: false, repeatable: false }),
  Object.freeze({ name: '--jsonl', value_type: 'boolean', required: false, repeatable: false }),
  Object.freeze({ name: '--prompt', value_type: 'boolean', required: false, repeatable: false }),
]);

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
  snapshot_inputs: [],
  streaming: 'none',
  output_schema: `akrs.command-output/${id}/v1`,
  statuses: ['ok'],
  exit_codes: [0, 2, 4],
  next_command_builder: 'none',
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
      snapshot_inputs: [],
      streaming: 'none',
      output_schema: 'akrs.command-output/validate/v1',
      statuses: ['ok', 'warning', 'error'],
      exit_codes: [0, 1, 2, 3, 4],
      next_command_builder: 'none',
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
      snapshot_inputs: [],
      streaming: 'none',
      output_schema: 'akrs.command-output/explain/v1',
      statuses: ['ok'],
      exit_codes: [0, 2, 4],
      next_command_builder: 'none',
    },
  ],
};

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

export const commandManifest = Object.freeze({
  schema_version: manifest.schema_version,
  commands: Object.freeze(manifest.commands.map(freezeEntry)),
});

export const nextCommandBuilders = Object.freeze({
  none: () => [],
});
