// `init --scaffold`: build the minimal workflow with the shared builders, write it in ONE transaction, and add the managed
// .gitignore block. Judged under the repository lock like every workflow mutation.
import { mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { createPacket } from '../../core/packet.js';
import { createDefaultProviders } from '../../core/providers.js';
import { isId } from '../../schemas/common.js';
import { readExecutors } from '../executors/repository.js';
import { runMutationFlow } from '../mutation-flow.js';
import { applyManagedBlockToFile } from '../managed-block.js';
import { createPathService } from '../path-service.js';
import { sortedFindings } from '../roads/update.js';
import { buildScaffold } from './build.js';
import { CLASSIFY_QUESTION, GITIGNORE_BLOCK_ID, GITIGNORE_FILE, GITIGNORE_LINES, SCAFFOLD_FINDING_CODE } from './policy.js';
import { SCAFFOLD_NEXT_COMMAND_BUILDERS } from './next-commands.js';

const COMMAND = 'init-scaffold';
const SCHEMA = 'akrs.scaffold/v1';
const builder = SCAFFOLD_NEXT_COMMAND_BUILDERS[COMMAND];

const guard = ({ reason, path, message }) => ({
  code: SCAFFOLD_FINDING_CODE, severity: 'error', message, file: path, line: null, detail: { reason, path },
});

// options: { repositoryRoot, workflowRoot, plan?, road?, force?, requestId?, dryRun?, providers?, knownCommands, rootArgs?, boundary?, lockOptions? }
export async function scaffoldWorkflow(options) {
  const {
    repositoryRoot, workflowRoot, plan = null, road = null, force = false, requestId, dryRun = false,
    providers = createDefaultProviders(), knownCommands, boundary, lockOptions, rootArgs = [],
  } = options;
  const root = options.root ?? repositoryRoot;
  const usage = (message) => ({
    outcome: 'rejected',
    packet: createPacket({
      command: COMMAND, requestId: null, status: 'error', root, snapshot: { before: null, after: null },
      data: { kind: 'usage', reason: 'invalid_input', schema: SCHEMA, missing_inputs: [] },
      findings: [{ code: 'AKRS-C001', severity: 'error', message, file: null, line: null, detail: { reason: message } }],
      nextCommands: builder({ phase: 'rejected', rootArgs }), providers, knownCommands,
    }),
  });
  if (plan !== null && !isId(plan)) return usage('--plan must be a valid ID');
  if (road !== null && !isId(road)) return usage('--road must be a valid ID');

  const exists = existsSync(workflowRoot) && statSync(workflowRoot).isDirectory();
  if (!exists && !dryRun) await mkdir(workflowRoot, { recursive: true });
  const present = exists || !dryRun;
  const workflowRelative = (await workflowRelativeOf({ repositoryRoot, workflowRoot, exists: present }));
  let built;
  try {
    built = buildScaffold({ workflowRelative, plan, road, now: providers.now() });
  } catch (error) {
    if (error instanceof TypeError) return usage(error.message);
    throw error;
  }
  const summary = {
    tier: built.tier, plan_id: built.plan_id, road_id: built.road_id, task_id: built.task_id, key: built.key, files: built.files.map(({ path }) => path),
  };
  const questions = async () => ((await readExecutors({ repositoryRoot, workflowRoot })).unclassified ? [{ id: 'classify_executors', question: CLASSIFY_QUESTION }] : []);

  if (!present) {
    // Nothing exists yet, so nothing can be refused or replayed: report the plan of a dry run without creating the folder.
    return {
      outcome: 'dry_run',
      packet: createPacket({
        command: COMMAND, requestId: null, status: 'ok', root, snapshot: { before: null, after: null },
        data: { kind: 'init_scaffold', dry_run: true, scaffold: summary, would_change: summary.files, gitignore: null, questions_for_user: [{ id: 'classify_executors', question: CLASSIFY_QUESTION }] },
        findings: [], nextCommands: builder({ phase: 'created', rootArgs }), providers, knownCommands,
      }),
    };
  }

  const render = async (context) => {
    const service = await createPathService({ repositoryRoot, workflowRoot });
    const present = [];
    for (const { path } of built.files) {
      const resolved = await service.resolveWorkflowPath(path);
      if (resolved.exists) present.push({ path, resolved });
    }
    if (present.length > 0 && !force) {
      return {
        rejection: {
          kind: 'findings',
          reason: 'proposal_rejected',
          findings: sortedFindings(present.map(({ path, resolved }) => guard({
            reason: 'target_exists', path: resolved.actual_relative_path, message: `${path} already exists; init --scaffold writes only into an empty target (use --force to replace exactly these files).`,
          }))),
        },
      };
    }
    const replacing = new Set(present.map(({ path }) => path));
    const gitignore = await applyManagedBlockToFile(service, GITIGNORE_FILE, {
      dryRun: context.preview === true || dryRun, id: GITIGNORE_BLOCK_ID, style: 'hash', content: `${GITIGNORE_LINES.join('\n')}\n`,
    });
    return {
      operations: built.files.map(({ path, content }) => ({ type: replacing.has(path) ? 'replace' : 'create', path, content })),
      data: {
        kind: 'init_scaffold', dry_run: false, scaffold: summary, gitignore: { path: gitignore.path, outcome: gitignore.outcome }, questions_for_user: await questions(),
      },
      nextCommands: builder({ phase: 'created', rootArgs }),
      proposed: { scaffold: summary },
    };
  };

  return runMutationFlow({
    command: COMMAND, repositoryRoot, workflowRoot, root, providers, knownCommands,
    requestInput: { schema: SCHEMA, plan, road, force }, requestId, dryRun, schema: SCHEMA, boundary, lockOptions,
    retryCommands: () => builder({ phase: 'rejected', rootArgs }), render,
  });
}

async function workflowRelativeOf({ repositoryRoot, workflowRoot, exists }) {
  if (exists) return (await createPathService({ repositoryRoot, workflowRoot })).workflow_relative_path;
  const relative = workflowRoot.slice(repositoryRoot.length).replace(/^[\\/]+/, '').replaceAll('\\', '/');
  return relative;
}

