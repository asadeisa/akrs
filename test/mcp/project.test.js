// P2-W15 F19: the manifest -> tool projection and the flat-schema lint. The tool list is never written by hand: these tests pin what
// the projection of the shipped manifest is, and that any manifest the lint would reject cannot be projected.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManifest } from '../../lib/commands/manifest.js';
import { MCP_SCHEMA_RULES } from '../../lib/mcp/policy.js';
import { McpProjectionError, projectTools } from '../../lib/mcp/project.js';
import { lintToolList, lintToolSchema } from '../../lib/mcp/schema.js';

const projection = projectTools(commandManifest);
const toolOf = (name) => projection.tools.find((tool) => tool.name === name);
const props = (name) => Object.keys(toolOf(name).inputSchema.properties);

test('F19 the shipped manifest projects to exactly seven tools, in manifest order, with the A1 6.2 action enums', () => {
  assert.deepEqual(projection.tools.map(({ name }) => name), ['akrs_status', 'akrs_write', 'akrs_scope', 'akrs_test', 'akrs_road', 'akrs_work', 'akrs_page']);
  const actions = Object.fromEntries(projection.tools.map((tool) => [tool.name, tool.inputSchema.properties.action.enum]));
  assert.deepEqual(actions, {
    akrs_status: ['validate', 'explain', 'status', 'next', 'graph', 'boot'],
    akrs_write: ['road_new', 'task_new', 'memory_add', 'road_update', 'verification_define', 'state_set', 'executor_set', 'activate', 'lease_release', 'plan_finish'],
    akrs_scope: ['request', 'approve', 'reject', 'list'],
    akrs_test: ['handoff', 'details', 'run', 'result'],
    akrs_road: ['fit', 'details', 'verify', 'check', 'template'],
    akrs_work: ['work', 'done', 'yield'],
    akrs_page: ['read'],
  });
});

test('F19 every manifest (mcp_tool, mcp_action) pair is routed to its own command and nothing else is', () => {
  const pairs = commandManifest.commands.filter(({ mcp_tool: tool }) => tool !== null).map(({ id, mcp_tool: tool, mcp_action: action }) => [tool, action, id]);
  const routed = Object.entries(projection.routes).flatMap(([tool, actions]) => Object.entries(actions).map(([action, route]) => [tool, action, route.command]));
  assert.deepEqual(routed.sort(), pairs.sort());
});

