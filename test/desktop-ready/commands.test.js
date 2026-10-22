// P2-W17: the new commands as manifest entries (exact flags, capabilities, snapshot rows, transaction classes), their findings against the
// catalog, their next-command builders and their human and prompt renderings as pure projections of the --json packet.
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { commandManifest, nextCommandBuilders } from '../../lib/core/index.js';
import { getFindingDefinition } from '../../lib/findings/catalog.js';
import { renderDesktopHuman, renderDesktopPrompt } from '../../lib/renderers/desktop.js';
import { COMMAND_SNAPSHOT_TABLE, WORKFLOW_PROJECTION } from '../../lib/store/snapshots/projections.js';
import { TRANSACTION_EXCEPTIONS, TRANSACTION_NON_MUTATIONS, TRANSACTIONAL_COMMANDS } from '../../lib/store/transactions/policy.js';
import { DESKTOP_NEXT_COMMAND_BUILDERS } from '../../lib/userconfig/next-commands.js';
import { assertFindingsMatchCatalog } from '../road/support.js';
import { codesOf, desktopWorld, plainDirectory } from './support.js';

const byId = Object.fromEntries(commandManifest.commands.map((entry) => [entry.id, entry]));
const SHARED = ['--json', '--jsonl', '--prompt', '--root', '--workflow-root'];
const own = (entry) => entry.flags.map(({ name }) => name).filter((name) => !SHARED.includes(name));
const knownCommands = commandManifest.commands.map(({ id }) => id);
const commandTokens = new Map(commandManifest.commands.map(({ id, tokens }) => [id, tokens]));

test('the five commands are manifest entries with exact tokens, flags, capabilities and no MCP tool', () => {
  const expected = {
    'projects-add': { tokens: ['projects', 'add'], mutability: 'mutation', dry_run: true, idempotency: 'none', flags: ['--name', '--dry-run'], positionals: [{ name: 'path', required: false, variadic: false }], streaming: 'none' },
    'projects-remove': { tokens: ['projects', 'remove'], mutability: 'mutation', dry_run: true, idempotency: 'none', flags: ['--dry-run'], positionals: [{ name: 'project', required: true, variadic: false }], streaming: 'none' },
    'projects-list': { tokens: ['projects', 'list'], mutability: 'query', dry_run: false, idempotency: 'not_applicable', flags: [], positionals: [], streaming: 'none' },
    view: { tokens: ['view'], mutability: 'derived_write', dry_run: false, idempotency: 'none', flags: [], positionals: [], streaming: 'none' },
    watch: { tokens: ['watch'], mutability: 'query', dry_run: false, idempotency: 'not_applicable', flags: ['--since', '--debounce-ms', '--poll-ms', '--max-events', '--duration-ms'], positionals: [], streaming: 'jsonl' },
  };
  for (const [id, want] of Object.entries(expected)) {
    const entry = byId[id];
    assert.ok(entry, id);
    assert.deepEqual(entry.tokens, want.tokens, id);
    assert.deepEqual([entry.mutability, entry.dry_run, entry.idempotency, entry.streaming, entry.required_role, entry.expected_snapshot], [want.mutability, want.dry_run, want.idempotency, want.streaming, 'any', 'not_applicable'], id);
    assert.deepEqual(own(entry), want.flags, id);
    assert.deepEqual(entry.positionals, want.positionals, id);
    assert.deepEqual([entry.mcp_tool, entry.mcp_action], [null, null], id);
    assert.deepEqual(entry.snapshot_inputs, COMMAND_SNAPSHOT_TABLE[id].inputs, id);
    assert.equal(entry.next_command_builder, id);
    assert.equal(typeof nextCommandBuilders[id], 'function', id);
  }
  assert.deepEqual(byId.watch.flags.filter(({ name }) => ['--debounce-ms', '--poll-ms', '--max-events', '--duration-ms'].includes(name)).map(({ value_type: type }) => type), ['integer', 'integer', 'integer', 'integer']);
  assert.deepEqual(byId.status.flags.filter(({ name }) => name === '--all-projects'), [{ name: '--all-projects', value_type: 'boolean', required: false, repeatable: false }]);
});

