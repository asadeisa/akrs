# AKRS Kernel Specification (v1)

### What the Kernel is, and the template the framework emits

This is a **new v1 capability** and the central improvement of the version. It removes the
single biggest cost of v0: a ~6,000-word, read-once doctrine that every target project
carried but the Worker never read.

> **Framework vs. Kernel.** The framework (this folder) is the **source code**: permanent,
> versioned, teaches a Leader how to analyze projects. The Kernel is the **compiled
> artifact**: disposable, per-project, teaches a Worker how to execute *one* project.
> Only the framework belongs in version control. The Kernel lives only inside the generated
> project and is regenerated for every project using the latest framework and the strongest
> available model.

> **Scope note.** Building the v1 framework produces this **specification and template
> only**. It does **not** generate an actual project `KERNEL.md`. A real Kernel is generated
> later, when AKRS is applied to a concrete project.

---

## 1. What the Kernel is

`akrs/KERNEL.md` is the single warm file every session and every tool boots into (via
`AGENTS.md`). It replaces the doctrine chain with **~one page** of operating rules. It is
**generated per target project** because it embeds that project's Router / STATE /
Source-of-Truth paths and prompt→Mode hints.

**Generation is a one-time, strong-model step.** Distillation runs once, with a powerful
thinking model. Warn the developer: this is the moment the doctrine is compiled; do it well,
because the heavy sources are then removed from the target's footprint.

---

## 2. Prompt-engineering rules for the Kernel

- **Token-dense.** Tables and imperative bullets. Zero motivational prose, zero repetition.
- **Single owner.** Each rule appears exactly once — the single-owner principle applies to
  the Kernel itself.
- **Deterministic ordering.** Stable section order so any model loads it the same way.
- **Machine-actionable, not human-inspirational.** Optimized for an LLM to load and obey,
  not for a person to be motivated by.

---

## 3. Required Kernel sections

The whole Kernel, minified, contains exactly these:

1. **Roles** — Leader plans/owns architecture; Worker executes only the active Road. (2 lines)
2. **Runtime priority** — `Road → Memory → Router → Repository`.
3. **Modes 0–4** — compact table, each row with a prompt→Mode hint (closes the
   "no prompt→Mode algorithm" gap). Fast path (0/1) explicitly wired.
4. **The one route** — `Prompt → Mode → Router → Memory → Road → Execute`.
5. **Blind-assumption check** (one line) + scope-expansion loop
   (`Router → Memory → back to Road`, never guess).
6. **File shapes** — Router / Memory / Road / Task: one line each of *must contain* /
   *never contain*.
7. **Validation checklist** — compressed (one owner per concept; every Task has one Road;
   Memory = index; Router = routes; every Road has a `Status`).
8. **Interaction rules** — one paragraph: options recommended-first, one decision at a time,
   end every turn with a guided next step, confirm Source of Truth first.
9. **Close-out rule** — on landing work: update `STATE.md`; mark the Road
   `DONE + superseded by <memory>` or refresh it.
10. **Applicability** — one line: AKRS Lite vs Full; when to skip.
11. **Pointers** — locations of Router, `STATE.md`, Source-of-Truth (project-specific).

---

## 4. Kernel template

The framework emits this template, filled with project-specific values at generation time.
`<…>` are substitution points.

```markdown
# KERNEL — <project name>
> Read this fully, then obey. Do not scan the repo. Do not read framework doctrine (absent).

## Roles
- Leader: plans, owns architecture, generates Roads, owns close-out.
- Worker: executes ONLY the active Road. Never redesigns. Never leaves scope.

## Runtime priority
Road → Memory → Router → Repository   (repo only if the active Road says so)

## Modes (pick from the prompt)
| Mode | When (prompt hint) | Path |
|------|--------------------|------|
| 0 | "I know the file/area" / dev names sources | Memory + named files only |
| 1 | small, isolated change | single Road or file; skip full chain |
| 2 | continue existing task | full route, no new planning |
| 3 | new work / "add/build/plan X" | generate 1 Task + 1 Road on demand |
| 4 | cross-cutting / structural | Leader only |
Fast path = 0/1: skip Router→Memory→Road for trivial work.

## The one route
Prompt → Mode → Router → Memory → Road → Execute

## Before executing (once)
"Can I finish with ONLY the active Road?"  YES → execute.
NO → Router → required Memory → back to Road → continue. Never guess.

## File shapes (must / never)
- Router: routes+refs / no explanations.
- Memory: index+refs+ownership / no implementation.
- Road: read-order+expected-files+scope+Status / no docs.
- Task: objective+constraints+refs+output / no duplicated knowledge.

## Validation
One owner per concept · every Task has one Road · Memory = index · Router = routes ·
every Road has a Status.

## Interaction
Offer 2–4 options, recommended first. One decision per turn. Confirm Source of Truth first.
End every turn with a guided next step.

## Close-out (when work lands)
Update STATE.md → then retire the Road (DONE + superseded by <memory>) OR refresh its
Expected files to match reality. Keep Road and Memory in agreement.

## Applicability
Lite = Kernel+Router+Roads. Full = +Plans/Phases/Memory for high-blast-radius work.
Tiny/throwaway = skip.

## Pointers
- Router:          <path/to/router>
- STATE:           akrs/STATE.md
- Source of Truth: <path(s) confirmed by developer>
```

---

## 5. Acceptance test

The Kernel is correct only if: **a Worker, given only `AGENTS.md → KERNEL.md → the active
Road`, can execute correctly without reading any doctrine and without scanning the repo.**

This is the guardrail against over-trimming — if a Worker would need doctrine the Kernel
omitted, the Kernel failed and must be regenerated, not patched ad hoc.

---

## 6. Lifecycle

- **Generated** at the end of workflow generation (`02-Generation-Specification.md §7`), once,
  with a strong model.
- **Booted** by every session via `AGENTS.md` (`06-Runtime-Boot-Protocol.md`).
- **Never versioned, never stored in the framework repo, never reused across projects.** It
  is always regenerated from the latest framework, the target's architecture, and the current
  model's capabilities — so future models always produce a better Kernel than past ones.
