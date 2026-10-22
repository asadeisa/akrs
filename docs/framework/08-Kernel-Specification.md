# AKRS Kernel Specification (v2)

### What the Kernel is, and the templates the framework emits

The Kernel removes the single biggest cost of the original design: a ~6,000-word, read-once
doctrine that every target project carried but the Worker never read. The compiled artifact is a
**folder**, so each role reads *less*, not more — the philosophy is unchanged.

> **Framework vs. Kernel.** The framework (this folder) is the **source code**: permanent,
> versioned, teaches a Leader how to analyze projects. The Kernel is the **compiled artifact**:
> disposable, per-project, teaches an agent how to execute *one* project. Only the framework
> belongs in version control. The Kernel lives only inside the generated project and is
> regenerated for every project using the latest framework and the strongest available model.

> **Scope note.** Building the framework produces this **specification and templates only**. A
> real kernel folder is generated later, when AKRS is applied to a concrete project.

> **The Kernel stays compact.** New agent behavior ships as **skills** and form specifications
> (`skills/`), reached through one pointer line — never as more always-loaded Kernel prose. The
> CLI's own packets (`boot`, `work`, `test-details`) carry the project-specific facts.

---

## 1. What the Kernel is — a folder

The compiled artifact is **`akrs/kernel/`**:

- **`CORE.md`** — the shared minimum every role needs, and nothing any single role owns alone:
  the one route, runtime priority, the Modes table, the blind-assumption check, the close-out
  one-liner, and the pointers.
- **one file per role** — `worker.md`, `leader.md`, `tester.md`, `changer.md` — each holding only
  that role's operating rules.

**The Gate** (boot) loads **`CORE.md` + exactly one role file** — never another role's file. A
Worker session never reads Leader or Tester rules, and no role is distracted by another role's
concerns (`06-Runtime-Boot-Protocol.md §2`). `akrs boot` reads `kernel/CORE.md` and
`kernel/leader.md` for the Leader.

**Numeric budget:** `CORE.md` ≤ ~175 words; each role file ≤ ~175 words; **`CORE.md` + any one
role file ≤ ~350 words** (~1 page). Compress to fit; never drop a rule.

---

## 2. Prompt-engineering rules for the Kernel

- **Token-dense.** Tables and imperative bullets. Zero motivational prose, zero repetition.
- **Single owner across the folder.** Each rule appears in **exactly one** file — `CORE.md`
  *or* one role file, never two. Roles do not restate CORE, and no role restates another.
- **Pointers, not procedures.** A role file names the skill that owns a procedure; it never
  copies the procedure.
- **Deterministic ordering.** Stable section order so any model loads it the same way.
- **Machine-actionable, not human-inspirational.** Optimized for an LLM to load and obey.

---

## 3. Required content

**`CORE.md`** (shared): roles + role-at-boot line · the rule that `akrs/` machine files are
written by `akrs` only · runtime priority (`Road → Memory → Router → Repository`; SoT only via
windows / SOT-INDEX) · Modes 0–4 table with prompt→Mode hints (Mode 0 = escape hatch) · the one
route · the blind-assumption check + scope-expansion pointer · the close-out pointer line (→ the
`akrs-close-out` skill) · Pointers (Router / STATE / SOT-INDEX / FEATURES / Source of Truth /
skills).

**`worker.md`**: entry command + packet-only reading · execution guarantees · the skills it uses
(`akrs-work-loop`, `akrs-scope-request`, `akrs-close-out`) · `yield` escalation.

**`leader.md`**: entry command + questions · generation + granularity rules · Router + Memory
shapes · batch + staleness · dep-gating · Plan close-out ownership (Mirror-Check trigger +
`plan finish` + FEATURES line) · the authoring skills · interaction + applicability.

**`tester.md`**: entry command + the loop (→ the `akrs-live-verify` skill) · instruments-are-evidence
+ user-acceptability sentence · append-only results · `blocked` escalation.

**`changer.md`**: Leader-only, Mode 4 · FEATURES → impact → flag conflicts → merge-or-vanish ·
the requirements-delta procedure.

**One baton, per Plan.** There is no handoff file in the Kernel: the Worker's `done` and the
Tester's `test-details` are the two ends of the same CLI-written handoff record keyed to the Plan
(or to the single Road in the no-Plan tier). A role file that names a handoff *file* is malformed
and fails the acceptance test (§5).

Every rule of the original single template survives — redistributed into exactly one of these
files.

---

## 4. Kernel templates

The framework emits these templates, filled with project-specific values at generation time.
`<…>` are substitution points.

### `akrs/kernel/CORE.md`

```markdown
# CORE — <project>
> Gate loads CORE + your ONE role file (never another's). Don't scan the repo.

## Roles · role at boot
Leader plans/owns architecture · Worker executes one Road · Tester verifies the idea on the
running product · Changer (=Leader, Mode 4).
Role: prompt `as leader|worker|tester:` → entry command (boot | work | test-details) → ask.
Files under akrs/ are written by `akrs` only; never hand-edit one. `akrs --help` lists commands.

## Runtime priority
Road → Memory → Router → Repository (repo only if the Road says so). Read the SoT only via the
Road's windows — through SOT-INDEX if present.

## Modes
| M | When | Path |
|---|------|------|
| 0 | dev names sources | Memory + named files — escape hatch |
| 1 | small isolated change | one Road/file; skip chain |
| 2 | continue existing task | full route, no planning |
| 3 | new work | Leader: 1 Task+1 Road (or batch → QUEUED) |
| 4 | cross-cutting / change a feature | Leader only (changer) |

## Route
Prompt → Mode → Router → Memory → Road → Execute.

## Before executing (once)
"Finish with ONLY the packet?" YES → execute. NO → akrs scope request. Never guess.

## Close-out (Road lands)
Execute docs/akrs/framework/skills/akrs-close-out.md (Worker: `akrs done`).

## Pointers
Router <path> · STATE akrs/STATE.md · SOT-INDEX akrs/SOT-INDEX.md · FEATURES akrs/FEATURES.md ·
SoT <path(s)> · skills docs/akrs/framework/skills/
```

