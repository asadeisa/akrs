// P2-W12 policy: the frozen decisions, the manifest entries of the five commands, the finding, the snapshot rows and the transaction policy rows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { getFindingDefinition } from '../../lib/findings/catalog.js';
import { COMMAND_SNAPSHOT_TABLE, LEASE_CONTRACT_PROJECTION, WORKFLOW_PROJECTION } from '../../lib/store/snapshots/index.js';
import { TRANSACTIONAL_COMMANDS, TRANSACTION_EXCEPTIONS, TRANSACTION_NON_MUTATIONS } from '../../lib/store/transactions/index.js';
import { LEASE_POLICY } from '../../lib/store/leases/index.js';
import {
  BOOT_SCHEMA, CLAIM_ACTIONS, DONE_FLAGS, DONE_SCHEMA, INTENTS, INTENT_FINDING_CODE, INTENT_NEXT_COMMAND_BUILDERS, INTENT_POLICY, INTENT_REASONS, KERNEL_FILES, WORK_SCHEMA,
  YIELD_SCHEMA,
} from '../../lib/store/intents/index.js';

const entry = (id) => commandManifest.commands.find((command) => command.id === id);
const frozen = (value, path = 'value') => {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true, `${path} is frozen`);
  for (const [key, child] of Object.entries(value)) frozen(child, `${path}.${key}`);
};

test('the decision record is frozen and every decision is a documented sentence', () => {
  frozen(INTENT_POLICY);
  assert.deepEqual(Object.keys(INTENT_POLICY.decisions), [
    'composition', 'holder', 'work_choice', 'work_claim', 'work_empty', 'guard_file', 'guard_rules', 'done_flow', 'done_input', 'done_stale', 'done_audit',
    'done_failures', 'yield', 'boot',
  ]);
  for (const text of Object.values(INTENT_POLICY.decisions)) assert.match(text, /^\(decision\) .{40,}/);
  assert.deepEqual([WORK_SCHEMA, DONE_SCHEMA, YIELD_SCHEMA, BOOT_SCHEMA], ['akrs.work/v1', 'akrs.done/v1', 'akrs.yield/v1', 'akrs.boot/v1']);
  assert.deepEqual(DONE_FLAGS, ['--result', '--reach', '--expect']);
  assert.deepEqual(CLAIM_ACTIONS, ['claimed', 'refreshed', 'taken_over', 'unchanged']);
  assert.deepEqual(KERNEL_FILES, { core: 'kernel/CORE.md', leader: 'kernel/leader.md' });
  assert.deepEqual(INTENTS, ['work', 'done', 'yield', 'guard']);
});

test('the five manifest entries state role, mutability, snapshot rows and MCP metadata', () => {
  const rows = ['boot', 'work', 'done', 'yield', 'guard'].map((id) => {
    const found = entry(id);
    assert.ok(found, id);
    return [id, found.required_role, found.mutability, found.expected_snapshot, found.idempotency, found.mcp_tool, found.mcp_action, found.dry_run, found.streaming];
  });
  assert.deepEqual(rows, [
    ['boot', 'leader', 'query', 'not_applicable', 'not_applicable', 'akrs_status', 'boot', false, 'none'],
    ['work', 'worker', 'mutation', 'lease', 'none', 'akrs_work', 'work', false, 'none'],
    ['done', 'worker', 'mutation', 'lease', 'journal', 'akrs_work', 'done', true, 'none'],
    ['yield', 'worker', 'mutation', 'revalidate', 'journal', 'akrs_work', 'yield', true, 'none'],
    ['guard', 'any', 'query', 'not_applicable', 'not_applicable', null, null, false, 'none'],
  ]);
  assert.deepEqual(entry('done').flags.map(({ name }) => name).filter((name) => ['--result', '--reach', '--expect', '--handoff', '--executor'].includes(name)), ['--result', '--reach', '--expect', '--handoff', '--executor']);
  assert.equal(entry('done').flags.find(({ name }) => name === '--reach').repeatable, true);
  assert.equal(entry('yield').flags.find(({ name }) => name === '--reason').required, true);
  assert.deepEqual(entry('work').positionals, [{ name: 'road', required: false, variadic: false }]);
  assert.equal(entry('work').flags.some(({ name }) => name === '--dry-run'), false, 'work has no dry run: it is a claim');
  // the Worker never types bookkeeping: work offers neither a snapshot nor a request ID flag
  assert.equal(entry('work').flags.some(({ name }) => ['--if-snapshot', '--request-id'].includes(name)), false);
  for (const id of ['boot', 'work', 'done', 'yield', 'guard']) assert.equal(entry(id).next_command_builder, id);
});

