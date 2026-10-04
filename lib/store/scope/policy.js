// P1-W07 frozen decisions for Road updates, scope requests/resolutions and `road move`. Everything here is
// documentation that the tests pin down; the rest of lib/store/scope and lib/store/roads implements it. Decisions
// beyond the packet text are marked (decision).
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const SCOPE_DIRECTORY = 'scope';
export const ENVELOPE_GRANT_CAP = 3;

// One new permanent code (R family): a Road change, scope request/resolution or move was refused by its guard.
export const CHANGE_FINDING_CODE = 'AKRS-R014';

export const CHANGE_REASONS = Object.freeze([
  'id_changed', 'ledger_unusable', 'no_change', 'no_pending', 'nothing_to_add', 'patch_target_exists', 'patch_target_missing',
  'plan_changed', 'plan_names_a_road', 'removal_reason_missing', 'request_ambiguous', 'request_missing', 'request_resolved',
  'road_active', 'road_done', 'road_missing', 'road_unverified', 'status_changed', 'target_exists', 'write_collision',
]);

export const ENVELOPE_REASONS = Object.freeze([
  'forbidden', 'grant_cap', 'no_envelope', 'outside_envelope', 'refused_by_guard', 'weak_class_writes',
]);

export const UPDATE_STORE_POLICY = deepFreeze({
  input: 'A full replacement takes the complete update-form Road (the stored form without `meta`, `status` included) through `--input` or `--json -`; `--patch` takes the closed document {schema: akrs.road-patch/v1, ops: [...]} with the operations add_read, remove_read, add_write, remove_write, add_check, remove_check, replace_acceptance, replace_boundaries, replace_steps. A patch is expanded under the lock to the full object, then takes the identical validation, diff and transaction path.',
  guard: 'A full replacement needs `--if-snapshot` (explicit; the lease-implied form arrives with P1-W15); a patch re-validates the complete proposed state under the lock instead (A1 3.2). A stale snapshot, a held lock or a pending recovery write nothing.',
  immutable: 'id, status and plan never change through an update: the ID is the identity, status belongs to the lifecycle commands, and relocation to another Plan is `road move`. `meta` is CLI-owned and never accepted.',
  removals: '(decision) Removing a read (path + lines), a write (path) or a check (name) needs a reason. A patch carries `reason` on each remove_* operation; a full replacement states one `--reason <text>` that covers every removal of the update (the closed Road schema has no room for per-entry metadata). The reason is part of the journal request, not of the stored Road.',
  validation: 'closed update schema (usage error before the lock for a full replacement); then, under the lock and in dry runs: immutables, removal reasons, unknown dependencies, dependency cycles through the replaced node, path safety and case, read windows, and write collisions with other ACTIVE Roads that this update INTRODUCES (a pre-existing overlap is not blamed on it). Every finding is reported at once; any error means nothing is written.',
  no_change: 'An update whose canonical bytes equal the stored Road is refused as no_change (nothing would change).',
  dry_run: 'Returns the exact proposed stored Road, the field-level diff, the affected relations (dependencies, dependents, Task, pending scope requests), the context budget (read, write, check and step counts and the declared read lines) and the findings, and writes no byte.',
  snapshots: 'A successful update changes the road snapshot projection, so every Worker or Tester packet issued from the previous snapshot is stale by the normal snapshot rule; no second protocol exists.',
  placement: 'The Road file is replaced in place; it never moves.',
});

export const SCOPE_STORE_POLICY = deepFreeze({
  location: '<workflow>/scope/<road>.jsonl: one append-only JSONL file per Road (frozen by F14). Request and resolution records are told apart by their literal `type`; the CLI fills id (ULID), hash, ts, type, snapshot and granted_by.',
  request: 'A request grants nothing and never touches the Road. The stored record carries the snapshot the Road had when the request was made. `blocking: true` returns status `blocked` (the Worker stops); `blocking: false` returns `ok` (the Worker continues); both leave the request pending.',
  pending: 'A request is pending until a resolution names it. The state of a request is derived from the ledger: pending, approved or rejected.',
  rejection: '`scope reject <target> --reason` appends a rejected resolution (reason mandatory, road_snapshot_after null, granted_by leader) and changes no Road byte.',
  approval: '`scope approve <target>` applies the request delta to the CURRENT Road under the lock (appended reads, merged writes), runs the identical update validation, and in ONE transaction replaces the Road and appends the approved resolution. The result is byte-identical to a manual full `road update` with the same object. `target` is a Road ID with exactly one pending request, otherwise a request ID.',
  road_snapshot_after: '(decision) The resolution records the content hash of the Road file the approval produced (sha256 over its canonical bytes). A snapshot of the whole Road projection cannot be embedded: the resolution is itself an input of that projection, so its hash would depend on itself. The Road bytes are exactly what the Road projection of the new snapshot is derived from.',
  envelope: `A request is granted immediately (resolution granted_by "envelope", in the same transaction as the request) only when ALL hold: the Road has a scope_policy; every requested write is a concrete file-class path inside auto_writes and every read is a literal path inside auto_reads; nothing is under forbidden (an unprovable overlap counts); the Road is not weak class when writes are requested (weak class auto-grants reads only); fewer than ${ENVELOPE_GRANT_CAP} envelope grants exist for the Road; and the replacement passes the full update validation, so it creates no collision with another ACTIVE Road. Otherwise the request stays pending, exactly as for a Worker without an envelope.`,
  deferred_caps: '(decision) Class caps and the read budget of a class profile belong to P1-W15; this packet only applies the weak-class rule. The gate for the other class limits is recorded as deferred.',
  envelope_validation: 'The Road schema already rejects envelopes that are not provably disjoint from the workflow root and SOT/** (including a bare **); this packet adds tests, not a second rule.',
  ledger: 'Before any write the scope file must read back through the codec (UTF-8, strict JSON lines, closed schemas, unique ids, final newline); otherwise the command is refused as ledger_unusable and writes nothing.',
  roles: '(decision) request is `any` (the Worker files it), approve and reject are `leader`; as in the other Phase 1 writers no adapter enforces roles in this packet.',
});

export const MOVE_STORE_POLICY = deepFreeze({
  meaning: '(decision) `road move <id> --plan <plan|none>` relocates the Road file between Plan folders (roads/<plan>/<id>.json, roads/<id>.json for none) and sets the Road `plan`; the ID never changes.',
  report_only: 'Without `--apply` the command is report-only: it returns the plan (from, to, plan change, declared references, proposed tree files) and changes no byte. `--apply` runs the same plan as one recoverable transaction (a move operation plus replacements).',
  references: '(decision) Declared references are updated and nothing else: the plan field and Task pointer of the Road itself, the identity marker and the `Road:` pointer line of the Road\'s Task, and exact segment-wise matches of the old Road path in other Roads\' reads[].path and on_landing. Prose is never searched or rewritten.',
  refused: 'An ACTIVE Road is not moved (a Worker may hold it); an existing target file, a missing Road, an unverified Road, a plan that is the ID of a Road, and a move to the current location are refused and write nothing.',
});
