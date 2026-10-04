// P1-W15 frozen decisions (F15) for executor classes, the class profiles, `road fit` and the class-limit findings.
// Documentation the tests pin down; the rest of lib/store/executors implements it. Decisions beyond the packet and A1 2
// text are marked (decision).
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const EXECUTORS_FILE = 'executors.json';
export const EXECUTOR_FINDING_CODES = Object.freeze({ guard: 'AKRS-S005', unclassified: 'AKRS-S006' });
export const CLASS_FINDING_CODES = Object.freeze({ fit: 'AKRS-R015', oversize: 'AKRS-R016' });
export const EXECUTOR_GUARD_REASONS = Object.freeze(['executor_missing', 'file_unusable', 'no_change']);
export const FIT_VERDICTS = Object.freeze(['fits', 'split_required', 'reads_over_budget']);
export const FIT_KNOBS = Object.freeze([
  'check_required', 'max_write_dirs', 'max_writes', 'read_budget_tokens', 'steps_required', 'write_classes',
]);
export const CLASS_ORDER = Object.freeze(['weak', 'medium', 'frontier']);

// A1 2.2 shipped defaults. Numbers are tunable through class_overrides; the table shape and the non-numeric rules are not.
export const CLASS_PROFILES = deepFreeze({
  weak: {
    max_writes: 3, max_write_dirs: 1, read_budget_tokens: 6000, done_failures_before_yield: 2, envelope_grant_cap: 3,
    write_classes: ['file'], steps_required: true, check_required: true,
  },
  medium: {
    max_writes: 8, max_write_dirs: 3, read_budget_tokens: 16000, done_failures_before_yield: 3, envelope_grant_cap: 3,
    write_classes: ['file', 'dir', 'glob'], steps_required: false, check_required: true,
  },
  frontier: {
    max_writes: 20, max_write_dirs: 6, read_budget_tokens: 60000, done_failures_before_yield: 4, envelope_grant_cap: 3,
    write_classes: ['file', 'dir', 'glob'], steps_required: false, check_required: false,
  },
});

export const EXECUTOR_STORE_POLICY = deepFreeze({
  location: '<workflow>/executors.json: the closed akrs.executors/v1 document {schema, executors[], class_overrides, meta}, written only by `executor set|remove` through the transaction coordinator.',
  classification: 'The class is the USER\'s answer, stored as given: id, role, class, label and the verbatim user_answer. Nothing is inferred from the label or a model name; a missing field is a usage error and writes nothing.',
  set: '(decision) `executor set <id> --role --class --label --answer` upserts one executor by id (all four fields are required together). `--override <class>.<knob>=<n>` (repeatable) and `--clear-override <class>.<knob>` change class_overrides, with or without an executor (then the id is omitted). Overrides change numbers only: an unknown class or knob, or a value below 1 (0 for envelope_grant_cap), is a schema error.',
  remove: '`executor remove <id>` removes one executor; an unknown id is refused as executor_missing. Writing an identical document is refused as no_change.',
  profiles: 'The effective profile of a class is the shipped default merged with class_overrides[class] (numbers only). The non-numeric rules (allowed write classes, steps required, check required) come from the class and cannot be overridden.',
  load: 'Load of a Road = writes count, distinct write path classes, distinct parent directories of writes (file: its directory; dir: itself; glob: the literal directory prefix), the estimated read tokens of the declared read windows and the longest dependency chain. `complexity` is reported and never part of a verdict.',
  estimator: '(decision) estimateTokens counts code points in quarter-token units: ASCII 1 (so 4 characters = 1 token), CJK ideographs, kana and hangul 4 (1 token each), every other non-ASCII character (Arabic, Hebrew, Cyrillic, accents, emoji) 2; the total is rounded up. Integer arithmetic only, so the result is identical on every platform; it errs on the high side for scripts that tokenize badly.',
  verdict: 'fits = no violation; reads_over_budget = only the read budget is exceeded; split_required = any other violation (writes, write dirs, write classes, missing steps or check), also when the read budget is exceeded too.',
  suggestions: 'Split suggestions are deterministic and only suggestions: writes sorted by directory then path and cut into groups of at most max_writes writes and max_write_dirs directories; reads kept in order and cut by the read budget; group i takes write group i and read group i. `--write-drafts` saves each group as a Road INPUT draft `<id>-split-<n>` (task cleared, everything else copied) in drafts/: the declared scratch write, outside the transaction namespace, exactly like `template --to-draft`.',
  road_writers: 'road new and road update call the same evaluator (classFitCheck) on the proposed Road. A violation never blocks the write: the Road is written and each violated knob is reported as an AKRS-R015 finding, severity error (failed) without an oversize_reason and warning (reported) with one; readiness blocking is P2-W05. An oversize_reason is refused (AKRS-R016, nothing written) when the Leader executor class is weak or medium; with no Leader declared it is accepted (unclassified).',
  leader_class: '(decision) The Leader class is the weakest class among the declared leader executors; null when there is none.',
  unclassified: '`unclassified` is true unless executors.json is usable and declares at least one leader and one worker. `validate` must report it as AKRS-S006 and Leader `boot` must ask the user: the flag and the finding builder are exposed here; wiring into validate belongs to P1-W13 (validate is rebuilt there) and boot to P2-W12.',
  snapshots: 'executors.json is the `executors` projection input of road-fit, road-new and scope-request, so changing it stales every packet that depends on it.',
  roles: '(decision) executor set|remove are `leader`; list and road fit are `any`; no adapter enforces roles in this packet.',
});