test('the snapshot rows are the lease rows of the amendment; the transaction policy lists them', () => {
  for (const id of ['work', 'done', 'yield']) assert.deepEqual(COMMAND_SNAPSHOT_TABLE[id], { target: 'road', inputs: [...LEASE_CONTRACT_PROJECTION], lease_guard: 'road' });
  assert.deepEqual(COMMAND_SNAPSHOT_TABLE.boot, { target: 'none', inputs: [...WORKFLOW_PROJECTION], lease_guard: null });
  assert.deepEqual(COMMAND_SNAPSHOT_TABLE.guard, { target: 'none', inputs: [], lease_guard: null });
  assert.ok(TRANSACTIONAL_COMMANDS.includes('done') && TRANSACTIONAL_COMMANDS.includes('yield'));
  assert.equal(TRANSACTION_EXCEPTIONS.work.reason, 'lease_store');
  assert.ok(TRANSACTION_NON_MUTATIONS.includes('boot') && TRANSACTION_NON_MUTATIONS.includes('guard'));
  // every mutation of the manifest is either transactional or a documented exception
  for (const { id, mutability } of commandManifest.commands) {
    if (mutability !== 'mutation') continue;
    assert.ok(TRANSACTIONAL_COMMANDS.includes(id) || Object.hasOwn(TRANSACTION_EXCEPTIONS, id), id);
  }
});

test('AKRS-R026 is documented with its closed reasons', () => {
  assert.equal(INTENT_FINDING_CODE, 'AKRS-R026');
  const definition = getFindingDefinition('AKRS-R026');
  assert.equal(definition.category, 'road');
  assert.deepEqual(definition.data_schema.properties.reason.enum.slice().sort(), [...INTENT_REASONS].sort());
  assert.deepEqual(definition.data_schema.properties.intent.enum, [...INTENTS]);
});

test('the builders are pure and every command they name is a manifest command', () => {
  const known = new Set(commandManifest.commands.map(({ id }) => id));
  const roots = ['--root', '/r'];
  const samples = [
    INTENT_NEXT_COMMAND_BUILDERS.work({ phase: 'claimed', road: 'R-1', rootArgs: roots }),
    INTENT_NEXT_COMMAND_BUILDERS.work({ phase: 'choices', road: 'R-1', choices: ['a', 'b'], rootArgs: roots }),
    INTENT_NEXT_COMMAND_BUILDERS.work({ phase: 'empty', executor: 'a', rootArgs: roots }),
    INTENT_NEXT_COMMAND_BUILDERS.done({ phase: 'done', rootArgs: roots }),
    INTENT_NEXT_COMMAND_BUILDERS.done({ phase: 'rejected', id: 'R-1', rootArgs: roots }),
    INTENT_NEXT_COMMAND_BUILDERS.done({ phase: 'stale', road: 'R-1', executor: 'a', rootArgs: roots }),
    INTENT_NEXT_COMMAND_BUILDERS.done({ phase: 'yield', road: 'R-1', failures: 2, executor: 'a', rootArgs: roots }),
    INTENT_NEXT_COMMAND_BUILDERS.yield({ phase: 'done', executor: 'a', rootArgs: roots }),
    INTENT_NEXT_COMMAND_BUILDERS.yield({ phase: 'rejected', road: 'R-1', rootArgs: roots }),
    INTENT_NEXT_COMMAND_BUILDERS.guard({}),
  ];
  for (const commands of samples) for (const { command, args } of commands) {
    assert.ok(known.has(command), command);
    assert.ok(args.every((argument) => typeof argument === 'string' && argument !== ''));
  }
  assert.deepEqual(INTENT_NEXT_COMMAND_BUILDERS.done({ phase: 'rejected', id: 'R-1', rootArgs: roots }), [{ command: 'verify', args: ['--road', 'R-1', '--root', '/r'] }]);
  assert.throws(() => INTENT_NEXT_COMMAND_BUILDERS.work({ phase: 'nope' }), /unknown next-command phase/);
});

test('the lease policy still keeps the guard allowlist beside, never inside, the lease directories', () => {
  assert.match(LEASE_POLICY.guard_allowlist, /\.ops\/leases\/<road>\.guard\.json/);
  assert.match(LEASE_POLICY.guard_allowlist, /never inside the road\/ or plan\/ directories/);
});
