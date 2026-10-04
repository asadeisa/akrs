import { FINDING_SEVERITIES, compareStrings } from '../schemas/common.js';
import {
  isPlainObject,
  issue,
  validateClosedObject,
  validateJsonValue,
  validationResult,
} from '../schemas/validation.js';

export const FINDING_CODE_FAMILIES = Object.freeze({
  R: 'road',
  M: 'memory',
  S: 'state',
  G: 'git',
  C: 'command',
  T: 'tester',
});

export const FINDING_FAMILY_DESCRIPTIONS = Object.freeze({
  R: 'Road contracts: Road, Task, scope request and scope resolution schemas, the write envelope, class fit and readiness.',
  M: 'Memory: records, labels, topics and the pointers that justify them.',
  S: 'Workflow state and the control plane: the state file, Plan files, closure records, and the executor registry and class overrides.',
  G: 'Git: the audit of what changed against what was declared.',
  C: 'Commands and the input channel: the command manifest, usage, workflow root and agent-authored input documents.',
  T: 'Tester: verification contracts, scenarios, handoffs, run records, results and evidence.',
});

export const FINDING_CATALOG_KEYS = Object.freeze([
  'code',
  'category',
  'severity',
  'rationale',
  'data_schema',
  'remediation',
]);

function objectSchema(properties, required = Object.keys(properties)) {
  return {
    type: 'object',
    required,
    properties,
    additionalProperties: false,
  };
}

const string = { type: 'string' };
const stringArray = { type: 'array', items: { type: 'string' } };

// Permanent schema-violation data (Q24): the artifact schema ID, the RFC 6901 pointer, and "<code>: <message>".
function schemaViolationData() {
  return objectSchema({ schema: string, pointer: string, issue: string });
}

