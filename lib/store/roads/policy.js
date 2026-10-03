// P1-W06 frozen decisions for the Road and Task writers. Everything here is documentation that the tests pin
// down; the rest of lib/store/roads implements it. Decisions beyond the packet text are marked (decision).
import packageJson from '../../../package.json' with { type: 'json' };

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// meta.generator of every CLI-written Road (Q1): `akrs/<package version>`.
export const GENERATOR = `akrs/${packageJson.version}`;

export const ROAD_DIRECTORY = 'roads';
export const TASK_DIRECTORY = 'tasks';
export const DRAFT_DIRECTORY = 'drafts';
export const PLAN_DIRECTORY = 'plans';
export const TASK_MARKER_PREFIX = '<!-- akrs:task ';
export const TASK_MARKER_SUFFIX = ' -->';

// New permanent codes (R family: Road contracts). The detail shapes live in lib/findings/catalog.js.
export const AUTHORING_FINDING_CODES = Object.freeze({
  unresolved_path: 'AKRS-R012',
  binding: 'AKRS-R013',
  draft: 'AKRS-C016',
});

export const READ_WINDOW_STATUSES = Object.freeze([
  'case_mismatch', 'missing', 'not_file', 'not_text', 'ok', 'out_of_range', 'own_write', 'unsafe',
]);

export const ROAD_STORE_POLICY = deepFreeze({
  location: '<workflow>/roads/**/<id>.json; the file base name is the explicit Road ID and nested folders are allowed.',
  placement: '(decision) `road new` writes roads/<plan>/<id>.json when `plan` is set and roads/<id>.json in the no-Plan tier. Readers find a Road in any nested folder; a Road is identified by its base name, never by its folder.',
  identity: 'IDs are explicit and globally unique across Roads and Plans (Q8, Q13): the base name of every roads/**/*.json and plans/*.json is one identity, compared case-folded (NFC, non-1:1 folds collide). A duplicate is AKRS-R001 and writes nothing.',
  plan_reference: '(decision) The Plan file need not exist yet (no Phase 1 command creates one before `road new`); a `plan` that names an existing Road ID is AKRS-R013 plan_names_a_road.',
  reads: 'readRoad returns { road, meta_state, path, issues }: `declared` only when the stored form validates and the content hash matches, otherwise `unverified` (never accepted silently).',
  stored_form: 'The CLI fills `status: QUEUED` and `meta {generator, content_hash}`; every other key is exactly what the agent submitted. Set arrays are written code-point sorted (Q6); ordered arrays keep their order. Nothing is invented.',
  validation_order: 'closed schema (input form) before the lock; then, under the lock and in dry runs: identity collisions, plan reference, unknown dependencies, dependency cycles through the new Road, path safety and case, read windows. Every finding is reported at once; any error means nothing is written.',
  exit_codes: 'Schema and input-channel failures, a reused request ID and an invalid request ID are usage errors (packet data.kind `usage`, exit 2: the adapter maps such a packet to 2 when the manifest entry declares exit code 2). Cross-Road and filesystem findings, a stale snapshot and a held lock are findings or blocked results (exit 1). A successful write that carries a warning also exits 1, like every packet with findings.',
  read_windows: 'A window (`lines` set) needs an existing UTF-8 text file whose line count covers it (same line splitting as the snapshot engine). A whole-file read may name a file that does not exist yet. A read inside the Road\'s own writes is not required to exist. Path safety and case apply to every path.',
  task_ids: '(decision) Task IDs are unique per tasks/ folder (case-folded) and are not part of the Road/Plan namespace; the Road schema already forbids a Road whose task equals its own ID.',
  task_binding: '(decision) A Task scaffold needs an existing Road whose `task` equals the Task `id` and whose `plan` equals the Task `plan`; the file tasks/<id>.md must not exist. Nothing else about the Road is copied.',
  roles: '(decision) The manifest declares `required_role: leader` for road-new and task-new, but no adapter enforces roles in this packet: there is no executor identity yet (P1-W15) and no authentication mechanism is invented. The role is metadata for help, MCP projection and a later gate.',
});

export const TASK_STORE_POLICY = deepFreeze({
  location: '<workflow>/tasks/<task-id>.md (Q31).',
  marker: 'The first line is `<!-- akrs:task {"schema":"akrs.task/v1","id":..,"plan":..,"road":..,"generator":..} -->`: identity only, canonical compact JSON.',
  headings: ['Objective', 'Constraints', 'Approach', 'Notes'],
  pointer: 'The scaffold names the Road file and points at its `steps`, `acceptance`, `reads`, `writes` and `checks` as the executable owners; it never restates them.',
  prose: 'Task prose is never parsed for executable fields. readTask reads the identity marker only and reports declared/unverified for the marker.',
  newlines: 'Canonical Markdown is written with LF only; CR and CRLF inside submitted prose become LF.',
});

export const DRAFT_POLICY = deepFreeze({
  location: '<workflow>/drafts/<name>.json, name = an ID (Q8 grammar, Q26).',
  input: '`--input <path>` is a repository-relative normalized path (absolute paths are accepted only when they are inside the repository); `--json -` reads stdin. Both channels normalize to identical text (BOM, CRLF, 1 MiB, duplicate keys).',
  success: 'The draft is deleted in the same transaction that creates the Road or Task; changed lists both paths (workflow-relative, like every transaction packet).',
  failure: 'A rejected or failed request leaves the draft untouched and the findings carry RFC 6901 pointers.',
  retry: 'A retry whose draft is already gone is resolved through the journal (committed draft path) before any usage error; the result is a noop replay of the original packet.',
  changed_while_processing: 'The draft is re-read under the lock and must equal the bytes that were validated, otherwise nothing is written.',
});

export const TEMPLATE_DRAFT_POLICY = deepFreeze({
  manifest: '(decision) One manifest entry, `template`, mutability `query`: it matches the frozen A1 command table ("query; --to-draft writes"), the snapshot table row `template: []` and TRANSACTION_NON_MUTATIONS. No separate command ID is added.',
  query: 'Without --to-draft the packet is a pure query: changed [] and equal snapshots (validateReadOnlyPacket).',
  to_draft: '`--to-draft <name>` writes only <workflow>/drafts/<name>.json (exclusive create, never an overwrite) outside the transaction namespace, which only ever deletes drafts. The packet lists the draft in changed and carries request_id null: scratch is never journaled or deduplicated. Drafts are excluded from snapshots, so before equals after.',
});