### `akrs/kernel/worker.md`

```markdown
# WORKER
- Start: `akrs work`. Read ONLY the packet. Execute ONLY the Road. Atomic changes. Never redesign,
  never leave the writes, never invent knowledge. Skill: akrs-work-loop.
- Need more scope: `akrs scope request` (akrs-scope-request). Road too big: `akrs yield`.
- Finish: `akrs done <road> --result … --reach … --expect …` (akrs-close-out). Commit asserts to tests/.
- Never run Leader commands: state render, road finish, scope approve, plan finish.
```

### `akrs/kernel/leader.md`

```markdown
# LEADER
- Start: `akrs boot`. Answer questions_for_user first; executors are classified by the USER
  (akrs-classify-executors). Author via drafts + akrs writers, never by hand (akrs-road-author).
- Generate navigation, not docs; prefer references.
- Granularity is my call: fits one reliable session of the executor's class → ONE Task + ONE Road
  (even a whole small plan). Split only when too large (`akrs road fit`). Never for symmetry.
- Router shape: routes+refs / no explanations. Memory shape (`akrs memory add`): index+refs+
  ownership, each fact labeled Decided/Assumption(H/M/L)/Unknown / no implementation.
- Batch: Mode 3 may write a plan's Roads at once (extras stay QUEUED). Activate a QUEUED Road
  only after re-checking Memory/SoT; deps must be DONE.
- Plan close-out — only when: Mirror Check passes (every SoT bullet reachable at runtime, not just
  exported); the Tester's result is a current pass; no unowned seam; no open question owned by this
  Plan. Then `akrs plan finish`, then one FEATURES line.
- Interaction: 2–4 options recommended-first, one decision/turn, confirm SoT first, guided next
  step. ASK owner decisions the same turn; State stores only the answer.
- Applicability: Lite = kernel+Router+Roads; Full = +Plans/Phases/Memory; tiny = skip.
```

### `akrs/kernel/tester.md`

```markdown
# TESTER
- Start: `akrs test-details <plan>` → `akrs test run <plan>` → `akrs test result <plan> --verdict …
  --because …` (akrs-live-verify). Verify the idea against the RUNNING product, not the paperwork.
  Never edit product code.
- Cadence: asserts per Road; Mirror Check per Plan; a live pass only for live/measured Plans + one
  final end-to-end pass — not per Road.
- Instruments are evidence, never verdicts (never the product's own HUD). End every pass with
  "as a user, is this acceptable? — yes/no because ___".
- Results are append-only; delete nothing. Bug → verdict fail with findings; cannot test →
  verdict blocked, say what is needed.
```

### `akrs/kernel/changer.md`

```markdown
# CHANGER  (= Leader, Mode 4)
- On a mid-project feature add/change/remove, create akrs/changes/<id>.md on demand:
  intent · SoT diff · impact list (from FEATURES + SOT-INDEX: affected Plans/Memories/QUEUED
  Roads) · conflicts flagged to the developer WITH options BEFORE editing anything.
- Merge-or-vanish: landed → update the SoT + FEATURES, then delete the change file.
  Rejected → delete it and record the rejection as a Decided Memory record (`akrs memory add`).
- Requirements-delta: diff the SoT (via SOT-INDEX) → list affected Plans/Memories/QUEUED Roads
  → re-validate or regenerate each (`road update` a stale QUEUED Road; a Road that already landed
  stays DONE as history and the changed behavior gets a new Road; never edit the ledger) → record
  the delta with `akrs state set --next` and `akrs memory add`.
```

---

## 5. Acceptance test

The kernel is correct only if: **a session given only `AGENTS.md → kernel/CORE.md + its role file
→ its entry command's packet` executes correctly** without reading any doctrine, without
scanning the repo, and without loading another role's file.

This is the guardrail against over-trimming and against leakage: if a session would need a rule
its CORE + role file omitted, the kernel failed and must be regenerated, not patched ad hoc; if a
role file carries a rule another role owns, single-owner across the folder is broken. It is also
the guardrail against cross-role drift: if two role files disagree about a command or name a
file the CLI owns, the kernel is malformed and must be regenerated.

---

## 6. Lifecycle

- **Generated** at the end of workflow generation (`02-Generation-Specification.md §7`), once,
  with a strong model — the whole `akrs/kernel/` folder.
- **Booted** by every session via `AGENTS.md` → the Gate loads `CORE.md` + one role file
  (`06-Runtime-Boot-Protocol.md`).
- **Never versioned, never stored in the framework repo, never reused across projects.** It is
  always regenerated from the latest framework, the target's architecture, and the current
  model's capabilities — so future models always produce a better kernel than past ones.
