# AKRS Kernel Specification (v1.2, revised v1.3)

### What the Kernel is, and the templates the framework emits

This is a **v1 capability, grown in v1.2**. It removes the single biggest cost of v0: a
~6,000-word, read-once doctrine that every target project carried but the Worker never read.
v1.2 grows the compiled artifact from a single file into a **folder** so each role reads
*less*, not more (D10) — the philosophy is unchanged, the concept is bigger.

> **Framework vs. Kernel.** The framework (this folder) is the **source code**: permanent,
> versioned, teaches a Leader how to analyze projects. The Kernel is the **compiled
> artifact**: disposable, per-project, teaches an agent how to execute *one* project.
> Only the framework belongs in version control. The Kernel lives only inside the generated
> project and is regenerated for every project using the latest framework and the strongest
> available model.

> **Scope note.** Building the framework produces this **specification and templates only**.
> It does **not** generate an actual project kernel. A real kernel folder is generated later,
> when AKRS is applied to a concrete project.

---

## 1. What the Kernel is — a folder (D10)

The compiled artifact is **`akrs/kernel/`**:

- **`CORE.md`** — the shared minimum every role needs, and nothing any single role owns
  alone: the one route, runtime priority, the Modes table, the blind-assumption check, the
  close-out one-liner, and the pointers.
- **one file per role** — `worker.md`, `leader.md`, `tester.md`, `changer.md` — each holding
  only that role's operating rules.

**The Gate** (boot) loads **`CORE.md` + exactly one role file** — never another role's file.
So a Worker session never reads Leader or Tester rules; each session reads *less* than the v1
single Kernel, and no role is distracted by another role's concerns
(`06-Runtime-Boot-Protocol.md §2`).

