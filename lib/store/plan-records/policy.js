// Plan record writers (P2-W11, dogfood follow-up, owner decision 2026-11-14): small flag-based commands, one call per intent, that write
// the Leader-owned parts of akrs/plans/<plan>.json (title, questions, seams). Tester finding pointers and the closure stay owned by
// `test result` and `plan finish`. Every write is a journaled transaction under the repository lock, like every workflow mutation.
export const PLAN_FINDING_CODE = 'AKRS-S011';
export const PLAN_WRITE_COMMANDS = Object.freeze([
  'plan-new', 'plan-question-add', 'plan-question-resolve', 'plan-seam-add', 'plan-seam-remove',
]);
export const PLAN_GUARD_REASONS = Object.freeze([
  'id_taken', 'no_change', 'plan_closed', 'plan_exists', 'plan_missing', 'plan_unusable', 'question_exists', 'question_missing',
  'question_resolved', 'road_missing', 'seam_exists', 'seam_missing',
]);
export const PLAN_STORE_POLICY = Object.freeze({
  ownership: 'plan new/question/seam write only title, questions and seams; findings pointers (test result) and closure (plan finish) are never written here.',
  identity: 'Plan and Road IDs share one namespace: plan new refuses an ID a Road already uses (id_taken) or an existing Plan file (plan_exists).',
  generated_ids: 'Without --question/--seam the CLI picks the next free Q<n>/S<n> (one more than the highest number in use), so an agent never invents an ID.',
  closed: 'A closed Plan (closure.status closed) takes no further write: plan_closed.',
  unusable: 'A Plan file that does not verify (hand-edited, invalid) is never rewritten: plan_unusable; restore it from version control.',
  seam_owner: 'A seam owner is --road <id> (a Road that must exist) or --intent <text>, never both; without either the seam is unowned and plan finish blocks on it.',
});