test('F19 the shipped tool list passes the flat lint, and the A1 6.2 arguments are present', () => {
  assert.deepEqual(lintToolList(projection.tools), []);
  assert.ok(projection.tools.length <= MCP_SCHEMA_RULES.max_tools);
  for (const tool of projection.tools) {
    assert.deepEqual(Object.keys(tool).sort(), ['description', 'inputSchema', 'name']);
    assert.ok(tool.description.length < 200, tool.name);
    assert.equal(tool.description.split('. ').length <= 2, true, `${tool.name}: one purpose sentence plus the action list`);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  // the A1 6.2 table (input_path, not input_file: A1 4 names the MCP channel input_path)
  for (const [tool, names] of Object.entries({
    akrs_status: ['id', 'executor'],
    akrs_road: ['id', 'kind', 'class'],
    akrs_work: ['road', 'executor', 'result', 'reach', 'expect', 'reason'],
    akrs_scope: ['road', 'request', 'input_path', 'reason'],
    akrs_test: ['plan', 'verdict', 'because', 'input_path'],
    akrs_write: ['input_path', 'id', 'reason'],
    akrs_page: ['url', 'text', 'a11y', 'console', 'network', 'screenshot', 'viewport', 'wait_for'],
  })) {
    for (const name of names) assert.ok(props(tool).includes(name), `${tool}.${name}`);
  }
  const { reach } = toolOf('akrs_work').inputSchema.properties;
  assert.deepEqual([reach.type, reach.items], ['array', { type: 'string' }]);
  // a property is required only when every action needs it
  assert.deepEqual(toolOf('akrs_test').inputSchema.required, ['action', 'plan']);
  assert.deepEqual(toolOf('akrs_page').inputSchema.required, ['action', 'url']);
  assert.deepEqual(toolOf('akrs_status').inputSchema.required, ['action']);
});

test('F19 bookkeeping and server-level flags are never arguments; dry_run and if_snapshot stay for the Leader', () => {
  for (const tool of projection.tools) {
    for (const name of ['json', 'jsonl', 'prompt', 'request_id', 'root', 'workflow_root', 'input', 'input_file']) {
      assert.equal(props(tool.name).includes(name), false, `${tool.name}.${name}`);
    }
  }
  assert.ok(props('akrs_write').includes('if_snapshot'));
  assert.ok(props('akrs_write').includes('dry_run'));
  // akrs_write positionals are all `id`, so the state_set --plan flag keeps its own name
  assert.ok(props('akrs_write').includes('plan'));
  assert.equal(projection.routes.akrs_write.plan_finish.bindings.find(({ source }) => source.kind === 'positional').names[0], 'id');
});

const tool = (properties, extra = {}) => ({
  name: 'akrs_x', description: 'X.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['a'] }, ...properties }, required: ['action'], additionalProperties: false, ...extra },
});
const codes = (value) => lintToolSchema(value).map(({ code }) => code);

test('F19 the flat lint rejects every construct outside the subset', () => {
  assert.deepEqual(lintToolSchema(tool({ id: { type: 'string', description: 'x' } })), []);
  for (const [label, bad] of [
    ['oneOf', { id: { oneOf: [{ type: 'string' }] } }],
    ['anyOf', { id: { anyOf: [{ type: 'string' }] } }],
    ['allOf', { id: { allOf: [{ type: 'string' }] } }],
    ['$ref', { id: { $ref: '#/x' } }],
    ['nested object', { id: { type: 'object', properties: {} } }],
    ['type union', { id: { type: ['string', 'null'] } }],
    ['const', { id: { type: 'string', const: 'a' } }],
    ['default', { id: { type: 'string', default: 'a' } }],
    ['format', { id: { type: 'string', format: 'uri' } }],
    ['number', { id: { type: 'number' } }],
    ['array of objects', { id: { type: 'array', items: { type: 'object' } } }],
    ['array of integers', { id: { type: 'array', items: { type: 'integer' } } }],
    ['integer enum', { id: { type: 'integer', enum: [1] } }],
    ['bad property name', { 'Bad-Name': { type: 'string' } }],
  ]) {
    assert.ok(codes(tool(bad)).length > 0, label);
  }
  assert.ok(codes({ ...tool({}), name: 'Akrs-Road' }).includes('invalid_tool_name'));
  assert.ok(codes({ ...tool({}), name: `a${'b'.repeat(30)}` }).includes('invalid_tool_name'));
  assert.ok(codes({ ...tool({}), description: 'x'.repeat(200) }).includes('description_too_long'));
  assert.ok(codes(tool({}, { $schema: 'https://json-schema.org/draft/2020-12/schema' })).length > 0);
  assert.ok(codes(tool({}, { required: ['missing'] })).includes('unknown_required'));
  assert.ok(lintToolList(Array.from({ length: 8 }, (_, index) => ({ ...tool({}), name: `akrs_${String.fromCharCode(97 + index)}` }))).some(({ code }) => code === 'too_many_tools'));
  assert.ok(lintToolList([tool({}), tool({})]).some(({ code }) => code === 'duplicate_tool'));
});

const entry = (id, mcp, overrides = {}) => {
  const template = commandManifest.commands.find(({ id: name }) => name === 'scope-list');
  return { ...structuredClone(template), id, tokens: [id], mcp_tool: mcp[0], mcp_action: mcp[1], ...overrides };
};
const manifestOf = (...commands) => ({ ...commandManifest, commands });

test('F19 a manifest that cannot be projected flat is refused, never trimmed', () => {
  const eight = Array.from({ length: 8 }, (_, index) => entry(`c-${index}`, [`akrs_t${index}`, 'a']));
  assert.throws(() => projectTools(manifestOf(...eight)), (error) => error instanceof McpProjectionError && /7/.test(error.message));
  assert.throws(() => projectTools(manifestOf(entry('j', ['akrs_x', 'a'], { flags: [{ name: '--doc', value_type: 'json', required: false, repeatable: false }] }))), McpProjectionError);
  assert.throws(() => projectTools(manifestOf(
    entry('one', ['akrs_x', 'a'], { flags: [{ name: '--n', value_type: 'integer', required: false, repeatable: false }] }),
    entry('two', ['akrs_x', 'b'], { flags: [{ name: '--n', value_type: 'string', required: false, repeatable: false }] }),
  )), /type/);
  assert.throws(() => projectTools(manifestOf(entry('rep', ['akrs_x', 'a'], { flags: [{ name: '--n', value_type: 'integer', required: false, repeatable: true }] }))), McpProjectionError);
  // a positional and a flag of one action that would share an argument name
  assert.throws(() => projectTools(manifestOf(entry('clash', ['akrs_x', 'a'], {
    positionals: [{ name: 'road', required: false, variadic: false }], flags: [{ name: '--road', value_type: 'string', required: false, repeatable: false }],
  }))), /road/);
  // commands without an MCP pair are not projected
  assert.deepEqual(projectTools(manifestOf(entry('plain', [null, null]), entry('one', ['akrs_x', 'a']))).tools.map(({ name }) => name), ['akrs_x']);
});
