# AKRS Generation Specification (v2)

### How a Leader generates an AKRS workflow

This document complements the Constitution. If the Constitution defines **what AKRS is**,
this defines **how AKRS is created**. The Constitution always has higher authority; if this
appears to contradict it, the Constitution wins.

**Objective:** deterministic generation. Two competent Leaders given the same project and
the same Source of Truth must produce **substantially equivalent** workflows. Naming and
wording may differ; ownership, routing, planning structure, and execution architecture may
not.

**Content from the agent, form from the CLI.** The Leader decides *what* a Road, contract or
Memory record says; the CLI (`akrs`) owns its form, validates it, hashes it and writes it in a
transaction. Machine artifacts (Roads, State, executors, contracts, ledgers) are **never typed by
hand into `akrs/`**; the Leader writes a *draft* (`akrs template <kind> --to-draft <name>`) and
runs the writer command (`akrs-road-author` skill). The CLI never invents a value.

---

## 1. Source of Truth (mandatory first action)

Before any analysis, the Leader identifies every available knowledge source — customer
requirements, product/architecture docs, existing workflow, repository, developer
explanations, existing project docs. The Leader must never assume the repository alone is
the complete project, and never assume which sources are authoritative.

**Source-of-Truth confirmation is the first structured question of every workflow.** The
Leader presents every candidate source it found; the Developer confirms which are
authoritative and which files are canonical. Until confirmed, analysis must not begin.

> A confirmed Source of Truth is a fact. An unconfirmed one is an assumption. Assumptions
> never start a workflow.

**If the confirmed SoT is large (> ~2 pages) or the project pre-exists**, build
`akrs/SOT-INDEX.md` **before** analysis, and read the SoT only through it thereafter — never
whole (`09-Scale-And-Source-Index-Specification.md §2, §4`).

(Interaction mechanics for this question: `04-Developer-Interaction-Protocol.md`.)

### Knowledge priority (conflict resolution)

```
Customer requirements  (highest)
  ↓ Developer clarification
  ↓ Architecture documentation
  ↓ Existing workflow
  ↓ Repository
  ↓ Generated assumptions  (lowest)
```

Assumptions never override authoritative knowledge.

---

## 2. The two phases (never merged)

- **Phase A — Initial Generation:** builds the stable skeleton **once**.
- **Phase B — On-Demand Generation:** builds a single Task and its Road **only when that
  work is requested** (Mode 3).

Pre-generated Tasks/Roads become stale the moment requirements change. On-demand generation
is what keeps the workflow able to absorb change — so it is the **default**. The one
sanctioned batch exception (§4) generates a whole plan's Roads at once but leaves all but the
first `QUEUED` and re-validates each against reality before activation, which is exactly what
keeps batching safe.

---

## 3. Phase A — Initial Generation (skeleton only)

```
Collect Sources
  ↓
Confirm Source of Truth          (mandatory — §1)
  ↓
Confirm acceptance + harness     (structured Phase-A question — 10 §8; never parked)
  ↓
Classify the executors           (ask the user: weak / medium / frontier — akrs-classify-executors)
  ↓
Generate SoT Index               (MANDATORY checklist step — generate, or record a justified
                                  omission; never silently skipped — §3.1, 09)
  ↓
Analyze Project                  (progressively, one domain at a time — 09 §4)
  ↓
Identify Business Capabilities → Plans
  ↓
Identify Deliverables          → Phases
  ↓
Extract Shared Knowledge       → Memory     (akrs memory add — records, not prose files)
  ↓
Generate Router                (Markdown, routes only)
  ↓
Create the workflow            (akrs init --scaffold [--plan <id>] — one transaction:
                                State, first Road + Task, verification contract)
  ↓
Validate Skeleton              (akrs validate)
  ↓
Skeleton Complete
```

Phase A **never** generates further Tasks or Roads: the single Road/Task pair `init --scaffold`
writes is a *starter* the Leader replaces in Phase B. The order is fixed.

**Install first.** `npx akrs-framework init` copies the doctrine into `docs/akrs/`; the Leader
reads it from there. Command examples in this document are written `akrs <command>`; run them as
`npx akrs-framework <command>` unless the package is installed.

**Classify the executors.** Before the first Road is written, the Leader asks the user which
models will execute the work as Worker and as Tester and how strong each is, and records the
answers (`akrs executor set`, `akrs-classify-executors` skill). The CLI never infers a class.
`akrs boot` and `akrs validate` (`AKRS-S006`) remind the Leader until it is done.

**Confirm acceptance + harness** is a mandatory Phase-A structured question: every SoT section
must carry ≥ 1 measurable acceptance line, and the verification harness (minimum: a committed
assert-script convention, and for runtime-observable work a Plan verification contract) is
decided now — never parked to the last plan (`10-Verification-Specification.md §2, §8–9`).

The State is initialized by `init --scaffold` (or `akrs state set`), so the very first session has
a resume point; `akrs state render` writes the human-readable `STATE.md`
(`07-State-And-Sync-Specification.md`).

