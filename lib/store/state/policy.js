// P1-W11 frozen decisions for the canonical State (`akrs/state.json`) and its disposable human render
// (`akrs/STATE.md`). Documentation the tests pin down; the rest of lib/store/state implements it. Decisions beyond the
// packet text are marked (decision).
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const STATE_FILE = 'state.json';
export const STATE_RENDER_FILE = 'STATE.md';
export const STATE_FINDING_CODE = 'AKRS-S004';
export const STATE_REASONS = Object.freeze(['no_change', 'render_unusable', 'state_missing', 'state_unusable']);
// Authored fields a Leader can null out (`--clear`); mode and role always hold a value.
export const STATE_CLEARABLE = Object.freeze(['plan', 'phase', 'task', 'next']);
export const STATE_DONE_LIMIT = 3;

export const STATE_STORE_POLICY = deepFreeze({
  authored: 'state.json holds only the Leader-owned fields of akrs.state/v1 (mode, role, plan, phase, task, next) plus the CLI-owned updated {at, by} and meta. Nothing derived is stored, so nothing can disagree with the Roads, scope requests, logs or verification sources.',
  derived: 'Everything else in STATE.md is recomputed from canonical artifacts at render time: ACTIVE Roads, ready QUEUED Roads (every dependency DONE), the last 3 DONE closures, blockers (BLOCKED closures never followed by a DONE, pending blocking scope requests), the Plan verification summaries and pending scope requests. Only Roads that verify (declared meta) contribute; the number of Roads, closure records and sources that do not verify is stated in the render instead of guessed.',
  render: 'STATE.md is a pure function of those inputs: stable ordering (code point order of ids; ledger order for closures), LF only, exactly one trailing LF, no timestamps beyond state.json updated.at. The previous STATE.md is never read.',
  free_text: '(decision) phase and next are free text. They are stored verbatim (Unicode, tabs, blank lines, any line break); STATE.md shows them as a blockquote, one `> ` line per line of text (a blank line is `>`), with CRLF and lone CR normalised to LF in the render only.',
  set: '(decision) `state set` takes flat flags --mode --role --plan --phase --task --next and --clear <field> (repeatable: plan, phase, task, next). Only the named fields change. The first set creates state.json with mode 0, role leader and null plan/phase/task/next. It writes state.json and STATE.md in one transaction; `--by` names the writer (default: the generator).',
  refs: '(decision) plan and task are IDs only: state set does not check that they exist (state points, it never teaches); cross-artifact checks belong to `validate` (P1-W13).',
  render_command: '`state render` rewrites STATE.md only, from a declared state.json. A STATE.md that already equals the render is refused as no_change (nothing to write); a hand-edited or stale one is replaced.',
  unusable: 'A state.json that is missing, not canonical text, breaks the stored schema or fails its content hash cannot be the source of truth: state render refuses (state_missing / state_unusable) and state set refuses to overwrite an unverified file (state_unusable). Restore it from version control. Nothing is written.',
  snapshots: 'state-set is guarded by the `state` projection, state-render by every source it derives from; both revalidate the complete proposed state under the lock.',
  roles: '(decision) state set is `leader`; no adapter enforces roles in this packet (as in the other Phase 1 writers).',
});