const definitions = [
  {
    code: 'AKRS-C001',
    category: 'command',
    severity: 'error',
    rationale: 'The command line does not match the closed command manifest.',
    data_schema: objectSchema({ reason: string }),
    remediation: 'Correct the command or arguments shown by manifest-backed help and retry.',
  },
  {
    code: 'AKRS-C003',
    category: 'command',
    severity: 'error',
    rationale: 'The selected workflow root does not exist or is not readable as a directory.',
    data_schema: objectSchema({ reason: string }),
    remediation: 'Select an existing workflow with --workflow-root or create one with init.',
  },
  {
    code: 'AKRS-C004',
    category: 'command',
    severity: 'error',
    rationale: 'The command or renderer failed outside a declared product outcome.',
    data_schema: objectSchema({ reason: string }),
    remediation: 'Inspect the diagnostic reason, preserve the input, and report the internal failure.',
  },
  {
    code: 'AKRS-C005',
    category: 'command',
    severity: 'warning',
    rationale: 'A validation check stopped before it could complete its declared coverage.',
    data_schema: objectSchema({ check: string, error: string }),
    remediation: 'Restore readable input or fix the check failure, then run validation again.',
  },
  {
    code: 'AKRS-C006',
    category: 'command',
    severity: 'warning',
    rationale: 'A declared path differs in case from the filesystem entry and would behave differently across hosts.',
    data_schema: objectSchema({ actual_path: string, expected_path: string }),
    remediation: 'Change the declared path to exactly match the filesystem entry case.',
  },
  {
    code: 'AKRS-C007',
    category: 'command',
    severity: 'warning',
    rationale: 'An installed doctrine file was preserved because it was edited locally, was never installed by AKRS, or sits where the doctrine cannot be written safely.',
    data_schema: objectSchema({ path: string, reason: string, other_path: string }, ['path', 'reason']),
    remediation: 'Review the file. A v1 install has no ownership record, so AKRS cannot tell your edits from older packaged text and reports unowned_differs for every file that differs; sync keeps them. Options: keep the local file (it is reported again on each sync and never overwritten), delete it and run sync to restore the packaged copy, or run init --force, which replaces all of docs/akrs and discards every local edit there. For case_collision, rename or remove one of the two spellings named in the finding.',
  },
  {
    code: 'AKRS-R001',
    category: 'road',
    severity: 'error',
    rationale: 'Duplicate Road identities make dependency lookup ambiguous and lossy.',
    data_schema: objectSchema({ road_id: string, conflicting_files: stringArray }),
    remediation: 'Assign a unique Road identity to every Road before resolving references.',
  },
  {
    code: 'AKRS-R002',
    category: 'road',
    severity: 'error',
    rationale: 'A legacy Road has no readable Status line.',
    data_schema: objectSchema({ road_id: string }),
    remediation: 'Add an explicit legal Road status.',
  },
  {
    code: 'AKRS-R003',
    category: 'road',
    severity: 'error',
    rationale: 'A legacy Road status is outside the characterized lifecycle vocabulary.',
    data_schema: objectSchema({ road_id: string, status: string }),
    remediation: 'Use QUEUED, ACTIVE, or DONE superseded by <memory> for the legacy Road.',
  },
  {
    code: 'AKRS-R004',
    category: 'road',
    severity: 'warning',
    rationale: 'Required Expected files input was unreadable by the retained legacy parser.',
    data_schema: objectSchema({ road_id: string, parser: string }),
    remediation: 'Treat the check as skipped; do not infer success from zero parsed inputs.',
  },
  {
    code: 'AKRS-R005',
    category: 'road',
    severity: 'error',
    rationale: 'A Road dependency names no registered Road identity.',
    data_schema: objectSchema({ road_id: string, dependency: string, status: string }),
    remediation: 'Correct the dependency identity or add the missing Road.',
  },
  {
    code: 'AKRS-R006',
    category: 'road',
    severity: 'error',
    rationale: 'The Road dependency graph contains a cycle and cannot define an execution order.',
    data_schema: objectSchema({ cycle: stringArray }),
    remediation: 'Remove or redirect at least one dependency edge in the reported cycle.',
  },
  {
    code: 'AKRS-R007',
    category: 'road',
    severity: 'error',
    rationale: 'An ACTIVE Road depends on a Road that is not DONE.',
    data_schema: objectSchema({ road_id: string, dependency: string, dependency_status: string }),
    remediation: 'Finish the dependency or return the dependent Road to QUEUED.',
  },
  {
    code: 'AKRS-R008',
    category: 'road',
    severity: 'warning',
    rationale: 'An ACTIVE legacy Road names an Expected path that is not present.',
    data_schema: objectSchema({ road_id: string, expected_path: string, status: string }),
    remediation: 'Create the declared path or correct the legacy Road declaration.',
  },
  {
    code: 'AKRS-R009',
    category: 'road',
    severity: 'error',
    rationale: 'A DONE legacy Road names an Expected path that is no longer present.',
    data_schema: objectSchema({ road_id: string, expected_path: string, status: string }),
    remediation: 'Restore the path or explicitly retire and supersede the stale Road contract.',
  },
  {
    code: 'AKRS-R010',
    category: 'road',
    severity: 'error',
    rationale: 'A legacy Road declares an unsafe Expected path that cannot be resolved inside the repository.',
    data_schema: objectSchema({ road_id: string, expected_path: string, reason: string }),
    remediation: 'Replace the declaration with a normalized repository-relative contained path.',
  },
  {
    code: 'AKRS-C008',
    category: 'command',
    severity: 'error',
    rationale: 'An agent-authored input document violates the closed schema it names or the input channel rules.',
    data_schema: schemaViolationData(),
    remediation: 'Run the template command for this kind, fill the named pointer, and resubmit the document unchanged otherwise.',
  },
  {
    code: 'AKRS-C009',
    category: 'command',
    severity: 'error',
    rationale: 'The repository lock could not be taken within the wait budget: another process holds it, its owner record is missing, partial or invalid, or it was taken on another host. A lock is never reclaimed from age alone.',
    data_schema: objectSchema({
      holder: {
        type: ['object', 'null'],
        required: ['pid', 'host', 'run_id', 'command', 'acquired_at'],
        properties: {
          pid: { type: 'integer' },
          host: string,
          run_id: string,
          command: string,
          acquired_at: string,
        },
        additionalProperties: false,
      },
      reason: { type: 'string', enum: ['held', 'corrupt', 'foreign_host'] },
    }),
    remediation: 'Wait for the holder to finish and retry. A holder that died on this host is recovered automatically. If the holder is gone but the lock is on another host, or its owner record is corrupt, a human removes it with the store function breakLock({ workflowRoot, expectedRunId }), passing the holder run_id from this finding (expectedRunId null for a corrupt owner record); a CLI command for this arrives in a later release. A pid reused by an unrelated process also keeps the lock held until it is broken that way.',
  },
  {
    code: 'AKRS-C010',
    category: 'command',
    severity: 'error',
    rationale: 'A request ID was reused for a different request than the one that first used it: its command, target, input or explicit expected snapshot differs. A request ID names exactly one normalized request, so nothing was written.',
    data_schema: objectSchema({ request_id: string, recorded_request_hash: string, supplied_request_hash: string }),
    remediation: 'Retry the exact original request to get its recorded result as a noop, or send the different request with a new request ID (omit the request ID to let the CLI generate one).',
  },
  {
    code: 'AKRS-C011',
    category: 'command',
    severity: 'error',
    rationale: 'An earlier mutation recorded a transaction and stopped before it finished, so no mutation may begin until that transaction is recovered or rolled back. Blocking every mutation, not only the same request ID, keeps a half-applied change from being built on.',
    data_schema: objectSchema({ request_id: string, transaction: string }),
    remediation: 'Recover the transaction named in the finding before retrying; a CLI command for transaction recovery arrives with the transaction protocol in a later release. Do not delete journal or transaction files by hand.',
  },
  {
    code: 'AKRS-C012',
    category: 'command',
    severity: 'error',
    rationale: 'A Road or Plan lease is held by another executor. One executor holds a lease at a time and it never expires on its own.',
    data_schema: objectSchema({
      kind: { type: 'string', enum: ['road', 'plan'] },
      target: string,
      holder: string,
      requested_by: string,
    }),
    remediation: 'Wait for the holder to finish, ask the Leader to release the lease, or take it over explicitly with a takeover claim.',
  },
  {
    code: 'AKRS-C013',
    category: 'command',
    severity: 'error',
    rationale: 'The snapshot a mutation was guarded by, an explicit expected snapshot or the snapshot recorded in the holder\'s lease, no longer matches the workflow, so the mutation was blocked instead of applied to newer state.',
    data_schema: objectSchema({
      source: { type: 'string', enum: ['explicit', 'lease'] },
      expected: { type: ['string', 'null'] },
      current: { type: ['string', 'null'] },
      delta: {
        type: ['object', 'null'],
        required: ['changed', 'added', 'removed'],
        properties: { changed: stringArray, added: stringArray, removed: stringArray },
        additionalProperties: false,
      },
    }),
    remediation: 'Re-read the current state (for a lease holder, run work or test run again, which refreshes the lease), review the delta, and retry with the new snapshot.',
  },
  {
    code: 'AKRS-C014',
    category: 'command',
    severity: 'error',
    rationale: 'An interrupted multi-file transaction cannot be proven safe to finish or to undo: its manifest is corrupt, a staged before or after image the recovery needs is missing or does not match its recorded hash, the final packet was lost after the commit marker, or a target holds bytes that are neither the old nor the new image. Recovery never guesses, so it wrote nothing and every mutation stays blocked.',
    data_schema: objectSchema({
      transaction: string,
      request_id: { type: ['string', 'null'] },
      reason: {
        type: 'string',
        enum: [
          'committed_without_journal', 'directory_missing', 'image_corrupt', 'image_missing', 'journal_mismatch',
          'manifest_corrupt', 'packet_corrupt', 'packet_missing', 'scratch_unsafe', 'target_unexpected',
        ],
      },
      path: { type: ['string', 'null'] },
    }),
    remediation: 'Inspect the file named by path under the workflow .ops/tx directory. If it was damaged by hand or by the disk, restore it from a backup or from version control and retry any mutation, which resumes recovery. If the target bytes were edited after the interruption, put them back to the old or the new content. Do not delete .ops/tx or .ops/journal by hand.',
  },
  {
    code: 'AKRS-C015',
    category: 'command',
    severity: 'error',
    rationale: 'The files a mutation proposed to write cannot be applied as one transaction: a path is unsafe or escapes the workflow root, lives in a reserved namespace (.ops, .cache, drafts, evidence), is a link or a directory, appears twice, or the operation does not fit the current files (create over an existing file, replace or delete of a missing one, a malformed operation). It was found before anything was staged, so nothing was written.',
    data_schema: objectSchema({ path: { type: ['string', 'null'] }, reason: string }),
    remediation: 'Fix the proposed path or operation named in the finding; targets are workflow-relative artifact paths, and a draft may only be deleted.',
  },
  {
    code: 'AKRS-M001',
    category: 'memory',
    severity: 'error',
    rationale: 'A Memory input or record violates its closed schema: label, owner, pointers or text.',
    data_schema: schemaViolationData(),
    remediation: 'Fix the field at the reported pointer; Decided needs decided_by, Unknown needs an owner Plan and no pointers.',
  },
  {
    code: 'AKRS-M002',
    category: 'memory',
    severity: 'error',
    rationale: 'A pointer a proposed Memory record declares cannot be used as written: it resolves outside the repository through a link, differs in case from the file system entry, does not exist, or is a line window the file cannot satisfy (the file is a directory or not UTF-8 text, or has fewer lines than the window ends at). A pointer is the evidence for a Decided or Assumption record, so it must exist. Nothing was written.',
    data_schema: objectSchema({
      pointer: string,
      path: string,
      reason: { type: 'string', enum: ['case_mismatch', 'missing', 'not_file', 'not_text', 'out_of_range', 'unsafe'] },
      line_count: { type: ['integer', 'null'] },
    }),
    remediation: 'Fix the pointer at the reported location: spell the path exactly as it exists on disk, keep it inside the repository, point at a file or folder that exists, and end a window at a line the file really has.',
  },
  {
    code: 'AKRS-M003',
    category: 'memory',
    severity: 'error',
    rationale: 'The Memory file of the record\'s topic cannot take a new record: its name differs from memory/<topic>.md only in case, it is a directory, not UTF-8 text or reached through a link, or its record table is not the last thing in the file, so an appended row would fall outside the table and be lost to every reader. Nothing was written.',
    data_schema: objectSchema({
      pointer: string,
      topic: string,
      path: string,
      reason: { type: 'string', enum: ['case_mismatch', 'not_file', 'not_text', 'table_not_last', 'unsafe'] },
    }),
    remediation: 'Fix the file named in the finding: remove the lines after the last record row so the table ends the file, rename the file to the exact topic spelling, or choose another topic. The CLI never rewrites existing Memory bytes.',
  },
  {
    code: 'AKRS-R011',
    category: 'road',
    severity: 'error',
    rationale: 'A Road, Task, scope request or scope resolution violates its closed schema or the write envelope.',
    data_schema: schemaViolationData(),
    remediation: 'Fix the field at the reported pointer; rewrite the Road from the road template instead of editing around the error.',
  },
  {
    code: 'AKRS-R012',
    category: 'road',
    severity: 'error',
    rationale: 'A path a proposed Road declares cannot be used as written: it resolves outside the repository through a link, differs in case from the file system entry, or is a read window the file cannot satisfy (the file is missing, is a directory or not UTF-8 text, or has fewer lines than the window ends at). Nothing was written.',
    data_schema: objectSchema({
      pointer: string,
      path: string,
      reason: { type: 'string', enum: ['case_mismatch', 'missing', 'not_file', 'not_text', 'out_of_range', 'unsafe'] },
      line_count: { type: ['integer', 'null'] },
    }),
    remediation: 'Fix the declared path or window at the reported pointer: spell the path exactly as it exists on disk, keep it inside the repository, and end a window at a line the file really has. A read of a file that does not exist yet is allowed only without lines.',
  },
  {
    code: 'AKRS-R013',
    category: 'road',
    severity: 'error',
    rationale: 'A proposed Task or Road is not bound consistently to the artifacts around it: the Road does not exist or cannot be read, does not declare this Task or this Plan, the Task file already exists, or the named Plan is the ID of a Road. Plan and Road IDs share one namespace, and a Task only ever scaffolds the Task its Road declares. Nothing was written.',
    data_schema: objectSchema({
      pointer: string,
      reason: {
        type: 'string',
        enum: [
          'plan_mismatch', 'plan_names_a_road', 'road_declares_no_task', 'road_missing', 'road_unreadable', 'task_exists',
          'task_id_mismatch',
        ],
      },
      subject: string,
      expected: { type: ['string', 'null'] },
      actual: { type: ['string', 'null'] },
    }),
    remediation: 'Make the Task document and its Road agree: create the Road first with the Task ID in its task field, use the Road plan, or choose another ID. An existing Task file is never overwritten.',
  },
  {
    code: 'AKRS-C016',
    category: 'command',
    severity: 'error',
    rationale: 'A draft could not be written because a file already exists at that name, or the drafts folder cannot be used safely (a link or a file stands in its place). A draft is the agent\'s own file, so it is never overwritten.',
    data_schema: objectSchema({ path: string, reason: { type: 'string', enum: ['exists', 'unsafe'] } }),
    remediation: 'Choose another draft name, or edit or delete the existing draft yourself and run the command again.',
  },
  {
    code: 'AKRS-C017',
    category: 'command',
    severity: 'warning',
    rationale: 'A draft file is left in akrs/drafts: drafts are scratch input for a command, consumed when it succeeds. A left-over draft is stale, is never parsed as a canonical artifact and is excluded from snapshots and the git audit.',
    data_schema: objectSchema({
      path: string,
    }),
    remediation: 'Submit it with the command it was written for (for example road new --input <draft>) or delete it.',
  },
  {
    code: 'AKRS-R014',
    category: 'road',
    severity: 'error',
    rationale: 'A Road change was refused by its guard and nothing was written: an update that changes the ID, status or Plan, a removal without a reason, a patch operation whose target is missing or already there, a write that collides with another ACTIVE Road, a scope request or resolution that names no usable Road, request or ledger, or a move that has nowhere to go.',
    data_schema: objectSchema({
      reason: {
        type: 'string',
        enum: [
          'id_changed', 'ledger_unusable', 'no_change', 'no_pending', 'nothing_to_add', 'patch_target_exists', 'patch_target_missing',
          'plan_changed', 'plan_names_a_road', 'removal_reason_missing', 'request_ambiguous', 'request_missing', 'request_resolved',
          'road_active', 'road_done', 'road_missing', 'road_unverified', 'status_changed', 'target_exists', 'write_collision',
        ],
      },
      subject: string,
      pointer: { type: ['string', 'null'] },
      expected: { type: ['string', 'null'] },
      actual: { type: ['string', 'null'] },
    }),
    remediation: 'Read the reason: keep id, status and plan as they are (use road move for the Plan, the lifecycle commands for status), state a --reason for every removal, fix the patch operation, choose writes that do not overlap another ACTIVE Road, or name the Road or request the scope command is about.',
  },
  {
    code: 'AKRS-R015',
    category: 'road',
    severity: 'error',
    rationale: 'A Road does not fit the class of its executor: it exceeds a class limit (writes, write directories, read budget), uses a write path class the class may not use, or lacks the steps or check a weak class requires. The Road was written; the finding is an error unless an oversize_reason is declared, then it is reported as a warning. Readiness blocks on it.',
    data_schema: objectSchema({
      road: string,
      class: { type: 'string', enum: ['frontier', 'medium', 'weak'] },
      knob: { type: 'string', enum: ['check_required', 'max_write_dirs', 'max_writes', 'read_budget_tokens', 'steps_required', 'write_classes'] },
      limit: { type: ['integer', 'string'] },
      actual: { type: ['integer', 'string'] },
      oversize: { type: 'boolean' },
    }),
    remediation: 'Split the Road (road fit shows deterministic suggestions; --write-drafts saves them), or, with a frontier Leader, state an oversize_reason. A weak Road needs ordered steps, a check and file-class writes only.',
  },
  {
    code: 'AKRS-R016',
    category: 'road',
    severity: 'error',
    rationale: 'An oversize_reason was refused and nothing was written: the Leader executor is classified weak or medium, and only a frontier Leader may declare an oversized Road.',
    data_schema: objectSchema({
      road: string,
      reason: { type: 'string', enum: ['oversize_leader_class'] },
      class: { type: 'string', enum: ['medium', 'weak'] },
    }),
    remediation: 'Remove the oversize_reason and split the Road to fit the executor class (road fit).',
  },
  {
    code: 'AKRS-R017',
    category: 'road',
    severity: 'error',
    rationale: 'A DONE Road declares a file write (create or modify) whose file is not in the repository, so the declared work is not there.',
    data_schema: objectSchema({
      road: string,
      path: string,
      action: { type: 'string', enum: ['create', 'modify'] },
      status: { type: 'string', enum: ['DONE'] },
    }),
    remediation: 'Restore the file, or reopen the Road and correct its writes if the work moved.',
  },
  {
    code: 'AKRS-R018',
    category: 'road',
    severity: 'warning',
    rationale: 'A scope request is still pending: the Worker asked for more reads or writes than the Road declares and no decision has been recorded.',
    data_schema: objectSchema({
      road: string,
      request: string,
      blocking: { type: 'boolean' },
    }),
    remediation: 'Decide it with scope approve or scope reject (scope list shows what is pending).',
  },
  {
    code: 'AKRS-R019',
    category: 'road',
    severity: 'error',
    rationale: 'A v1 Markdown Road file sits in the workflow. Roads are JSON artifacts written by the CLI; the Markdown form is never parsed, so the Road does not exist for validation, readiness or audit.',
    data_schema: objectSchema({
      path: string,
    }),
    remediation: 'Recreate the Road with road new (road template shows the skeleton) and remove the Markdown file.',
  },
  {
    code: 'AKRS-R020',
    category: 'road',
    severity: 'error',
    rationale: 'road-details is blocked: a source the packet must join is absent, unverified, ambiguous or unresolved. The packet reports it and keeps its data complete; it never returns a shorter list that looks complete.',
    data_schema: objectSchema({
      road: string,
      reason: { type: 'string', enum: ['dependency_missing', 'executors_unusable', 'read_unresolved', 'road_ambiguous', 'road_unverified', 'snapshot_unstable'] },
      subject: { type: ['string', 'null'] },
      index: { type: ['integer', 'null'] },
      status: { type: ['string', 'null'] },
    }),
    remediation: 'Fix the named source (restore the file, correct the declared read, make the dependency exist, or repair the Road with road update) and ask for the packet again.',
  },
  {
    code: 'AKRS-R021',
    category: 'road',
    severity: 'error',
    rationale: 'The complete road-details packet is larger than --max-tokens. Nothing was shortened: the packet is refused so no agent works from a partial contract.',
    data_schema: objectSchema({
      road: string,
      role: { type: 'string', enum: ['leader', 'worker'] },
      max_tokens: { type: 'integer' },
      packet_tokens: { type: 'integer' },
    }),
    remediation: 'Ask again without --max-tokens or with a larger one, or have the Leader split the Road (road fit) so its packet fits the executor.',
  },
  {
    code: 'AKRS-R022',
    category: 'road',
    severity: 'warning',
    rationale: 'A declared read is an ephemeral file that its producer already consumed: it is gone by design, so it is reported as consumed and not as missing.',
    data_schema: objectSchema({
      road: string,
      reason: { type: 'string', enum: ['consumed'] },
      index: { type: 'integer' },
      path: string,
      declared_by: string,
    }),
    remediation: 'Do not look for the file; if the Road still needs its content, the Leader should declare the canonical source instead.',
  },
  {
    code: 'AKRS-S001',
    category: 'state',
    severity: 'error',
    rationale: 'The state file, a Plan file, a closure record or the executor registry violates its closed schema.',
    data_schema: schemaViolationData(),
    remediation: 'Fix the field at the reported pointer through the owning command; never hand-edit CLI-owned keys.',
  },
  {
    code: 'AKRS-S002',
    category: 'state',
    severity: 'error',
    rationale: 'The closure ledger already holds a DONE record of this Road or Plan, so a second record of the same subject is refused. A closure is recorded once (B26: the same Road closed twice). Nothing was written.',
    data_schema: objectSchema({
      kind: { type: 'string', enum: ['road', 'plan'] },
      subject: string,
      outcome: { type: 'string', enum: ['DONE', 'BLOCKED'] },
      record: string,
      path: string,
      line: { type: 'integer' },
    }),
    remediation: 'Do not close the subject again. If the first closure was wrong, reopen the Road through its lifecycle command instead of appending a second record; the ledger is append-only and never edited.',
  },
  {
    code: 'AKRS-S003',
    category: 'state',
    severity: 'error',
    rationale: 'A closure ledger segment cannot take a new record: it is not UTF-8 text, not a regular file or reached through a link, holds a line that is not a valid closure record, or does not end with a newline, so the duplicate check and the append cannot be trusted. Nothing was written.',
    data_schema: objectSchema({
      path: string,
      reason: { type: 'string', enum: ['invalid_record', 'no_final_newline', 'not_file', 'not_text', 'unreadable', 'unsafe'] },
      line: { type: ['integer', 'null'] },
    }),
    remediation: 'Restore the segment named in the finding from version control (archived segments are never edited by hand), then run the command again.',
  },
  {
    code: 'AKRS-T001',
    category: 'tester',
    severity: 'error',
    rationale: 'A verification contract, scenario step, handoff, run record or Tester result violates its closed schema.',
    data_schema: schemaViolationData(),
    remediation: 'Fix the field at the reported pointer; scenario steps use only the closed step vocabulary.',
  },
  {
    code: 'AKRS-T002',
    category: 'tester',
    severity: 'error',
    rationale: 'A Tester source write was refused by its guard and nothing was written: the verification key names no Plan or Road, an applicable Road is missing, unverified or belongs elsewhere, a declared read cannot be resolved, a contract replacement lacks its snapshot or changes nothing, a handoff names a Road that has not started, or the handoff ledger cannot take a record.',
    data_schema: objectSchema({
      reason: {
        type: 'string',
        enum: [
          'ledger_unusable', 'no_change', 'read_unresolved', 'road_missing', 'road_not_started', 'road_unverified', 'road_wrong_plan',
          'snapshot_required', 'unknown_plan',
        ],
      },
      subject: string,
      pointer: { type: ['string', 'null'] },
      expected: { type: ['string', 'null'] },
      actual: { type: ['string', 'null'] },
    }),
    remediation: 'Read the reason: name an existing Plan (or a Road without a Plan), list only Roads that belong to it, fix the read at the reported pointer, pass --if-snapshot when replacing a contract, or hand off only a Road that has started.',
  },
  {
    code: 'AKRS-S004',
    category: 'state',
    severity: 'error',
    rationale: 'A State write was refused and nothing was written: state.json is missing or cannot be the source of truth (not canonical text, breaks its schema or fails its content hash), STATE.md cannot be replaced, or the proposed State and STATE.md equal what is stored.',
    data_schema: objectSchema({
      reason: { type: 'string', enum: ['no_change', 'render_unusable', 'state_missing', 'state_unusable'] },
      subject: string,
      actual: { type: ['string', 'null'] },
    }),
    remediation: 'Create a missing state.json with state set; restore an unusable state.json from version control; an unchanged State needs no write.',
  },
  {
    code: 'AKRS-S005',
    category: 'state',
    severity: 'error',
    rationale: 'An executor write was refused and nothing was written: executors.json cannot be changed (not canonical text, breaks its schema or fails its content hash), the named executor is not declared, or the proposed file equals the stored one.',
    data_schema: objectSchema({
      reason: { type: 'string', enum: ['executor_missing', 'file_unusable', 'no_change'] },
      subject: string,
    }),
    remediation: 'Name a declared executor (executor list), restore an unusable executors.json from version control, or skip a change that changes nothing.',
  },
  {
    code: 'AKRS-S006',
    category: 'state',
    severity: 'warning',
    rationale: 'No executor is classified: executors.json is missing or declares no leader or no worker. Road size and packet shape follow the executor class, which only the user can decide, so the CLI cannot guess it from a model name.',
    data_schema: objectSchema({
      has_leader: { type: 'boolean' },
      has_worker: { type: 'boolean' },
    }),
    remediation: 'Ask the user which model executes the work as Leader and as Worker and how they classify each (weak, medium or frontier), then record the answer with executor set <id> --role --class --label --answer.',
  },
  {
    code: 'AKRS-S007',
    category: 'state',
    severity: 'error',
    rationale: 'A CLI-written artifact is not what the CLI wrote: its content hash does not match (it was edited by hand), a ledger record does not verify, or the file cannot be read as the canonical form. It is reported as unverified and never trusted as a source of truth.',
    data_schema: objectSchema({
      kind: { type: 'string', enum: ['executors', 'handoff', 'log', 'memory', 'road', 'scope', 'state', 'verification'] },
      path: string,
      reason: { type: 'string', enum: ['hash_mismatch', 'invalid', 'unreadable'] },
      line: { type: ['integer', 'null'] },
    }),
    remediation: 'Restore the file from version control, or change it only through its command (road update, state set, executor set, test define) so the CLI rewrites it with a valid hash.',
  },
  {
    code: 'AKRS-S008',
    category: 'state',
    severity: 'warning',
    rationale: 'STATE.md does not equal the render of the canonical inputs: it is missing or stale (someone edited it, or a source changed since the last render). STATE.md is disposable output and never authoritative.',
    data_schema: objectSchema({
      path: string,
      reason: { type: 'string', enum: ['missing', 'stale'] },
    }),
    remediation: 'Run state render to rewrite STATE.md from the canonical artifacts.',
  },
  {
    code: 'AKRS-S009',
    category: 'state',
    severity: 'warning',
    rationale: 'The closure ledger and the Roads disagree: a DONE closure names a Road or Plan that does not exist, or a DONE Road has no DONE closure record.',
    data_schema: objectSchema({
      reason: { type: 'string', enum: ['closure_unknown_subject', 'done_without_closure'] },
      kind: { type: 'string', enum: ['plan', 'road'] },
      subject: string,
    }),
    remediation: 'Append the missing closure with log append, or reopen or restore the Road the closure names; the ledger itself is never edited.',
  },
  {
    code: 'AKRS-S010',
    category: 'state',
    severity: 'error',
    rationale: 'init --scaffold was refused and nothing was written: a file the scaffold would create already exists. The scaffold writes only into an empty target unless --force names the replacement.',
    data_schema: objectSchema({
      reason: { type: 'string', enum: ['target_exists'] },
      path: string,
    }),
    remediation: 'Keep the existing workflow, or run init --scaffold --force to replace exactly the files named in the findings (nothing else is touched).',
  },
  {
    code: 'AKRS-G001',
    category: 'git',
    severity: 'warning',
    rationale: 'The Road audit found a changed path the Road does not declare: it is outside the declared writes, matches a forbidden pattern, or differs from a declared file only in letter case. The audit is report-only and nothing was edited.',
    data_schema: objectSchema({
      reason: { type: 'string', enum: ['case_mismatch', 'forbidden', 'undeclared'] },
      path: string,
      declared_as: { type: ['string', 'null'] },
    }),
    remediation: 'Declare the path through a guarded Road update or a scope request, or revert the change; a forbidden path must be reverted.',
  },
  {
    code: 'AKRS-G002',
    category: 'git',
    severity: 'warning',
    rationale: 'The Road declares a file write that shows no change in git, so the declared work may not have happened (or happened in another path).',
    data_schema: objectSchema({
      reason: { type: 'string', enum: ['declared_absent'] },
      path: string,
      action: { type: 'string', enum: ['create', 'modify', 'delete'] },
    }),
    remediation: 'Make the declared change, or update the Road so its writes match the real work.',
  },
  {
    code: 'AKRS-G003',
    category: 'git',
    severity: 'warning',
    rationale: 'The control plane (akrs/) is ignored or only partly tracked by git, or there is no git repository (or program): commands that need committed workflow state cannot rely on it, worktrees and CI would not see it, and the Road audit is skipped (never a pass) when nothing is tracked.',
    data_schema: objectSchema({
      posture: { type: 'string', enum: ['git_unavailable', 'ignored', 'mixed', 'not_git'] },
      ignored: { type: 'integer' },
      tracked: { type: 'integer' },
    }),
    remediation: 'Track the workflow files (remove the ignore rule or git add -f them) if the project should keep akrs/ in git; otherwise accept the skipped audit and the recorded warning.',
  },
];

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export function validateFindingCatalog(value) {
  const issues = [];
  if (!Array.isArray(value) || value.length === 0) {
    issue(issues, '$', 'invalid_type', 'must be a non-empty array');
    return validationResult(issues);
  }

  const codes = new Set();
  value.forEach((entry, index) => {
    const path = `$[${index}]`;
    if (!validateClosedObject(entry, FINDING_CATALOG_KEYS, path, issues)) return;
    const match = typeof entry.code === 'string' && entry.code.match(/^AKRS-([RMSGCT])[0-9]{3}$/);
    if (!match) {
      issue(issues, `${path}.code`, 'invalid_format', 'must use a reserved AKRS finding family');
    } else {
      if (codes.has(entry.code)) issue(issues, `${path}.code`, 'duplicate_value', 'code must be unique');
      codes.add(entry.code);
      if (entry.category !== FINDING_CODE_FAMILIES[match[1]]) {
        issue(issues, `${path}.category`, 'invalid_value', 'category must match the code family');
      }
    }
    if (!FINDING_SEVERITIES.includes(entry.severity)) {
      issue(issues, `${path}.severity`, 'invalid_value', 'must be info, warning, or error');
    }
    for (const key of ['rationale', 'remediation']) {
      if (typeof entry[key] !== 'string' || entry[key].length === 0) {
        issue(issues, `${path}.${key}`, 'invalid_type', 'must be a non-empty string');
      }
    }
    if (!isPlainObject(entry.data_schema)) {
      issue(issues, `${path}.data_schema`, 'invalid_type', 'must be an object');
    } else {
      validateJsonValue(entry.data_schema, `${path}.data_schema`, issues);
    }
  });

  const ordered = value.map(({ code }) => code);
  if (ordered.some((code, index) => index > 0 && compareStrings(ordered[index - 1], code) >= 0)) {
    issue(issues, '$', 'invalid_order', 'catalog codes must be sorted and unique');
  }
  return validationResult(issues);
}

definitions.sort((left, right) => compareStrings(left.code, right.code));
const validation = validateFindingCatalog(definitions);
if (!validation.ok) throw new TypeError(`finding catalog failed validation: ${JSON.stringify(validation.issues)}`);

export const findingCatalog = deepFreeze(definitions);
const catalogByCode = new Map(findingCatalog.map((entry) => [entry.code, entry]));

export function getFindingDefinition(code) {
  return catalogByCode.get(code) ?? null;
}
