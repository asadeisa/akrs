// F19 flat-schema lint (A1 6.2): a tool is a name, a one-sentence description and an object schema whose properties are string,
// integer, boolean, string enum or string[]; no composition, references, nesting, unions, const, default or format.
import { MCP_SCHEMA_RULES } from './policy.js';

const TOOL_NAME = new RegExp(MCP_SCHEMA_RULES.tool_name_pattern);
const ARGUMENT_NAME = new RegExp(MCP_SCHEMA_RULES.argument_name_pattern);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function keysOutside(value, allowed, path, issues) {
  for (const key of Object.keys(value)) {
    if (MCP_SCHEMA_RULES.forbidden_keywords.includes(key)) issues.push({ path: `${path}.${key}`, code: 'forbidden_keyword' });
    else if (!allowed.includes(key)) issues.push({ path: `${path}.${key}`, code: 'unknown_key' });
  }
}

function lintProperty(name, property, path, issues) {
  if (!ARGUMENT_NAME.test(name)) issues.push({ path, code: 'invalid_argument_name' });
  if (!isPlainObject(property)) {
    issues.push({ path, code: 'invalid_property' });
    return;
  }
  keysOutside(property, MCP_SCHEMA_RULES.property_keys, path, issues);
  if (!MCP_SCHEMA_RULES.property_types.includes(property.type)) {
    issues.push({ path: `${path}.type`, code: Array.isArray(property.type) ? 'type_union' : 'invalid_type' });
    return;
  }
  if (property.type === 'array') {
    const { items } = property;
    if (!isPlainObject(items) || Object.keys(items).length !== 1 || items.type !== MCP_SCHEMA_RULES.array_items) {
      issues.push({ path: `${path}.items`, code: 'invalid_items' });
    }
  } else if (Object.hasOwn(property, 'items')) {
    issues.push({ path: `${path}.items`, code: 'unknown_key' });
  }
  if (Object.hasOwn(property, 'enum')) {
    const valid = property.type === 'string' && Array.isArray(property.enum) && property.enum.length > 0
      && property.enum.every((value) => typeof value === 'string') && new Set(property.enum).size === property.enum.length;
    if (!valid) issues.push({ path: `${path}.enum`, code: 'invalid_enum' });
  }
  if (Object.hasOwn(property, 'description') && typeof property.description !== 'string') {
    issues.push({ path: `${path}.description`, code: 'invalid_description' });
  }
}

export function lintToolSchema(tool) {
  const issues = [];
  if (!isPlainObject(tool)) return [{ path: '$', code: 'invalid_tool' }];
  keysOutside(tool, MCP_SCHEMA_RULES.tool_keys, '$', issues);
  if (typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)) issues.push({ path: '$.name', code: 'invalid_tool_name' });
  if (typeof tool.description !== 'string' || tool.description.length === 0 || /[\r\n]/.test(tool.description)) {
    issues.push({ path: '$.description', code: 'invalid_description' });
  } else if (tool.description.length >= MCP_SCHEMA_RULES.description_max_chars) {
    issues.push({ path: '$.description', code: 'description_too_long' });
  }
  const schema = tool.inputSchema;
  if (!isPlainObject(schema)) {
    issues.push({ path: '$.inputSchema', code: 'invalid_schema' });
    return issues;
  }
  keysOutside(schema, MCP_SCHEMA_RULES.schema_keys, '$.inputSchema', issues);
  if (schema.type !== 'object') issues.push({ path: '$.inputSchema.type', code: 'invalid_type' });
  if (schema.additionalProperties !== false) issues.push({ path: '$.inputSchema.additionalProperties', code: 'open_schema' });
  if (!isPlainObject(schema.properties)) {
    issues.push({ path: '$.inputSchema.properties', code: 'invalid_schema' });
    return issues;
  }
  for (const [name, property] of Object.entries(schema.properties)) lintProperty(name, property, `$.inputSchema.properties.${name}`, issues);
  if (!Array.isArray(schema.required) || !schema.required.every((name) => typeof name === 'string')) {
    issues.push({ path: '$.inputSchema.required', code: 'invalid_required' });
  } else {
    for (const name of schema.required) {
      if (!Object.hasOwn(schema.properties, name)) issues.push({ path: `$.inputSchema.required.${name}`, code: 'unknown_required' });
    }
  }
  return issues;
}

export function lintToolList(tools) {
  const issues = [];
  if (tools.length > MCP_SCHEMA_RULES.max_tools) issues.push({ path: '$', code: 'too_many_tools' });
  const names = new Set();
  tools.forEach((tool, index) => {
    if (names.has(tool?.name)) issues.push({ path: `$[${index}].name`, code: 'duplicate_tool' });
    names.add(tool?.name);
    for (const found of lintToolSchema(tool)) issues.push({ ...found, path: `$[${index}]${found.path.slice(1)}` });
  });
  return issues;
}