test('snapshot rows: the registry commands read projects-registry, view the workflow projection, watch nothing', () => {
  assert.deepEqual(COMMAND_SNAPSHOT_TABLE['projects-add'].inputs, ['projects-registry']);
  assert.deepEqual(COMMAND_SNAPSHOT_TABLE['projects-remove'].inputs, ['projects-registry']);
  assert.deepEqual(COMMAND_SNAPSHOT_TABLE['projects-list'].inputs, ['projects-registry']);
  assert.deepEqual(COMMAND_SNAPSHOT_TABLE.view.inputs, [...WORKFLOW_PROJECTION]);
  assert.deepEqual(COMMAND_SNAPSHOT_TABLE.watch.inputs, []);
});

test('transaction classes: registry writers are user_config exceptions, the rest are not workflow mutations', () => {
  for (const id of ['projects-add', 'projects-remove']) {
    assert.equal(TRANSACTION_EXCEPTIONS[id].reason, 'user_config', id);
    assert.equal(TRANSACTIONAL_COMMANDS.includes(id), false, id);
  }
  for (const id of ['projects-list', 'view', 'watch', 'status', 'graph']) assert.equal(TRANSACTION_NON_MUTATIONS.includes(id), true, id);
});

test('every next command the builders offer names a manifest command and runs as it is', () => {
  const offered = [
    DESKTOP_NEXT_COMMAND_BUILDERS['projects-add']({ phase: 'added' }),
    DESKTOP_NEXT_COMMAND_BUILDERS['projects-add']({ phase: 'not_akrs', repository: '/x/y' }),
    DESKTOP_NEXT_COMMAND_BUILDERS['projects-remove']({ phase: 'removed' }),
    DESKTOP_NEXT_COMMAND_BUILDERS['projects-list']({ phase: 'listed', count: 2 }),
    DESKTOP_NEXT_COMMAND_BUILDERS.view({ phase: 'written', rootArgs: ['--root', '/x'] }),
    DESKTOP_NEXT_COMMAND_BUILDERS.watch({ phase: 'ended', cursor: '01ARZ3NDEKTSV4RRFFQ69G5FAV', rootArgs: ['--root', '/x'] }),
    DESKTOP_NEXT_COMMAND_BUILDERS.watch({ phase: 'ended', cursor: null, rootArgs: [] }),
  ].flat();
  assert.ok(offered.length >= 7);
  for (const { command, args } of offered) {
    assert.ok(knownCommands.includes(command), command);
    assert.equal(args.every((arg) => typeof arg === 'string' && arg !== '' && !/[<>{}]/.test(arg)), true, `${command} ${args.join(' ')} has no placeholder`);
  }
  assert.deepEqual(DESKTOP_NEXT_COMMAND_BUILDERS['projects-list']({ phase: 'listed', count: 0 }), []);
  assert.deepEqual(DESKTOP_NEXT_COMMAND_BUILDERS.watch({ phase: 'ended', cursor: null, rootArgs: [] }), [{ command: 'watch', args: ['--jsonl'] }]);
  for (const id of ['projects-add', 'projects-remove', 'projects-list', 'view', 'watch']) assert.throws(() => DESKTOP_NEXT_COMMAND_BUILDERS[id]({ phase: 'nope' }), TypeError, id);
});

test('AKRS-C022 and AKRS-C023 are catalogued with closed detail shapes and every real finding fits them', async (t) => {
  const c022 = getFindingDefinition('AKRS-C022');
  const c023 = getFindingDefinition('AKRS-C023');
  assert.deepEqual([c022.severity, c022.category, c023.severity, c023.category], ['error', 'command', 'warning', 'command']);
  assert.deepEqual(c022.data_schema.properties.reason.enum, ['missing', 'not_a_directory', 'not_akrs', 'registry_full', 'registry_invalid', 'unsafe']);
  assert.deepEqual(c023.data_schema.properties.reason.enum, ['missing', 'not_a_directory', 'not_akrs', 'unreadable']);
  const world = await desktopWorld(t);
  const repo = await world.project();
  const rejected = await world.json(['projects', 'add', join((await plainDirectory(t)).root, 'nope')]);
  assert.deepEqual(codesOf(rejected.packet), ['AKRS-C022']);
  assertFindingsMatchCatalog(rejected.packet);
  await world.json(['projects', 'add', repo.root]);
  await rm(repo.root, { recursive: true, force: true });
  const unreadable = await world.json(['status', '--all-projects']);
  assert.deepEqual(codesOf(unreadable.packet), ['AKRS-C023']);
  assertFindingsMatchCatalog(unreadable.packet);
  const emptied = await world.project();
  await world.json(['projects', 'add', emptied.root]);
  await rm(join(emptied.root, 'akrs'), { recursive: true, force: true });
  await mkdir(join(emptied.root, 'akrs'));
  assertFindingsMatchCatalog((await world.json(['status', '--all-projects'])).packet);
});