**CI.** The workflow validates itself: run `akrs validate` (zero-dependency, one packet with
`--json`) in CI and, optionally, a pre-commit hook. There is no project `package.json` to generate
and no auto-fix flag: a finding is repaired by the writer command it names.

### 3.1 The SoT Index is a mandatory Phase-A checklist item

Generating the **Source-of-Truth Index** is a **verifiable Phase-A step, not optional prose a
weaker Leader can silently skip.** Before analysis begins, the Leader takes **exactly one** of
two *recorded* actions:

1. **Generate `akrs/SOT-INDEX.md`.** This is **required** whenever the confirmed SoT exceeds
   ~2 pages **or** the project pre-exists (`09-Scale-And-Source-Index-Specification.md §2, §6`).
   Once it exists, Router / Memory / Roads cite index entries and never say "read `<file>`".
2. **Record an explicit justification for omitting it** — legal **only** for a genuinely small,
   single-source, single-page SoT. Write it as a full line in `CORE.md`:

   ```
   SOT-INDEX: none — <one-line reason, e.g. "single 1-page spec, read whole per 09 §6">
   ```

A bare `SOT-INDEX none` with **no reason**, an omission on a **large or pre-existing** SoT, or a
Road that instructs the Worker to "skip / don't read the SoT" **in place of** indexing it, is a
**generation failure** (§9) — regenerate before proceeding. The choice, and its justification
when omitted, is auditable in `CORE.md`; "I forgot" is not a legal Phase-A outcome.

---

## 4. Phase B — On-Demand Generation (per request, Mode 3)

```
Receive Request
  ↓
Select the owning Plan and Phase
  ↓
Identify the single Executable Objective
  ↓
Draft the Road for the executor's class     (akrs template road --class <class> --to-draft <name>)
  ↓
Create the Road and its Task                (akrs road new / road update, akrs task new)
  ↓
Check fit and readiness                     (akrs road fit, akrs road check)
  ↓
Activate it                                 (akrs road activate --if-snapshot ...)
  ↓
Update State                                (akrs state set / state render)
  ↓
Hand to Worker                              (the Worker runs akrs work)
```

Exactly one Road per Task. The Leader chooses the Road; Workers never choose a Road. Only the
requested work is generated — on-demand is the default. A Road is written **for its executor's
class** (`executor_class`): the class caps writes, directories and read budget and decides whether
`steps` are required (`akrs-classify-executors`); `akrs road fit` reports `fits`,
`split_required` or `reads_over_budget` before a Worker meets the Road.

### Sanctioned exception — Phase B-batch

The Leader **MAY** generate all Task+Road pairs for **ONE plan** in a single pass, to
amortize the expensive Leader session. When it does:

- At most the first Road is activated; **every Road beyond the first stays `QUEUED`**.
- **Activation of each `QUEUED` Road requires the staleness re-validation** of
  `07-State-And-Sync-Specification.md §3`: before a `QUEUED` Road becomes `ACTIVE`, the Leader
  re-checks it against Memory + the SoT and refreshes it (`road update`) if reality has moved.

This legalizes what best practice already does (batching a plan's Roads while the Leader has
the whole plan in context); the staleness check is exactly what makes it safe. Batching is
still **per-plan** — never generate Roads for work that has not been scoped into a plan.

---

## 5. Discovery rules

**Plans** represent business capabilities, answering *"What capability does this provide?"*
A Plan must never exist merely because files share a folder — folder structure is not
architecture; business capabilities are.

**Phases** organize related work inside one Plan and represent milestones, not
implementation order unless explicitly required.

**Tasks** are executable objectives small enough that a Worker can complete one without
redesigning architecture. They reference knowledge, never duplicate it, and are created
only when requested.

> **Granularity is a Leader decision made at request time.** If the requested work fits one
> reliable Worker session of the executor's class, generate **ONE Task + ONE Road** — even if
> that covers an entire small plan. Split into multiple pairs **only** when the work exceeds one
> session's reliable scope. Never split for symmetry or folder structure.

> **Separation of concerns (kills Task/Road duplication).** A **Task** (`tasks/<id>.md`,
> scaffolded by `akrs task new`) holds only narrative: objective, constraints, approach, notes, and
> a pointer to its Road. Everything executable — reads, writes, forbidden, checks, acceptance,
> boundaries, ordered `steps`, `deps`, `status`, and the executor class — lives **only** in the
> **Road** (`roads/<id>.json`). Whether and how the Plan is verified lives only in the **Plan's
> verification contract** (`policy` none | checks | live | measured;
> `10-Verification-Specification.md §2`). A fact restated in both a Task and its Road is a
> validation failure.

**Memory** exists only for **reusable** knowledge — knowledge multiple Tasks may need.
Single-use knowledge stays inside its Task or Road. Memory is an index, never a wiki. It is
written with `akrs memory add --input <draft>`: one record per fact, carrying a topic, one
epistemic label (§6) and evidence pointers; the CLI renders the Markdown. Every fact a Memory
records carries one epistemic label.

**Router** answers only *"Where should execution continue?"* It points; it never explains
implementation, architecture, business logic, or design decisions.

