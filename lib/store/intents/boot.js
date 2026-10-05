// `boot` (A1 5.1): the Leader's one-call start. A query composed from the shared workflow model and the next-action builder: the Leader kernel
// files, the workflow in counts, the questions the user must answer, the class-fit blockers, the Roads that need a split and the pending scope
// requests, with the legal next commands. It writes nothing, not even a cache.
import { compareStrings } from '../../schemas/common.js';
import { buildNextData } from '../navigation/next.js';
import { readWorkflowModel } from '../navigation/model.js';
import { buildStatusData } from '../navigation/status.js';
import { createPathService } from '../path-service.js';
import { readRoad } from '../roads/repository.js';
import { openYield, readScope } from '../scope/index.js';
import { INTENT_NEXT_COMMAND_BUILDERS } from './next-commands.js';
import { BOOT_SCHEMA, KERNEL_FILES } from './policy.js';
import { readFile } from 'node:fs/promises';

const KERNEL_MAX_BYTES = 16_384;

async function readKernelFile(service, workflowPath) {
  let resolved;
  try {
    resolved = await service.resolveWorkflowPath(workflowPath);
  } catch {
    return null;
  }
  if (!resolved.exists || !resolved.case_matches) return null;
  const bytes = await readFile(resolved.filesystem_path);
  const readable = bytes.length <= KERNEL_MAX_BYTES && !bytes.includes(0);
  return { path: resolved.actual_relative_path, bytes: bytes.length, text: readable ? bytes.toString('utf8').replace(/^﻿/, '') : null };
}

// options: { repositoryRoot, workflowRoot, env?, rootArgs? } -> { status, data, findings, nextCommands }
export async function buildBoot({ repositoryRoot, workflowRoot, env = process.env, rootArgs = [] }) {
  const base = { repositoryRoot, workflowRoot };
  const model = await readWorkflowModel({ ...base, env, rootArgs });
  const status = buildStatusData(model);
  const next = await buildNextData(model, { ...base, executor: null });
  const service = await createPathService(base);
  const kernel = {};
  for (const [name, path] of Object.entries(KERNEL_FILES)) kernel[name] = await readKernelFile(service, path);

  const questions = [];
  const roleLabel = { leader: 'Leader', worker: 'Worker' };
  if (model.executors_read.exists && model.executors_read.meta_state !== 'declared') {
    questions.push({ kind: 'classify_executors', subject: 'executors.json', text: 'executors.json does not verify; ask the user which models are the Leader, the Worker and the Tester and how each is classified (weak, medium or frontier), then record them with executor set.' });
  } else if (model.executors_read.unclassified) {
    const have = new Set(model.executors.map(({ role }) => role));
    for (const role of ['leader', 'worker']) {
      if (!have.has(role)) {
        questions.push({ kind: 'classify_executors', subject: role, text: `Ask the user which model will be the ${roleLabel[role]} and how to classify it: weak, medium or frontier; record the answer verbatim with executor set.` });
      }
    }
  }
  const open = [...model.roads].filter(({ status: roadStatus }) => roadStatus !== 'DONE');
  const classesWithoutWorker = [...new Set(open.flatMap((road) => road.blockers.filter(({ reason }) => reason === 'no_executor_for_class').map(({ subject }) => subject)))].sort(compareStrings);
  for (const cls of classesWithoutWorker) {
    questions.push({ kind: 'no_worker_for_class', subject: cls, text: `No Worker of class ${cls} is recorded but a Road needs one: ask the user which model will execute ${cls} Roads and record it with executor set.` });
  }
  const needsSplit = [];
  for (const road of model.roads.filter(({ needs_split: split }) => split)) {
    let yielded = null;
    const found = await readRoad({ ...base, id: road.id }).catch(() => null);
    if (found !== null) {
      const scope = await readScope({ ...base, road: road.id });
      yielded = openYield(scope.records, found.road.meta?.content_hash ?? null);
    }
    needsSplit.push({ road: road.id, holder: yielded === null ? null : yielded.holder, reason: yielded === null ? null : yielded.reason });
    if (yielded !== null) {
      questions.push({ kind: 'yielded_road', subject: road.id, text: `${yielded.holder} yielded Road ${road.id}: ${yielded.reason} Split or change it (road fit ${road.id} --write-drafts, road update) before it is worked again.` });
    }
  }
  const classFitBlockers = open
    .map((road) => ({ road: road.id, class: road.executor_class, reasons: road.blockers.filter(({ reason }) => ['class_fit', 'executor_class_missing', 'no_executor_for_class'].includes(reason)).map(({ reason, subject }) => ({ reason, subject: subject ?? null })) }))
    .filter(({ reasons }) => reasons.length > 0);

  return {
    status: 'ok',
    data: {
      kind: 'boot',
      packet_version: BOOT_SCHEMA,
      role: 'leader',
      kernel: Object.fromEntries(Object.keys(KERNEL_FILES).map((name) => [name, kernel[name]])),
      workflow: {
        roads: { total: status.roads.total, by_status: status.roads.by_status, unverified: status.roads.unverified },
        plans: { total: status.plans.length, closed: status.plans.filter(({ closure }) => closure === 'closed').length },
        executors: status.executors,
        leases: status.leases,
      },
      questions_for_user: questions.sort((left, right) => compareStrings(left.kind, right.kind) || compareStrings(left.subject, right.subject)),
      class_fit_blockers: classFitBlockers,
      needs_split: needsSplit,
      pending_scope_requests: model.pending,
      next: next.data,
    },
    findings: [],
    nextCommands: INTENT_NEXT_COMMAND_BUILDERS.boot({ phase: 'ready', next: next.next.map(({ command, args }) => ({ command, args: [...args, ...rootArgs] })) }),
  };
}