test('help lists the new commands with their flags', async (t) => {
  const world = await desktopWorld(t);
  const out = await world.json(['--help']);
  const text = JSON.stringify(out.packet.data);
  for (const invocation of ['akrs projects add <path>', 'akrs projects remove <project>', 'akrs projects list', 'akrs view', 'akrs watch']) assert.ok(text.includes(`"invocation":"${invocation}"`), invocation);
});

// ---- renderings ---------------------------------------------------------------------------------------------------------
async function renderedCases(t) {
  const world = await desktopWorld(t);
  const repo = await world.project();
  const cases = [];
  // `again` commands give the same packet every time (queries, dry runs, an unchanged view), so the CLI renderings can be compared with the packet
  const run = async (argv, { again = false } = {}) => {
    const json = await world.json(argv);
    const entry = { argv, packet: json.packet, human: null, prompt: null };
    if (again) {
      const human = await world.run(argv);
      const prompt = await world.run([...argv, '--prompt']);
      entry.human = human.stdout === '' ? human.stderr : human.stdout;
      entry.prompt = prompt.stdout === '' ? prompt.stderr : prompt.stdout;
    }
    cases.push(entry);
  };
  await run(['projects', 'list'], { again: true });
  await run(['projects', 'add', repo.root, '--name', 'Line one "quoted"', '--dry-run'], { again: true });
  await run(['projects', 'add', repo.root, '--name', 'Line one "quoted"']);
  await run(['projects', 'add', join((await plainDirectory(t)).root, 'gone')], { again: true });
  await run(['projects', 'list'], { again: true });
  await run(['status', '--all-projects'], { again: true });
  await run(['view', '--root', repo.root]);
  await run(['view', '--root', repo.root], { again: true });
  await run(['projects', 'remove', repo.root, '--dry-run'], { again: true });
  await run(['projects', 'remove', repo.root]);
  return cases;
}

test('human and prompt output are exactly the pure renderers of the --json packet, for every desktop command', async (t) => {
  const cases = await renderedCases(t);
  assert.ok(cases.length >= 8);
  for (const { argv, packet, human, prompt } of cases) {
    const humanText = renderDesktopHuman(packet, { knownCommands, commandTokens });
    const promptText = renderDesktopPrompt(packet, { knownCommands, commandTokens });
    if (human !== null) assert.equal(human, humanText, argv.join(' '));
    if (prompt !== null) assert.equal(prompt, promptText, argv.join(' '));
    assert.ok(humanText.endsWith('\n') && promptText.endsWith('\n'));
  }
});

test('the renderings name the facts of the packet; user text is quoted data and next commands are pasteable', async (t) => {
  const cases = await renderedCases(t);
  const human = (entry) => renderDesktopHuman(entry.packet, { knownCommands, commandTokens });
  const prompt = (entry) => renderDesktopPrompt(entry.packet, { knownCommands, commandTokens });
  const added = cases.find(({ argv, packet }) => argv[1] === 'add' && packet.data.outcome === 'added' && !packet.data.dry_run);
  assert.match(human(added), /outcome: added/);
  assert.ok(human(added).includes('name "Line one \\"quoted\\""'), human(added));
  assert.match(prompt(added), /^# AKRS projects-add/);
  assert.match(human(added), /akrs status --all-projects/);
  const rejected = cases.find(({ packet }) => packet.data.outcome === 'rejected');
  assert.match(human(rejected), /outcome: rejected \(missing\)/);
  assert.match(human(rejected), /AKRS-C022/);
  const all = cases.find(({ argv }) => argv[0] === 'status');
  assert.match(human(all), /Roads \d+: ACTIVE/);
  assert.match(human(all), /Plan P6: 0\/3 Roads DONE/);
  const view = cases.find(({ argv, packet }) => argv[0] === 'view' && packet.data.outcome === 'written');
  assert.match(human(view), /wrote akrs\/\.cache\/view\/index\.html/);
  assert.match(human(view), /no network, no server/);
  const removed = cases.find(({ packet }) => packet.data.outcome === 'removed' && !packet.data.dry_run);
  assert.match(human(removed), /the project itself is untouched/);
});