**Roads** are execution contracts: required knowledge as read windows, execution boundaries,
expected change scope (`writes`), an optional `deps` list (Road IDs that must be `DONE` before
this Road may activate), and a `status`. (Road shape, `deps` gating and close-out:
`07-State-And-Sync-Specification.md`.)

---

## 6. Ownership, assumptions, and unknowns

- **Ownership:** every concept has exactly one owner; every owner has exactly one
  responsibility. If knowledge exists, reference it — never duplicate it.
- **Allowed assumptions:** permitted only when sufficient evidence exists and no
  authoritative source contradicts them. Assumptions never replace known facts; architecture
  is never invented; the Source of Truth is never an assumption.
- **Unknown knowledge:** if information cannot be determined, mark it **Unknown** — never
  fabricate. Unknowns stay unresolved until clarified and must never become documented facts.
- **Developer clarification:** if an Unknown blocks reliable generation, stop and ask. The
  Developer becomes the authoritative source for that decision. Always prefer asking over
  guessing.
- **Confidence:** internally track confidence (High / Medium / Low / Unknown). Low triggers
  additional verification; Unknown triggers Developer clarification.
- **Epistemic labels (standardized).** Every fact a Memory records carries exactly one label:
  `Decided (by <plan/road>)` · `Assumption (High/Med/Low)` · `Unknown`. Unknowns never silently
  harden into facts; the label is the record of how a fact is known.
- **Assumption aging.** An `Assumption` consumed by **≥ 3 landed Roads** must be escalated:
  confirmed by the Developer, or explicitly promoted to `Decided`-by-default with the
  promotion recorded in the owning Memory. Assumptions must not harden silently by attrition.
- **Mid-project SoT change.** When the confirmed Source of Truth changes after generation has
  begun, do not edit in place and hope — run the **requirements-delta procedure**, whose sole
  owner is `11-Change-Management-Specification.md §5` (diff the SoT → list affected
  Plans/Memories/QUEUED Roads → re-validate or regenerate → record the delta with `state set` and
  `log append`).

---

## 7. Kernel generation (end of generation)

After the workflow exists and validates, the Leader compiles the project's **kernel folder**
(`akrs/kernel/` — `CORE.md` + one file per role) from `08-Kernel-Specification.md`, embedding
this project's Router / State / Source-of-Truth paths and prompt→Mode hints. This is a
**one-time, strong-model** step. `akrs boot` reads `kernel/CORE.md` and `kernel/leader.md`.

```
Workflow validated
  ↓
Generate akrs/kernel/         (CORE.md + worker/leader/tester/changer.md — 08 templates)
  ↓
Wire the agents               (akrs agents setup — instruction pointer, skill pointers, MCP, guard hook — 05)
  ↓
Project ready to execute
```

**Skills.** The procedure bodies the kernel points to ship in `docs/framework/skills/` (copied to
`docs/akrs/framework/skills/` by `init`). They need no fill-in slots: project specifics (launch
command, URL, budgets, evidence types) live in the Plan's verification contract. A project may
keep its own copy at `akrs/skills/<name>.md`, which then wins. The kernel and specs point to
these bodies; the procedure never exists twice (`08-Kernel-Specification.md`,
`05-Platform-Adapter-Specification.md`).

> Generating an actual kernel folder is part of applying the framework to a real project. It
> is **not** part of building this framework. The framework provides the specification and
> templates only.

---

## 8. Workflow output contract

A generated workflow must contain: routing, memory, plans, phases, tasks, roads, **state**,
**executors**, the **kernel folder**, the agent wiring (`akrs agents setup`), a verification
contract per tested Plan, and a green `akrs validate`. Concrete filenames may differ;
responsibilities may not.

**Maximize:** execution predictability, routing precision, ownership uniqueness, navigation
consistency, reusable knowledge.
**Minimize:** duplicated knowledge, unnecessary files, unnecessary routing, execution
ambiguity, blind assumptions.

---

## 9. Validation and failure

**Complete only if every answer is YES:** every concept has one owner; every Task belongs to
one Phase; every Phase belongs to one Plan; every Task has one Road; every Road has clear
boundaries and a `status`; every Memory holds reusable knowledge only; every Router holds
routing only; no duplicated knowledge; no unresolved Unknowns; every assumption justified;
the executors are classified; `akrs validate` is green and `STATE.md` equals its render;
**the SoT Index exists, or its omission is explicitly justified for a small single-page SoT
(§3.1).**

**Generation has failed if:** the Leader invents architecture; assumptions replace facts;
duplicate ownership appears; routing becomes ambiguous; multiple Roads exist for one Task;
Memory or Router becomes documentation; an unresolved Unknown is silently ignored; a canonical
`akrs/` machine file is hand-edited; **a large or pre-existing SoT ships without a
`SOT-INDEX.md`, or the index is silently omitted (a bare `none` with no justification — §3.1).**
On failure, generation stops until corrected.

---

## 10. Final principle

When uncertainty exists, the Leader prefers: **evidence over assumptions; references over
duplication; questions over guessing; execution over documentation; deterministic
architecture over creative interpretation.**