**Numeric budget (so the CLI can check it):** `CORE.md` ≤ ~175 words; each role file ≤ ~175
words; **`CORE.md` + any one role file ≤ ~350 words** (~1 page — the same convention as
STATE's word budget). Compress to fit; never drop a rule.

---

## 2. Prompt-engineering rules for the Kernel

- **Token-dense.** Tables and imperative bullets. Zero motivational prose, zero repetition.
- **Single owner across the folder.** Each rule appears in **exactly one** file — `CORE.md`
  *or* one role file, never two. Roles do not restate CORE, and no role restates another.
- **Deterministic ordering.** Stable section order so any model loads it the same way.
- **Machine-actionable, not human-inspirational.** Optimized for an LLM to load and obey.

---

## 3. Required content

**`CORE.md`** (shared): Roles + role-at-boot line · Runtime priority (`Road → Memory → Router
→ Repository`; SoT only via windows / SOT-INDEX) · Modes 0–4 table with prompt→Mode hints
(Mode 0 = escape hatch) · the one route · the blind-assumption check + scope-expansion loop ·
the close-out pointer line (→ the `akrs-close-out` skill) · Pointers (Router / STATE / LOG /
SOT-INDEX / FEATURES / Source of Truth).

**`worker.md`**: execution guarantees · Road + Task file shapes (Task carries `Verify:` and
`Skills:`) · handoff-file duty (≤1 page) · the close-out skill pointer · BLOCKED escalation.

**`leader.md`**: generation + granularity rules · Router + Memory file shapes · batch +
staleness · dep-gating · Plan close-out ownership (Mirror-Check trigger + FEATURES append) ·
interaction + applicability.

**`tester.md`**: consume the handoff · Mirror Check · the live-verify cadence + the
`akrs-live-verify` skill pointer · instruments-are-evidence + user-acceptability sentence ·
findings + delete-on-pass · tester-memory rules · BLOCKED escalation.

**`changer.md`**: Leader-only, Mode 4 · FEATURES → impact → flag conflicts → merge-or-vanish
· the requirements-delta procedure.

Every rule of the pre-v1.2 single template survives — redistributed into exactly one of these
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
Leader plans/owns architecture · Worker executes the active Road · Tester verifies the idea on
the running product · Changer (=Leader, Mode 4).
Role: prompt `as leader|worker|tester:` → STATE Role: → ask. Load only kernel/<role>.md.

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
"Finish with ONLY the active Road?" YES → execute. NO → Router → Memory → back to Road. Never guess.

## Close-out (Road lands)
Execute `akrs/skills/akrs-close-out.md` (flip Road · ledger line · STATE ≤1 page · Memory · commit · validate).

## Pointers
Router <path> · STATE akrs/STATE.md · LOG akrs/LOG.md · SOT-INDEX akrs/SOT-INDEX.md ·
FEATURES akrs/FEATURES.md · SoT <path(s)>
```

### `akrs/kernel/worker.md`

```markdown
# WORKER
- Execute ONLY the active Road. Atomic changes. Never redesign, never leave scope, never
  invent knowledge. Validate before expanding.
- Road shape: read-order + expected-files + scope + Status + Deps / no docs.
- Task shape: objective + constraints + acceptance + Verify(none|idea|measured) +
  Skills(names, optional) + road-pointer / restates nothing from its Road.
- Skills: use the skill / MCP-tool names the Task lists (zero, one, or many).
- Handoff: keep akrs/verify/<plan>-handoff.md current (what became observable, how to reach
  it, expected); ≤1 page; flag "ready" when runnable.
- Close-out: when my Road lands, execute akrs/skills/akrs-close-out.md. I do not run the
  Plan-level pass — that is the Leader's/Tester's.
- Stuck: after the scope-expansion loop fails, write akrs/BLOCKED.md (which Road, what
  blocked, what I tried, what I need) and tell the developer. Do not guess forward.
```

### `akrs/kernel/leader.md`

```markdown
# LEADER
- Generate navigation, not docs; prefer references.
- Granularity is my call: fits one reliable session → ONE Task + ONE Road (even a whole small
  plan). Split only when too large. Never for symmetry.
- Router shape: routes+refs / no explanations. Memory shape: index+refs+ownership, each fact
  labeled Decided/Assumption(H/M/L)/Unknown / no implementation.
- Batch: Mode 3 may generate a plan's Roads at once (extra QUEUED). Activate a QUEUED Road
  only after re-checking Memory/STATE.
- Gating: a Road whose Deps aren't all DONE can't go ACTIVE without a recorded override.
- Plan close-out — the Plan closes only when: Mirror Check passes (every SoT bullet reachable
  at runtime, not just exported); the Tester's verification passed; no unowned seam; no open
  question owned by this Plan. Then append one FEATURES line.
- Validate: one owner/concept; one Road per Task; every Road a legal Status; no Unknown
  silently hardened.
- Interaction: 2–4 options recommended-first, one decision/turn, confirm SoT first, guided
  next step. ASK owner decisions the same turn; STATE stores only the answer, never a parked
  question.
- Applicability: Lite = kernel+Router+Roads; Full = +Plans/Phases/Memory; tiny = skip.
```

### `akrs/kernel/tester.md`

```markdown
# TESTER
- Consume akrs/verify/<plan>-handoff.md. Verify the idea against the RUNNING product, not the
  paperwork. Never edit product code.
- Cadence: asserts per Road; Mirror Check per Plan; a real-browser pass ONLY for Plans that
  touched DOM/CSS + one final end-to-end pass — not per Road. Run it: execute
  akrs/skills/akrs-live-verify.md (the rig + handoff template live there).
- Instruments are evidence, never verdicts (never the product's own HUD). End every pass with
  "as a user, is this acceptable? — yes/no because ___".
- Pass → delete the handoff. Bug → write findings (handoff stays), escalate, re-test after the
  fix lands.
- Tester memory (akrs/memory/tester/): create a topic file ONLY on a repeated error / red-flag
  pattern; inform the developer; delete it once the problem is fixed.
- Stuck (handoff insufficient / product won't run): write akrs/BLOCKED.md and tell the
  developer.
```

### `akrs/kernel/changer.md`

```markdown
# CHANGER  (= Leader, Mode 4)
- On a mid-project feature add/change/remove, create akrs/changes/<id>.md on demand:
  intent · SoT diff · impact list (from FEATURES + SOT-INDEX: affected Plans/Memories/QUEUED
  Roads) · conflicts flagged to the developer WITH options BEFORE editing anything.
- Merge-or-vanish: landed → update the SoT + FEATURES, then delete the change file.
  Rejected → delete it with one LOG line. No orphan artifacts.
- Requirements-delta: diff the SoT (via SOT-INDEX) → list affected Plans/Memories/QUEUED Roads
  → re-validate or regenerate each (retire superseded Roads; refresh stale QUEUED) → record
  the delta in STATE + LOG.
```

---

## 5. Acceptance test

The kernel is correct only if: **a session given only `AGENTS.md → kernel/CORE.md + its role
file → the active artifact` executes correctly** without reading any doctrine, without
scanning the repo, and without loading another role's file.

This is the guardrail against over-trimming and against leakage: if a session would need a
rule its CORE + role file omitted, the kernel failed and must be regenerated, not patched ad
hoc; if a role file carries a rule another role owns, single-owner across the folder is
broken.

---

## 6. Lifecycle

- **Generated** at the end of workflow generation (`02-Generation-Specification.md §7`), once,
  with a strong model — the whole `akrs/kernel/` folder.
- **Booted** by every session via `AGENTS.md` → the Gate loads `CORE.md` + one role file
  (`06-Runtime-Boot-Protocol.md`).
- **Never versioned, never stored in the framework repo, never reused across projects.** It is
  always regenerated from the latest framework, the target's architecture, and the current
  model's capabilities — so future models always produce a better kernel than past ones.
