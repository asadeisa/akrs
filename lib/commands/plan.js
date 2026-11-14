// Handlers of `plan finish <plan>` (P2-W08) and of the Plan record writers `plan new`, `plan question add|resolve` and
// `plan seam add|remove` (P2-W11). They parse flags, resolve roots and wrap the packet the store built; no gate or domain rule lives here.
import { CliUsageError } from '../core/errors.js';
import { SNAPSHOT_PATTERN, isId } from '../schemas/common.js';
import { finishPlan } from '../store/plan-finish/index.js';
import { addPlanQuestion, addPlanSeam, createPlan, removePlanSeam, resolvePlanQuestion } from '../store/plan-records/index.js';
import { knownCommandsOf, resolveRoots, rootArgsOf } from './authoring.js';

export async function createPlanFinishPacket(parameters) {
  const { input, manifest, providers } = parameters;
  const roots = resolveRoots(parameters);
  const { flags } = input;
  const key = input.positionals.plan;
  if (key === undefined || !isId(key)) throw new CliUsageError('plan finish takes a Plan ID: akrs plan finish <plan>');
  const expectedSnapshot = flags['--if-snapshot'];
  if (expectedSnapshot !== undefined && !SNAPSHOT_PATTERN.test(expectedSnapshot)) throw new CliUsageError('--if-snapshot must be sha256:<64 lowercase hex>');
  const result = await finishPlan({
    repositoryRoot: roots.repository_root,
    workflowRoot: roots.workflow_root,
    key,
    requestId: flags['--request-id'],
    dryRun: flags['--dry-run'] === true,
    expectedSnapshot,
    providers,
    knownCommands: knownCommandsOf(manifest),
    rootArgs: rootArgsOf(flags),
    env: process.env,
  });
  return result.packet;
}

// ---- Plan record writers --------------------------------------------------------------------------------------------------------------
function planOptions(parameters, verb) {
  const { input, manifest, providers } = parameters;
  const roots = resolveRoots(parameters);
  const { flags } = input;
  const key = input.positionals.plan;
  if (key === undefined || !isId(key)) throw new CliUsageError(`${verb} takes a Plan ID: akrs ${verb} <plan>`);
  const expectedSnapshot = flags['--if-snapshot'];
  if (expectedSnapshot !== undefined && !SNAPSHOT_PATTERN.test(expectedSnapshot)) throw new CliUsageError('--if-snapshot must be sha256:<64 lowercase hex>');
  return {
    flags,
    positionals: input.positionals,
    options: {
      repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root, key, requestId: flags['--request-id'], dryRun: flags['--dry-run'] === true,
      expectedSnapshot, providers, knownCommands: knownCommandsOf(manifest), rootArgs: rootArgsOf(flags),
    },
  };
}

const required = (flags, name, verb) => {
  if (typeof flags[name] !== 'string' || flags[name].trim() === '') throw new CliUsageError(`${verb} needs ${name} <text>`);
  return flags[name];
};
const optionalId = (flags, name) => {
  const value = flags[name];
  if (value === undefined) return null;
  if (!isId(value)) throw new CliUsageError(`${name} takes an ID (letters, digits, - and .), got "${value}"`);
  return value;
};
const positionalId = (positionals, name, verb) => {
  const value = positionals[name];
  if (value === undefined || !isId(value)) throw new CliUsageError(`${verb} takes the ${name} ID: akrs ${verb} <plan> <${name}>`);
  return value;
};

export async function createPlanNewPacket(parameters) {
  const { flags, options } = planOptions(parameters, 'plan new');
  return (await createPlan({ ...options, title: required(flags, '--title', 'plan new') })).packet;
}

export async function createPlanQuestionAddPacket(parameters) {
  const { flags, options } = planOptions(parameters, 'plan question add');
  return (await addPlanQuestion({ ...options, question: optionalId(flags, '--question'), text: required(flags, '--text', 'plan question add') })).packet;
}

export async function createPlanQuestionResolvePacket(parameters) {
  const { flags, positionals, options } = planOptions(parameters, 'plan question resolve');
  return (await resolvePlanQuestion({
    ...options,
    question: positionalId(positionals, 'question', 'plan question resolve'),
    resolution: required(flags, '--resolution', 'plan question resolve'),
    decision: flags['--decision'] ?? null,
  })).packet;
}

export async function createPlanSeamAddPacket(parameters) {
  const { flags, options } = planOptions(parameters, 'plan seam add');
  const road = optionalId(flags, '--road');
  const intent = flags['--intent'] ?? null;
  if (road !== null && intent !== null) throw new CliUsageError('plan seam add takes one owner: --road <id> or --intent <text>, not both');
  return (await addPlanSeam({ ...options, seam: optionalId(flags, '--seam'), text: required(flags, '--text', 'plan seam add'), road, intent })).packet;
}

export async function createPlanSeamRemovePacket(parameters) {
  const { positionals, options } = planOptions(parameters, 'plan seam remove');
  return (await removePlanSeam({ ...options, seam: positionalId(positionals, 'seam', 'plan seam remove') })).packet;
}
