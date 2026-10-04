// Handlers of `executor set|remove|list` and `road fit` (P1-W15). They parse flags, resolve roots and return the
// packet the store flow built; no domain rule lives here.
import { CliUsageError } from '../core/errors.js';
import { createPacket } from '../core/packet.js';
import { EXECUTOR_CLASSES } from '../schemas/executors.js';
import { SNAPSHOT_PATTERN, isId } from '../schemas/common.js';
import {
  CLASS_PROFILES, EXECUTOR_FINDING_CODES, readExecutors, removeExecutor, resolveProfile, roadFit, setExecutor, suggestionDraft, unclassifiedFinding,
} from '../store/executors/index.js';
import { readAuthoringInput } from '../store/roads/input.js';
import { AUTHORING_FINDING_CODES } from '../store/roads/policy.js';
import { DraftWriteError, writeTemplateDraft } from '../store/roads/templates.js';
import { commandSnapshot } from '../store/snapshots/index.js';
import { EMPTY_SNAPSHOT } from '../store/snapshots/projections.js';
import { knownCommandsOf, resolveRoots, rootArgsOf } from './authoring.js';

const list = (value) => (value === undefined ? [] : [].concat(value));

function common(parameters) {
  const { input, manifest, providers } = parameters;
  const roots = resolveRoots(parameters);
  const { flags } = input;
  const expectedSnapshot = flags['--if-snapshot'];
  if (expectedSnapshot !== undefined && !SNAPSHOT_PATTERN.test(expectedSnapshot)) throw new CliUsageError('--if-snapshot must be sha256:<64 lowercase hex>');
  return {
    roots,
    flags,
    options: {
      repositoryRoot: roots.repository_root,
      workflowRoot: roots.workflow_root,
      requestId: flags['--request-id'],
      dryRun: flags['--dry-run'] === true,
      expectedSnapshot,
      providers,
      knownCommands: knownCommandsOf(manifest),
      rootArgs: rootArgsOf(flags),
    },
  };
}

function parseOverrides(flags) {
  const setOverrides = list(flags['--override']).map((text) => {
    const match = /^([^.=]+)\.([^.=]+)=(\d+)$/.exec(text);
    if (match === null) throw new CliUsageError(`--override takes <class>.<knob>=<whole number>, for example weak.max_writes=2 (got "${text}")`);
    return { class: match[1], knob: match[2], value: Number(match[3]) };
  });
  const clearOverrides = list(flags['--clear-override']).map((text) => {
    const match = /^([^.=]+)\.([^.=]+)$/.exec(text);
    if (match === null) throw new CliUsageError(`--clear-override takes <class>.<knob> (got "${text}")`);
    return { class: match[1], knob: match[2] };
  });
  return { setOverrides, clearOverrides };
}

export async function createExecutorSetPacket(parameters) {
  const { flags, options } = common(parameters);
  const id = parameters.input.positionals.id;
  const given = ['--role', '--class', '--label', '--answer'].filter((name) => flags[name] !== undefined);
  const { setOverrides, clearOverrides } = parseOverrides(flags);
  let executor = null;
  if (id !== undefined || given.length > 0) {
    if (id === undefined) throw new CliUsageError('executor set needs the executor ID when --role/--class/--label/--answer are given');
    const missing = ['--role', '--class', '--label', '--answer'].filter((name) => flags[name] === undefined);
    if (missing.length > 0) throw new CliUsageError(`executor set records the user's own classification and needs ${missing.join(', ')}; nothing is inferred`);
    executor = { id, role: flags['--role'], class: flags['--class'], label: flags['--label'], user_answer: flags['--answer'] };
  } else if (setOverrides.length === 0 && clearOverrides.length === 0) {
    throw new CliUsageError('executor set needs an executor (<id> --role --class --label --answer) or --override/--clear-override');
  }
  return (await setExecutor({ ...options, executor, setOverrides, clearOverrides })).packet;
}

export async function createExecutorRemovePacket(parameters) {
  const { options } = common(parameters);
  const id = parameters.input.positionals.id;
  if (id === undefined) throw new CliUsageError('executor remove needs the executor ID');
  return (await removeExecutor({ ...options, id })).packet;
}

export async function createExecutorListPacket(parameters) {
  const { roots, options } = common(parameters);
  const read = await readExecutors({ repositoryRoot: options.repositoryRoot, workflowRoot: options.workflowRoot });
  const { snapshot } = await commandSnapshot('executor-list', { repositoryRoot: options.repositoryRoot, workflowRoot: options.workflowRoot });
  const broken = read.exists && (read.problem !== null || read.meta_state !== 'declared');
  const findings = [];
  if (broken) {
    findings.push({
      code: EXECUTOR_FINDING_CODES.guard, severity: 'error', message: `executors.json is unusable (${read.problem ?? 'content hash or schema does not verify'}).`, file: read.path, line: null,
      detail: { reason: 'file_unusable', subject: 'executors' },
    });
  } else if (read.unclassified) findings.push({ ...unclassifiedFinding(), detail: { has_leader: read.executors.some(({ role }) => role === 'leader'), has_worker: read.executors.some(({ role }) => role === 'worker') } });
  return createPacket({
    command: 'executor-list',
    status: findings.length > 0 ? (broken ? 'error' : 'warning') : 'ok',
    root: roots.repository_root,
    snapshot: { before: snapshot, after: snapshot },
    data: {
      kind: 'executor_list',
      executors: read.executors,
      class_overrides: read.class_overrides,
      profiles: Object.fromEntries(EXECUTOR_CLASSES.map((cls) => [cls, resolveProfile(cls, read.class_overrides)])),
      defaults: CLASS_PROFILES,
      unclassified: read.unclassified,
      leader_class: read.leader_class,
    },
    findings,
    providers: parameters.providers,
    knownCommands: options.knownCommands,
  });
}

export async function createRoadFitPacket(parameters) {
  const { roots, flags, options } = common(parameters);
  const id = parameters.input.positionals.id;
  const inputPath = flags['--input'];
  const requested = flags['--class'];
  if (requested !== undefined && !EXECUTOR_CLASSES.includes(requested)) throw new CliUsageError(`--class must be one of: ${EXECUTOR_CLASSES.join(', ')}`);
  if ((id === undefined) === (inputPath === undefined)) throw new CliUsageError('road fit takes a Road ID or --input <draft>, not both and not neither');
  if (id !== undefined && !isId(id)) throw new CliUsageError('road fit takes a Road ID');
  const base = { repositoryRoot: options.repositoryRoot, workflowRoot: options.workflowRoot };
  let document;
  if (inputPath !== undefined) {
    const read = await readAuthoringInput({ ...base, channel: { inputPath } });
    if (!read.ok) throw new CliUsageError(`road fit cannot read ${inputPath}: ${read.findings?.[0]?.message ?? 'unreadable input'}`);
    document = read.document;
  }
  const result = await roadFit({ ...base, id, document, class: requested });
  if (result.problem === 'road_missing') throw new CliUsageError(`road fit: no Road ${id} exists`);
  if (result.problem === 'road_unverified') throw new CliUsageError(`road fit: Road ${id} does not verify`);
  if (result.problem === 'class_missing') throw new CliUsageError('road fit needs a class: the Road has no executor_class; pass --class weak|medium|frontier');
  const snapshot = id === undefined ? EMPTY_SNAPSHOT : (await commandSnapshot('road-fit', { ...base, target: { road: id } })).snapshot;
  const packetBase = {
    command: 'road-fit', root: roots.repository_root, snapshot: { before: snapshot, after: snapshot }, providers: parameters.providers, knownCommands: options.knownCommands,
  };
  const { fit } = result;
  if (flags['--write-drafts'] !== true || fit.suggestions.length === 0) {
    return createPacket({ ...packetBase, status: 'ok', data: { kind: 'road_fit', fit, drafts: [] } });
  }
  const written = [];
  try {
    for (const group of fit.suggestions) {
      written.push(await writeTemplateDraft({ ...base, name: group.name, skeleton: suggestionDraft(result.road, group) }));
    }
  } catch (error) {
    if (!(error instanceof DraftWriteError)) throw error;
    return createPacket({
      ...packetBase,
      status: 'error',
      data: { kind: 'findings', reason: 'draft_not_written', drafts: written.map(({ path }) => path) },
      findings: [{ code: AUTHORING_FINDING_CODES.draft, severity: 'error', message: `${error.message}.`, file: error.path, line: null, detail: { path: error.path, reason: error.reason } }],
      changed: written.map(({ workflow_path: path }) => path),
    });
  }
  return createPacket({
    ...packetBase, status: 'ok', data: { kind: 'road_fit', fit, drafts: written.map(({ path }) => path) }, changed: written.map(({ workflow_path: path }) => path),
  });
}
